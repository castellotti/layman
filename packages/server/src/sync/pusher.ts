import { gzipSync } from 'zlib';
import type { Database } from '../db/database.js';
import type { LaymanConfig } from '../config/schema.js';
import { SyncJournal, type LogEntry } from './journal.js';
import { SyncState } from './state.js';
import { SYNC_ENTITIES, SYNC_ENTITIES_ORDERED, type SyncEntity } from './entities.js';
import {
  SYNC_PROTOCOL_VERSION,
  type HelloRequest,
  type HelloResponse,
  type PushBatch,
  type PushEntry,
  type PushResponse,
  type PresencePayload,
  type SyncKind,
  type SyncStatus,
  type WireRow,
} from './protocol.js';

const BATCH_MAX_ENTRIES = 500;
const BATCH_MAX_BYTES = 1.5 * 1024 * 1024;
const LOG_READ_LIMIT = 2000;
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

/** Codes that mean "stop and tell the user" rather than retry. */
export type PusherErrorCode = 'revoked' | 'host_mismatch' | 'protocol' | 'http' | 'network';

export class PusherError extends Error {
  constructor(public code: PusherErrorCode, message: string) {
    super(message);
    this.name = 'PusherError';
  }
}

export function isFatalPause(code: PusherErrorCode): boolean {
  return code === 'revoked' || code === 'host_mismatch' || code === 'protocol';
}

/** Transport to central. Injected so the pusher is testable without a network. */
export interface SyncClient {
  hello(req: HelloRequest): Promise<HelloResponse>;
  push(batch: PushBatch): Promise<PushResponse>;
}

/** Maps an HTTP status from a sync route to a pusher error code. */
export function codeForStatus(status: number): PusherErrorCode {
  if (status === 401) return 'revoked';
  if (status === 409) return 'host_mismatch';
  if (status === 426) return 'protocol';
  return 'http';
}

/** Real HTTP client: gzips push bodies, carries the bearer token. */
export function createHttpSyncClient(
  getConfig: () => LaymanConfig,
  laymanVersion?: string,
): SyncClient {
  const base = () => getConfig().sync.centralUrl.replace(/\/$/, '');
  const auth = () => ({ Authorization: `Bearer ${getConfig().sync.token}` });

  async function call(path: string, body: unknown, gzip: boolean): Promise<unknown> {
    const json = JSON.stringify(body);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...auth() };
    let payload: string | Buffer = json;
    if (gzip) {
      payload = gzipSync(Buffer.from(json));
      headers['Content-Encoding'] = 'gzip';
    }
    let res: Response;
    try {
      res = await fetch(base() + path, { method: 'POST', headers, body: payload as BodyInit });
    } catch (err) {
      throw new PusherError('network', String(err));
    }
    if (!res.ok) {
      throw new PusherError(codeForStatus(res.status), `${path} → ${res.status}`);
    }
    return res.json();
  }

  return {
    async hello(req) {
      return (await call('/api/sync/hello', req, false)) as HelloResponse;
    },
    async push(batch) {
      return (await call('/api/sync/push', batch, true)) as PushResponse;
    },
  };
}

interface BackfillCursor {
  kind: SyncKind;
  lastId: string;
}

/**
 * Pushes this remote's own-origin data to central (docs/planning/multi-host-sync.md
 * §3.7): a one-time backfill (page every kind, own rows only) followed by
 * incremental replay of the journal. Cursors live in `sync_state`, so an
 * interrupted backfill resumes at the next page and a failed incremental batch
 * simply re-sends. Every apply on central is an idempotent upsert, so re-sending
 * is harmless.
 */
export class SyncPusher {
  private journal: SyncJournal;
  private state: SyncState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private draining = false;
  private backoffMs = BACKOFF_MIN_MS;
  private paused = false;
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;
  private runState: SyncStatus['state'] = 'idle';
  private backfillKind: SyncKind | null = null;

  constructor(
    private db: Database,
    private client: SyncClient,
    private getConfig: () => LaymanConfig,
    private opts: { laymanVersion?: string; getPresence?: () => PresencePayload; onStatus?: () => void } = {},
  ) {
    this.journal = new SyncJournal(db);
    this.state = new SyncState(db);
  }

  // ── cursor helpers ──────────────────────────────────────────────────────────
  private getNum(key: Parameters<SyncState['get']>[0]): number | null {
    const v = this.state.get(key);
    return v === null ? null : Number(v);
  }

  private helloRequest(): HelloRequest {
    const { sync } = this.getConfig();
    return {
      hostId: sync.hostId,
      hostName: sync.hostName,
      platform: process.platform,
      laymanVersion: this.opts.laymanVersion,
      protocolVersion: SYNC_PROTOCOL_VERSION,
    };
  }

  /** Establish the session; returns central's view so the caller can reconcile. */
  async hello(): Promise<HelloResponse> {
    return this.client.hello(this.helloRequest());
  }

  status(): SyncStatus {
    const { sync } = this.getConfig();
    const acked = this.getNum('push_acked_seq');
    const head = this.journal.headSeq();
    const backlog = acked === null ? head : Math.max(0, head - acked);
    return {
      role: sync.role,
      hostId: sync.hostId,
      hostName: sync.hostName,
      state: this.paused ? 'paused' : this.runState,
      backlog,
      pushAckedSeq: acked,
      backfillKind: this.backfillKind,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  // ── batch assembly ──────────────────────────────────────────────────────────
  private buildUpsertEntry(entity: SyncEntity, id: string): PushEntry | null {
    const row = entity.load(this.db, [id])[0] as WireRow | undefined;
    if (!row) return null; // deleted after journaling — skip (§3.7)
    return { op: 'upsert', kind: entity.kind, id, row };
  }

  /**
   * One drain pass: hello, then backfill (if not yet acked) then incremental.
   * Returns the number of entries pushed. Throws PusherError; the caller decides
   * whether to back off or pause.
   */
  async drain(): Promise<number> {
    this.runState = 'syncing';
    await this.hello();
    let pushed = 0;
    if (this.getNum('push_acked_seq') === null) {
      pushed += await this.runBackfill();
    }
    pushed += await this.runIncremental();
    this.runState = 'idle';
    this.backfillKind = null;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
    return pushed;
  }

  private async runBackfill(): Promise<number> {
    this.runState = 'backfill';
    let head = this.getNum('push_backfill_head');
    if (head === null) {
      head = this.journal.headSeq();
      this.state.set('push_backfill_head', String(head));
    }
    let cursor: BackfillCursor | null = this.readCursor();
    const hostId = this.getConfig().sync.hostId;
    let pushed = 0;

    while (cursor) {
      const entity = SYNC_ENTITIES[cursor.kind];
      this.backfillKind = cursor.kind;
      const rows = entity.page(this.db, { afterId: cursor.lastId, limit: BATCH_MAX_ENTRIES, originHostId: hostId });
      if (rows.length === 0) {
        cursor = this.nextKindCursor(cursor.kind);
        this.writeCursor(cursor);
        continue;
      }
      // Fit within the byte budget; a short send just advances the cursor less.
      const { entries, lastId } = fitRows(entity, rows);
      await this.client.push({ hostId, entries, live: this.presence() });
      pushed += entries.length;
      cursor = { kind: cursor.kind, lastId };
      this.writeCursor(cursor);
    }

    // Backfill complete: everything journaled since replays incrementally.
    this.state.set('push_acked_seq', String(head));
    this.state.delete('push_backfill_head');
    this.state.delete('push_backfill_cursor');
    return pushed;
  }

  private async runIncremental(): Promise<number> {
    this.runState = 'syncing';
    const hostId = this.getConfig().sync.hostId;
    let pushed = 0;

    for (;;) {
      const acked = this.getNum('push_acked_seq') ?? 0;
      const log = this.journal.readSince(hostId, acked, LOG_READ_LIMIT);
      if (log.length === 0) break;

      const { entries, upToSeq, consumedAll } = this.assembleIncremental(log);
      if (entries.length === 0 && upToSeq !== null) {
        // Only skipped entries (rows deleted after journaling) — still advance.
        this.state.set('push_acked_seq', String(upToSeq));
        if (consumedAll) break;
        continue;
      }
      const res = await this.client.push({ hostId, entries, upToSeq: upToSeq ?? undefined, live: this.presence() });
      if (res.ackSeq !== null) this.state.set('push_acked_seq', String(res.ackSeq));
      pushed += entries.length;
      if (consumedAll) break;
    }
    return pushed;
  }

  /** Turn an ordered log slice into a deduped, budget-bounded batch. */
  private assembleIncremental(log: LogEntry[]): { entries: PushEntry[]; upToSeq: number | null; consumedAll: boolean } {
    const byEntity = new Map<string, PushEntry>();
    let bytes = 0;
    let upToSeq: number | null = null;
    let consumed = 0;

    for (const e of log) {
      const key = `${e.kind}:${e.entityId}`;
      let entry: PushEntry | null;
      if (e.op === 'delete') {
        entry = { op: 'delete', kind: e.kind, id: e.entityId };
      } else {
        entry = this.buildUpsertEntry(SYNC_ENTITIES[e.kind], e.entityId);
      }

      const addBytes = entry ? SYNC_ENTITIES[e.kind].approxBytes((entry as { row?: WireRow }).row ?? {}) + 64 : 0;
      const isNew = !byEntity.has(key);
      if (isNew && byEntity.size >= BATCH_MAX_ENTRIES) break;
      if (isNew && bytes + addBytes > BATCH_MAX_BYTES && byEntity.size > 0) break;

      if (entry) {
        if (!byEntity.has(key)) bytes += addBytes;
        byEntity.set(key, entry);
      }
      upToSeq = e.seq;
      consumed++;
    }

    return { entries: [...byEntity.values()], upToSeq, consumedAll: consumed === log.length };
  }

  private presence(): PresencePayload | undefined {
    return this.opts.getPresence?.();
  }

  // ── cursor persistence ────────────────────────────────────────────────────
  private readCursor(): BackfillCursor {
    const raw = this.state.get('push_backfill_cursor');
    if (raw) return JSON.parse(raw) as BackfillCursor;
    const first: BackfillCursor = { kind: SYNC_ENTITIES_ORDERED[0].kind, lastId: '' };
    this.writeCursor(first);
    return first;
  }

  private writeCursor(cursor: BackfillCursor | null): void {
    if (cursor) this.state.set('push_backfill_cursor', JSON.stringify(cursor));
  }

  private nextKindCursor(kind: SyncKind): BackfillCursor | null {
    const idx = SYNC_ENTITIES_ORDERED.findIndex((e) => e.kind === kind);
    const next = SYNC_ENTITIES_ORDERED[idx + 1];
    return next ? { kind: next.kind, lastId: '' } : null;
  }

  // ── scheduling ──────────────────────────────────────────────────────────────
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.backoffMs = BACKOFF_MIN_MS;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Wake the loop now (Settings → Sync now). */
  kick(): void {
    if (!this.running || this.paused) return;
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.paused || this.draining) return;
    this.draining = true;
    try {
      await this.drain();
      this.backoffMs = BACKOFF_MIN_MS;
      this.opts.onStatus?.();
      const intervalMs = Math.max(2, this.getConfig().sync.intervalSeconds) * 1000;
      this.schedule(this.status().backlog > 0 ? 1000 : intervalMs);
    } catch (err) {
      const code = err instanceof PusherError ? err.code : 'network';
      this.lastError = err instanceof Error ? err.message : String(err);
      if (isFatalPause(code)) {
        this.paused = true;
        this.runState = 'error';
      } else {
        this.runState = 'backoff';
        const jitter = Math.random() * 0.3 + 0.85;
        this.schedule(Math.floor(this.backoffMs * jitter));
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
      }
      this.opts.onStatus?.();
    } finally {
      this.draining = false;
    }
  }
}

/** Pack ordered rows into upsert entries within the byte budget; returns the last id packed. */
function fitRows(entity: SyncEntity, rows: WireRow[]): { entries: PushEntry[]; lastId: string } {
  const entries: PushEntry[] = [];
  let bytes = 0;
  let lastId = '';
  for (const row of rows) {
    const size = entity.approxBytes(row) + 64;
    if (entries.length > 0 && bytes + size > BATCH_MAX_BYTES) break;
    entries.push({ op: 'upsert', kind: entity.kind, id: String(row[entity.idColumn]), row });
    bytes += size;
    lastId = String(row[entity.idColumn]);
  }
  return { entries, lastId };
}

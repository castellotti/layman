import type { Database } from '../db/database.js';
import type { LaymanConfig } from '../config/schema.js';
import { SyncState } from './state.js';
import { SyncApplier } from './applier.js';
import { upsertRemoteHost, recomputeHostStats } from './stats.js';
import { detectContainer } from './identity.js';
import { SYNC_ENTITIES_ORDERED } from './entities.js';
import { PusherError, isFatalPause, type PullClient } from './pusher.js';
import { SYNC_PROTOCOL_VERSION, type HostStats, type SyncKind, type PullStatus, type PullRunState } from './protocol.js';

const PAGE_LIMIT = 500;
const CHANGES_LIMIT = 1000;
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Pace between snapshot pages so the bulk import does not sustain back-to-back
 * write transactions. On a container's FUSE-backed bind-mounted DB (DELETE
 * journal), hundreds of rapid journal create/delete cycles can corrupt the btree
 * (see `db/database.ts`); a short breather between pages lets the mount settle.
 * Overridable via `LAYMAN_SYNC_SNAPSHOT_PACING_MS` for tuning.
 */
const SNAPSHOT_PACING_MS = (() => {
  const raw = Number(process.env.LAYMAN_SYNC_SNAPSHOT_PACING_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 40;
})();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Pulls every *other* host's data from central onto a mirror
 * (docs/planning/multi-host-sync.md §3.10): a one-time snapshot (paging each kind,
 * rows central owns on behalf of anyone but this host) followed by incremental
 * `changes`. Cursors live in `sync_state`, so an interrupted snapshot resumes and
 * a failed changes call simply re-requests. Everything is applied through the
 * same `SyncApplier` with `trustRowOrigin` so each mirrored row keeps its true
 * origin. If central has compacted past the mirror's cursor it answers `resync`
 * and the mirror restarts the snapshot — idempotent, only bandwidth.
 */
export class SyncPuller {
  private state: SyncState;
  private applier: SyncApplier;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private draining = false;
  private paused = false;
  private backoffMs = BACKOFF_MIN_MS;
  private runState: PullRunState = 'idle';
  private snapshotKind: SyncKind | null = null;
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;

  constructor(
    private db: Database,
    private client: PullClient,
    private getConfig: () => LaymanConfig,
    private opts: { onStatus?: () => void; laymanVersion?: string; log?: (msg: string) => void } = {},
  ) {
    this.state = new SyncState(db);
    this.applier = new SyncApplier(db);
  }

  private getNum(key: Parameters<SyncState['get']>[0]): number | null {
    const v = this.state.get(key);
    return v === null ? null : Number(v);
  }

  status(): PullStatus {
    return {
      enabled: this.getConfig().sync.mirror,
      state: this.paused ? 'paused' : this.runState,
      pullAckedSeq: this.getNum('pull_acked_seq'),
      snapshotKind: this.snapshotKind,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  /** One pull pass: hello (for headSeq), snapshot if needed, then incremental. */
  async drain(): Promise<number> {
    const hello = await this.client.hello({
      hostId: this.getConfig().sync.hostId,
      hostName: this.getConfig().sync.hostName,
      platform: process.platform,
      laymanVersion: this.opts.laymanVersion,
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });

    let applied = 0;
    const needSnapshot = this.getNum('pull_acked_seq') === null || this.state.get('pull_snapshot_cursor') !== null;
    if (needSnapshot) applied += await this.runSnapshot(hello.headSeq);
    applied += await this.runIncremental();

    this.runState = 'idle';
    this.snapshotKind = null;
    this.lastSuccessAt = Date.now();
    this.lastError = null;
    return applied;
  }

  private applyHosts(hosts: HostStats[]): void {
    const local = this.getConfig().sync.hostId;
    for (const h of hosts) {
      if (h.hostId === local) continue; // never downgrade our own local row
      upsertRemoteHost(this.db, { hostId: h.hostId, name: h.name, platform: h.platform, laymanVersion: h.laymanVersion });
    }
  }

  private async runSnapshot(headSeq: number): Promise<number> {
    this.runState = 'snapshot';
    if (this.state.get('pull_snapshot_head') === null) {
      this.state.set('pull_snapshot_head', String(headSeq));
      // Bulk import onto a FUSE-backed bind-mounted DB is the one path that
      // stresses the mount enough to matter (see db/database.ts). Warn once so a
      // corruption is diagnosable; the pacing + deferred stats below mitigate it.
      if (detectContainer()) {
        this.opts.log?.('sync: starting mirror snapshot; bulk import over a bind-mounted DB is paced to reduce (not eliminate) corruption risk — see docs/planning/multihost-sync-durability-followup.md');
      }
    }
    let cursor: { kind: SyncKind; lastId: string } | null = this.readCursor();
    let applied = 0;

    while (cursor) {
      this.snapshotKind = cursor.kind;
      const page = await this.client.snapshot(cursor.kind, cursor.lastId, PAGE_LIMIT);
      this.applyHosts(page.hosts);
      if (page.entries.length > 0) {
        // deferStats: skip the per-page COUNT/SUM over recorded_events — hundreds
        // of heavy scans interleaved with the writes is the real FUSE hazard.
        const res = this.applier.apply(this.getConfig().sync.hostId, page.entries, { trustRowOrigin: true, piiFilter: this.getConfig().piiFilter, deferStats: true });
        applied += res.applied;
      }
      if (page.nextCursor === null) {
        cursor = this.nextKindCursor(cursor.kind);
      } else {
        cursor = { kind: cursor.kind, lastId: page.nextCursor };
      }
      this.writeCursor(cursor);
      if (SNAPSHOT_PACING_MS > 0) await sleep(SNAPSHOT_PACING_MS);
    }

    // Counters were deferred during the bulk apply; rebuild them once now.
    recomputeHostStats(this.db);

    const head = this.getNum('pull_snapshot_head') ?? headSeq;
    this.state.set('pull_acked_seq', String(head));
    this.state.delete('pull_snapshot_head');
    this.state.delete('pull_snapshot_cursor');
    return applied;
  }

  private async runIncremental(): Promise<number> {
    this.runState = 'incremental';
    let applied = 0;
    for (;;) {
      const since = this.getNum('pull_acked_seq') ?? 0;
      const res = await this.client.changes(since, CHANGES_LIMIT);
      this.applyHosts(res.hosts);
      if (res.resync) {
        // Central compacted past us — restart the snapshot from scratch.
        this.state.delete('pull_acked_seq');
        this.state.delete('pull_snapshot_head');
        this.state.delete('pull_snapshot_cursor');
        applied += await this.runSnapshot(res.headSeq);
        continue;
      }
      if (res.entries.length > 0) {
        const r = this.applier.apply(this.getConfig().sync.hostId, res.entries, { trustRowOrigin: true, piiFilter: this.getConfig().piiFilter });
        applied += r.applied;
      }
      // headSeq advances even on an empty response, so a quiet central is "up to date".
      this.state.set('pull_acked_seq', String(res.headSeq));
      // Keep pulling while central still has a full page behind headSeq. Never key
      // this on entries.length: dedup can shrink a full scanned page below the
      // limit, which used to break the loop with a backlog still on central and
      // leave the mirror stalled until the next interval. Fall back to the old
      // heuristic for a central that doesn't send `more`.
      const more = res.more ?? res.entries.length >= CHANGES_LIMIT;
      if (!more) break;
    }
    return applied;
  }

  // ── cursor persistence ────────────────────────────────────────────────────
  private readCursor(): { kind: SyncKind; lastId: string } {
    const raw = this.state.get('pull_snapshot_cursor');
    if (raw) return JSON.parse(raw) as { kind: SyncKind; lastId: string };
    const first = { kind: SYNC_ENTITIES_ORDERED[0].kind, lastId: '' };
    this.writeCursor(first);
    return first;
  }

  private writeCursor(cursor: { kind: SyncKind; lastId: string } | null): void {
    if (cursor) this.state.set('pull_snapshot_cursor', JSON.stringify(cursor));
  }

  private nextKindCursor(kind: SyncKind): { kind: SyncKind; lastId: string } | null {
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
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  kick(): void {
    if (this.running && !this.paused) this.schedule(0);
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.running || this.paused || this.draining) return;
    if (!this.getConfig().sync.mirror) { this.schedule(5000); return; }
    this.draining = true;
    try {
      await this.drain();
      this.backoffMs = BACKOFF_MIN_MS;
      this.opts.onStatus?.();
      this.schedule(Math.max(15, this.getConfig().sync.mirrorIntervalSeconds) * 1000);
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

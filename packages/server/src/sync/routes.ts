import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import compress from '@fastify/compress';
import type { Database } from '../db/database.js';
import type { LaymanConfig } from '../config/schema.js';
import { SyncJournal } from './journal.js';
import { SyncApplier } from './applier.js';
import { PeerStore } from './tokens.js';
import { createHttpSyncClient, type SyncPusher } from './pusher.js';
import type { SyncPuller } from './puller.js';
import type { RemoteSessionRegistry } from './presence.js';
import type { TimelineEvent } from '../events/types.js';
import { SYNC_ENTITIES } from './entities.js';
import { hostsWithStats, recomputeHostStats, upsertRemoteHost, updateHostStats } from './stats.js';
import {
  SYNC_PROTOCOL_VERSION,
  type HelloRequest,
  type HelloResponse,
  type PushBatch,
  type PushResponse,
  type PushEntry,
  type SnapshotPage,
  type ChangesResponse,
  type SyncKind,
  type SyncStatus,
} from './protocol.js';

interface RawPeerRow {
  token_hash: string;
  name: string;
  host_id: string | null;
}

export interface SyncRouteDeps {
  db: Database;
  getConfig: () => LaymanConfig;
  journal: SyncJournal;
  applier: SyncApplier;
  peers: PeerStore;
  /** The running pusher when role === 'remote', else null. Re-read each call. */
  getPusher: () => SyncPusher | null;
  /** Central-side live-session presence, fed from each push's `live` payload. */
  registry: RemoteSessionRegistry;
  /** Broadcast recent remote-origin events to dashboard clients as `event:new`. */
  onLiveEvents: (events: TimelineEvent[]) => void;
  /** The running puller when role === 'remote' && mirror, else null. */
  getPuller?: () => SyncPuller | null;
  laymanVersion?: string;
}

/**
 * All `/api/sync/*` routes (docs/planning/multi-host-sync.md §6), registered as a
 * single encapsulated plugin so `@fastify/compress` request-decompression is
 * scoped to them. Token routes (`hello`, `push`) require a bearer token; the
 * management routes are local-only, same trust model as every other `/api/*`
 * route today.
 */
export async function registerSyncRoutes(fastify: FastifyInstance, deps: SyncRouteDeps): Promise<void> {
  const { db, getConfig, journal, applier, peers, getPusher } = deps;

  // In-memory per-IP failed-auth throttle: 10 failures/minute → 429. Cheap
  // brute-force protection for the one route reachable with a guessable secret.
  const authFailures = new Map<string, { count: number; resetAt: number }>();
  const AUTH_FAIL_LIMIT = 10;
  const AUTH_FAIL_WINDOW_MS = 60_000;
  // Drop expired entries so a network-reachable central being scanned by a churn
  // of distinct IPs can't leak one Map entry per IP forever. Guarded to at most
  // once per window so a flood can't turn each failure into an O(n) sweep.
  let lastAuthSweep = Date.now();
  function sweepAuthFailures(now: number): void {
    if (now - lastAuthSweep < AUTH_FAIL_WINDOW_MS) return;
    lastAuthSweep = now;
    for (const [ip, entry] of authFailures) {
      if (now > entry.resetAt) authFailures.delete(ip);
    }
  }
  function isRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = authFailures.get(ip);
    if (!entry || now > entry.resetAt) return false;
    return entry.count >= AUTH_FAIL_LIMIT;
  }
  function recordAuthFailure(ip: string): void {
    const now = Date.now();
    sweepAuthFailures(now);
    const entry = authFailures.get(ip);
    if (!entry || now > entry.resetAt) {
      authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
    } else {
      entry.count++;
    }
  }

  await fastify.register(async (scope) => {
    // Decompress gzip request bodies (push batches); scoped to this plugin only.
    await scope.register(compress, { global: true, requestEncodings: ['gzip'], threshold: 1024 });

    /** Bearer-token gate for the peer-facing routes. */
    function requireToken(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
      if (isRateLimited(request.ip)) {
        reply.code(429).send({ error: 'too many failed auth attempts, try again shortly' });
        return;
      }
      const header = request.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        recordAuthFailure(request.ip);
        reply.code(401).send({ error: 'missing bearer token' });
        return;
      }
      const peer = peers.authenticate(header.slice(7));
      if (!peer) {
        recordAuthFailure(request.ip);
        reply.code(401).send({ error: 'invalid or revoked token' });
        return;
      }
      (request as FastifyRequest & { syncPeer: RawPeerRow }).syncPeer = peer;
      done();
    }
    const peerOf = (request: FastifyRequest): RawPeerRow =>
      (request as FastifyRequest & { syncPeer: RawPeerRow }).syncPeer;

    // ── POST /api/sync/hello ──────────────────────────────────────────────────
    scope.post<{ Body: HelloRequest }>('/api/sync/hello', { preHandler: requireToken }, (request, reply) => {
      const body = request.body;
      if (body.protocolVersion !== SYNC_PROTOCOL_VERSION) {
        return reply.code(426).send({ error: 'protocol version mismatch', expected: SYNC_PROTOCOL_VERSION, got: body.protocolVersion });
      }
      const peer = peerOf(request);
      const firstBind = !peer.host_id;
      if (!peers.bindHost(peer.token_hash, body.hostId)) {
        return reply.code(409).send({ error: 'token already bound to a different host' });
      }
      upsertRemoteHost(db, { hostId: body.hostId, name: body.hostName, platform: body.platform, laymanVersion: body.laymanVersion });
      // hello fires at the start of every push (and, in later phases, every mirror
      // pass), so re-running the O(n) COUNT+SUM over recorded_events here on every
      // call would be an accidental hot-path scan. Recompute only on the first bind
      // (cheap when empty, and it refreshes a re-tokenised host whose data predates
      // the new token); steady-state counter freshness rides the per-batch update.
      if (firstBind) updateHostStats(db, body.hostId);
      peers.touch(peer.token_hash, { lastSeenAt: Date.now() });
      const cfg = getConfig();
      const bound = peers.byHash(peer.token_hash);
      const response: HelloResponse = {
        centralHostId: cfg.sync.hostId,
        centralHostName: cfg.sync.hostName,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        lastAckedSeq: bound?.last_push_seq ?? null,
        headSeq: journal.headSeq(),
      };
      return reply.send(response);
    });

    // ── POST /api/sync/push ───────────────────────────────────────────────────
    scope.post<{ Body: PushBatch }>('/api/sync/push', { preHandler: requireToken }, (request, reply) => {
      const peer = peerOf(request);
      const batch = request.body;
      // A peer may only push its own data. Bind on first push if hello was skipped.
      if (!peer.host_id) {
        if (!peers.bindHost(peer.token_hash, batch.hostId)) {
          return reply.code(409).send({ error: 'token bound to a different host' });
        }
      } else if (peer.host_id !== batch.hostId) {
        return reply.code(409).send({ error: 'batch host does not match token' });
      }

      db.prepare(
        `INSERT OR IGNORE INTO sync_hosts (host_id, name, kind, first_seen, last_seen)
         VALUES (?, ?, 'remote', ?, ?)`,
      ).run(batch.hostId, peer.name, Date.now(), Date.now());

      // The applier writes regardless of the recording toggle (recording only
      // gates the *live* recorder), but a central accepting pushes with recording
      // off is almost certainly a misconfiguration worth surfacing in the log.
      if (!getConfig().sessionRecording) {
        request.log.warn('sync: received a push while session recording is off');
      }

      const { applied, conflicts } = applier.apply(batch.hostId, batch.entries, { piiFilter: getConfig().piiFilter });

      // Live-tail: surface active remote sessions and their recent events on the
      // Dashboard. Presence is updated from batch.live; ring events broadcast as
      // event:new. Remote events never enter EventStore (see §3.8).
      const emitted = deps.registry.ingestPush(batch.hostId, peer.name, batch);
      // Fire on any presence-bearing push, not only when in-window events were
      // emitted: a session appearing or going idle carries no event of its own,
      // and onLiveEvents also re-sends the sessions list so the dashboard tracks it.
      if (emitted.length > 0 || batch.live) deps.onLiveEvents(emitted);

      const ackSeq = batch.upToSeq ?? null;
      peers.touch(peer.token_hash, {
        lastSeenAt: Date.now(),
        ...(ackSeq !== null ? { lastPushSeq: ackSeq } : {}),
      });

      const response: PushResponse = { ackSeq, applied, conflicts, headSeq: journal.headSeq() };
      return reply.send(response);
    });

    // ── GET /api/sync/snapshot (token) — mirror bootstrap, §3.10 ──────────────
    scope.get<{ Querystring: { kind?: string; cursor?: string; limit?: string } }>(
      '/api/sync/snapshot',
      { preHandler: requireToken },
      (request, reply) => {
        const peer = peerOf(request);
        if (!peer.host_id) return reply.code(409).send({ error: 'call hello first' });
        const kind = request.query.kind as SyncKind | undefined;
        const entity = kind ? SYNC_ENTITIES[kind] : undefined;
        if (!entity) return reply.code(400).send({ error: 'unknown kind' });

        const limit = Math.min(Math.max(parseInt(request.query.limit ?? '500', 10) || 500, 1), 1000);
        const cursor = request.query.cursor ?? '';
        const rows = entity.pageExcludingOrigin(db, { afterId: cursor, limit, excludeHostId: peer.host_id });
        const entries: PushEntry[] = rows.map((row) => ({
          op: 'upsert', kind: entity.kind, id: String(row[entity.idColumn]), row,
        }));
        const nextCursor = rows.length === limit ? String(rows[rows.length - 1][entity.idColumn]) : null;

        const page: SnapshotPage = { kind: entity.kind, entries, nextCursor, headSeq: journal.headSeq(), hosts: hostsWithStats(db) };
        return reply.send(page);
      },
    );

    // ── GET /api/sync/changes (token) — incremental mirror, §3.10 ─────────────
    scope.get<{ Querystring: { since?: string; limit?: string } }>(
      '/api/sync/changes',
      { preHandler: requireToken },
      (request, reply) => {
        const peer = peerOf(request);
        if (!peer.host_id) return reply.code(409).send({ error: 'call hello first' });

        const since = Math.max(parseInt(request.query.since ?? '0', 10) || 0, 0);
        const limit = Math.min(Math.max(parseInt(request.query.limit ?? '1000', 10) || 1000, 1), 1000);
        const hosts = hostsWithStats(db);

        // Behind central's retained history → tell the mirror to re-snapshot.
        const oldest = journal.oldestSeq();
        if (oldest !== null && since > 0 && since + 1 < oldest) {
          const resync: ChangesResponse = { resync: true, entries: [], headSeq: journal.headSeq(), hosts };
          return reply.send(resync);
        }

        const log = journal.readChangesSince(peer.host_id, since, limit);
        // Dedupe to the newest entry per (kind, entity_id).
        const byEntity = new Map<string, { kind: SyncKind; entityId: string; op: 'upsert' | 'delete' }>();
        for (const e of log) byEntity.set(`${e.kind}:${e.entityId}`, { kind: e.kind, entityId: e.entityId, op: e.op });

        const entries: PushEntry[] = [];
        for (const e of byEntity.values()) {
          if (e.op === 'delete') {
            entries.push({ op: 'delete', kind: e.kind, id: e.entityId });
            continue;
          }
          const entity = SYNC_ENTITIES[e.kind];
          const row = entity?.load(db, [e.entityId])[0];
          if (row) entries.push({ op: 'upsert', kind: e.kind, id: e.entityId, row });
          // an upsert whose row is gone (deleted after journaling) is skipped
        }

        // A full scanned page may leave more behind `headSeq` even when dedup
        // collapsed `entries` below `limit`; signal that explicitly so the mirror
        // keeps pulling instead of stopping on the short deduped page.
        const more = log.length >= limit;
        // Caught up → advance to the true head; otherwise to the last seq scanned.
        const headSeq = more ? log[log.length - 1].seq : journal.headSeq();
        const response: ChangesResponse = { entries, headSeq, more, hosts };
        return reply.send(response);
      },
    );

    // ── GET /api/sync/status (local) ──────────────────────────────────────────
    scope.get('/api/sync/status', () => {
      const pusher = getPusher();
      const pull = deps.getPuller?.()?.status();
      const cfg = getConfig();
      const base: SyncStatus = pusher
        ? pusher.status()
        : {
            role: cfg.sync.role,
            hostId: cfg.sync.hostId,
            hostName: cfg.sync.hostName,
            state: 'idle',
            backlog: 0,
            pushAckedSeq: null,
            backfillKind: null,
            lastSuccessAt: null,
            lastError: null,
          };
      return { ...base, ...(pull ? { pull } : {}) };
    });

    // ── POST /api/sync/test (local) — dry-run hello against centralUrl+token ──
    scope.post('/api/sync/test', async (_request, reply) => {
      const cfg = getConfig();
      if (cfg.sync.role !== 'remote') return reply.code(400).send({ error: 'not a remote' });
      if (!cfg.sync.centralUrl || !cfg.sync.token) return reply.code(400).send({ error: 'central URL and token required' });
      const client = createHttpSyncClient(getConfig, deps.laymanVersion);
      try {
        const res = await client.hello({
          hostId: cfg.sync.hostId,
          hostName: cfg.sync.hostName,
          platform: process.platform,
          laymanVersion: deps.laymanVersion,
          protocolVersion: SYNC_PROTOCOL_VERSION,
        });
        return { ok: true, centralHostName: res.centralHostName, centralHostId: res.centralHostId, protocolVersion: res.protocolVersion };
      } catch (err) {
        return reply.code(502).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });

    // ── POST /api/sync/now (local) — wake the pusher (and puller if mirror) ───
    scope.post('/api/sync/now', () => {
      getPusher()?.kick();
      deps.getPuller?.()?.kick();
      return { ok: true };
    });

    // ── POST /api/sync/reset-push (local) — clear cursors → full backfill next ─
    scope.post('/api/sync/reset-push', () => {
      for (const key of ['push_acked_seq', 'push_backfill_head', 'push_backfill_cursor'] as const) {
        db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
      }
      getPusher()?.kick();
      return { ok: true };
    });

    // ── POST /api/sync/reset-pull (local) — clear cursors → re-snapshot next ──
    scope.post('/api/sync/reset-pull', () => {
      for (const key of ['pull_acked_seq', 'pull_snapshot_head', 'pull_snapshot_cursor'] as const) {
        db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
      }
      deps.getPuller?.()?.kick();
      return { ok: true };
    });

    // ── DELETE /api/sync/suppressions (local) — "Forget suppressions" ─────────
    scope.delete('/api/sync/suppressions', () => {
      const removed = journal.clearSuppressions();
      return { ok: true, removed };
    });

    // ── Hosts (local) ─────────────────────────────────────────────────────────
    scope.get('/api/sync/hosts', () => hostsWithStats(db));

    scope.post('/api/sync/hosts/recompute', () => {
      recomputeHostStats(db);
      return hostsWithStats(db);
    });

    scope.patch<{ Params: { hostId: string }; Body: { name?: string } }>('/api/sync/hosts/:hostId', (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: 'name required' });
      db.prepare('UPDATE sync_hosts SET name = ? WHERE host_id = ?').run(name, request.params.hostId);
      return { ok: true };
    });

    // ── Peers (local, central) ────────────────────────────────────────────────
    scope.get('/api/sync/peers', () => peers.list());

    scope.post<{ Body: { name?: string } }>('/api/sync/peers', (request, reply) => {
      const name = request.body?.name?.trim();
      if (!name) return reply.code(400).send({ error: 'name required' });
      return peers.create(name);
    });

    scope.post<{ Params: { tokenHash: string } }>('/api/sync/peers/:tokenHash/revoke', (request) => {
      peers.revoke(request.params.tokenHash);
      return { ok: true };
    });

    scope.delete<{ Params: { tokenHash: string } }>('/api/sync/peers/:tokenHash', (request) => {
      peers.remove(request.params.tokenHash);
      return { ok: true };
    });
  });
}

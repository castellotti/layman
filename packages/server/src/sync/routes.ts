import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import compress from '@fastify/compress';
import type { Database } from '../db/database.js';
import type { LaymanConfig } from '../config/schema.js';
import { SyncJournal } from './journal.js';
import { SyncApplier } from './applier.js';
import { PeerStore } from './tokens.js';
import { createHttpSyncClient, type SyncPusher } from './pusher.js';
import { hostsWithStats, recomputeHostStats, upsertRemoteHost, updateHostStats } from './stats.js';
import {
  SYNC_PROTOCOL_VERSION,
  type HelloRequest,
  type HelloResponse,
  type PushBatch,
  type PushResponse,
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

  await fastify.register(async (scope) => {
    // Decompress gzip request bodies (push batches); scoped to this plugin only.
    await scope.register(compress, { global: true, requestEncodings: ['gzip'], threshold: 1024 });

    /** Bearer-token gate for the peer-facing routes. */
    function requireToken(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
      const header = request.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'missing bearer token' });
        return;
      }
      const peer = peers.authenticate(header.slice(7));
      if (!peer) {
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
      if (!peers.bindHost(peer.token_hash, body.hostId)) {
        return reply.code(409).send({ error: 'token already bound to a different host' });
      }
      upsertRemoteHost(db, { hostId: body.hostId, name: body.hostName, platform: body.platform, laymanVersion: body.laymanVersion });
      updateHostStats(db, body.hostId);
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

      const { applied, conflicts } = applier.apply(batch.hostId, batch.entries, { piiFilter: getConfig().piiFilter });

      const ackSeq = batch.upToSeq ?? null;
      peers.touch(peer.token_hash, {
        lastSeenAt: Date.now(),
        ...(ackSeq !== null ? { lastPushSeq: ackSeq } : {}),
      });

      const response: PushResponse = { ackSeq, applied, conflicts, headSeq: journal.headSeq() };
      return reply.send(response);
    });

    // ── GET /api/sync/status (local) ──────────────────────────────────────────
    scope.get('/api/sync/status', () => {
      const pusher = getPusher();
      if (pusher) return pusher.status();
      const cfg = getConfig();
      const status: SyncStatus = {
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
      return status;
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

    // ── POST /api/sync/now (local) — wake the pusher ──────────────────────────
    scope.post('/api/sync/now', () => {
      getPusher()?.kick();
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

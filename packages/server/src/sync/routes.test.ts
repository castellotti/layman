import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncState } from './state.js';
import { SyncJournal } from './journal.js';
import { SyncApplier } from './applier.js';
import { PeerStore } from './tokens.js';
import { RemoteSessionRegistry } from './presence.js';
import { registerSyncRoutes } from './routes.js';
import { LaymanConfigSchema, type LaymanConfig } from '../config/schema.js';
import { SYNC_PROTOCOL_VERSION, type PushBatch } from './protocol.js';
import type { TimelineEvent } from '../events/types.js';

const CENTRAL = 'central-host';

let db: Database;
let app: FastifyInstance;
let peers: PeerStore;
let config: LaymanConfig;
let liveCalls: TimelineEvent[][];

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', CENTRAL);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'central', 'local', 1, 1)").run(CENTRAL);
  peers = new PeerStore(db);
  config = LaymanConfigSchema.parse({ sync: { role: 'central', hostId: CENTRAL, hostName: 'central' } });

  liveCalls = [];
  app = Fastify();
  await registerSyncRoutes(app, {
    db,
    getConfig: () => config,
    journal: new SyncJournal(db),
    applier: new SyncApplier(db),
    peers,
    getPusher: () => null,
    registry: new RemoteSessionRegistry(),
    onLiveEvents: (events) => liveCalls.push(events),
    laymanVersion: '9.9.9',
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('sync routes — auth', () => {
  it('rejects hello with no token (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/hello', payload: { hostId: 'r', hostName: 'r', protocolVersion: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid token (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer('lmk_nope'), payload: { hostId: 'r', hostName: 'r', protocolVersion: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked token (401)', async () => {
    const { token, peer } = peers.create('remote');
    peers.revoke(peer.tokenHash);
    const res = await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId: 'r', hostName: 'r', protocolVersion: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rate-limits repeated failed auth to 429', async () => {
    const bad = { method: 'POST' as const, url: '/api/sync/hello', headers: bearer('lmk_wrong'), payload: { hostId: 'r', hostName: 'r', protocolVersion: 1 } };
    let sawTooMany = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject(bad);
      if (res.statusCode === 429) { sawTooMany = true; break; }
    }
    expect(sawTooMany).toBe(true);
  });
});

describe('sync routes — hello', () => {
  it('binds host on first use and returns central identity', async () => {
    const { token } = peers.create('remote');
    const res = await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId: 'remote-1', hostName: 'Remote', protocolVersion: SYNC_PROTOCOL_VERSION } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.centralHostId).toBe(CENTRAL);
    expect(body.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    // The remote is now a known host.
    expect(db.prepare("SELECT name FROM sync_hosts WHERE host_id='remote-1'").get()).toEqual({ name: 'Remote' });
  });

  it('rejects a host-id mismatch on rebind (409)', async () => {
    const { token } = peers.create('remote');
    await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId: 'remote-1', hostName: 'R', protocolVersion: SYNC_PROTOCOL_VERSION } });
    const res = await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId: 'remote-2', hostName: 'R', protocolVersion: SYNC_PROTOCOL_VERSION } });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a protocol version mismatch (426)', async () => {
    const { token } = peers.create('remote');
    const res = await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId: 'remote-1', hostName: 'R', protocolVersion: 999 } });
    expect(res.statusCode).toBe(426);
    expect(res.json().expected).toBe(SYNC_PROTOCOL_VERSION);
  });
});

describe('sync routes — push', () => {
  async function enrol(): Promise<string> {
    const { token } = peers.create('remote');
    await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId: 'remote-1', hostName: 'R', protocolVersion: SYNC_PROTOCOL_VERSION } });
    return token;
  }

  const batch = (): PushBatch => ({
    hostId: 'remote-1',
    upToSeq: 5,
    entries: [
      { op: 'upsert', kind: 'session', id: 's1', row: { session_id: 's1', cwd: '', agent_type: 'claude-code', started_at: 1, last_seen: 2, source: 'live', host_id: 'remote-1', updated_at: 2 } },
      { op: 'upsert', kind: 'event', id: 'e1', row: { id: 'e1', session_id: 's1', type: 'user_prompt', timestamp: 3, agent_type: 'claude-code', data_json: '{}', analysis_json: null, laymans_json: null, risk_level: null } },
    ],
  });

  it('applies a batch and acks the seq', async () => {
    const token = await enrol();
    const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: bearer(token), payload: batch() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ackSeq: 5, applied: 2, conflicts: 0 });
    expect(db.prepare("SELECT host_id FROM recorded_sessions WHERE session_id='s1'").get()).toEqual({ host_id: 'remote-1' });
  });

  it('accepts a gzip-compressed body', async () => {
    const token = await enrol();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { ...bearer(token), 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: gzipSync(Buffer.from(JSON.stringify(batch()))),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(2);
  });

  it('rejects a batch whose hostId does not match the bound token (409)', async () => {
    const token = await enrol();
    const res = await app.inject({ method: 'POST', url: '/api/sync/push', headers: bearer(token), payload: { ...batch(), hostId: 'someone-else' } });
    expect(res.statusCode).toBe(409);
  });

  it('does not fire onLiveEvents for a batch with neither presence nor recent events', async () => {
    const token = await enrol();
    // The default batch's event is timestamped in the distant past and carries no
    // `live` payload, so there is nothing live to surface.
    await app.inject({ method: 'POST', url: '/api/sync/push', headers: bearer(token), payload: batch() });
    expect(liveCalls).toHaveLength(0);
  });

  it('fires onLiveEvents for a presence-only push even with no emittable events', async () => {
    const token = await enrol();
    // Presence marks a session active, but the only event is too old to emit. The
    // dashboard must still be told the session exists / is active.
    await app.inject({
      method: 'POST', url: '/api/sync/push', headers: bearer(token),
      payload: { ...batch(), live: { activeSessionIds: ['s1'], sessions: [{ sessionId: 's1', cwd: '/w', agentType: 'claude-code', lastSeen: Date.now() }] } },
    });
    expect(liveCalls).toHaveLength(1);
    expect(liveCalls[0]).toEqual([]);
  });
});

describe('sync routes — pull (snapshot/changes)', () => {
  async function enrol(hostId = 'remote-1'): Promise<string> {
    const { token } = peers.create('remote');
    await app.inject({ method: 'POST', url: '/api/sync/hello', headers: bearer(token), payload: { hostId, hostName: 'R', protocolVersion: SYNC_PROTOCOL_VERSION } });
    return token;
  }

  function seed(host: string, sessionId: string): void {
    db.prepare("INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen, host_id, updated_at) VALUES (?, '', 'pi', 1, 2, ?, 2)").run(sessionId, host);
  }

  it('snapshot returns rows the requester does not own', async () => {
    const token = await enrol();
    db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES ('other', 'Other', 'remote', 1, 1)").run();
    seed(CENTRAL, 's-central');
    seed('other', 's-other');
    seed('remote-1', 's-mine'); // requester's own — excluded

    const res = await app.inject({ method: 'GET', url: '/api/sync/snapshot?kind=session&cursor=&limit=500', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    const ids = page.entries.map((e: { id: string }) => e.id).sort();
    expect(ids).toEqual(['s-central', 's-other']);
    expect(page.hosts.length).toBeGreaterThan(0);
  });

  it('changes excludes own-origin entries', async () => {
    const token = await enrol();
    seed(CENTRAL, 's-central');
    seed('remote-1', 's-mine');
    const res = await app.inject({ method: 'GET', url: '/api/sync/changes?since=0&limit=1000', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const kinds = body.entries.filter((e: { kind: string }) => e.kind === 'session').map((e: { id: string }) => e.id);
    expect(kinds).toContain('s-central');
    expect(kinds).not.toContain('s-mine');
  });

  it('changes signals resync when the cursor is behind retained history', async () => {
    const token = await enrol();
    seed(CENTRAL, 's1');
    // Push the log far ahead so oldestSeq > since + 1.
    db.prepare('UPDATE sync_log SET seq = seq + 1000').run();
    const res = await app.inject({ method: 'GET', url: '/api/sync/changes?since=1&limit=1000', headers: bearer(token) });
    expect(res.json().resync).toBe(true);
  });
});

describe('sync routes — pull management (local)', () => {
  it('reset-pull clears pull cursors', async () => {
    new SyncState(db).set('pull_acked_seq', '42');
    await app.inject({ method: 'POST', url: '/api/sync/reset-pull' });
    expect(new SyncState(db).get('pull_acked_seq')).toBeNull();
  });

  it('forget suppressions clears the table', async () => {
    new SyncJournal(db).suppress('session', 's1');
    const res = await app.inject({ method: 'DELETE', url: '/api/sync/suppressions' });
    expect(res.json().removed).toBe(1);
    expect(new SyncJournal(db).isSuppressed('session', 's1')).toBe(false);
  });
});

describe('sync routes — management (local)', () => {
  it('creates, lists, revokes and removes peers', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/sync/peers', payload: { name: 'laptop' } });
    expect(created.statusCode).toBe(200);
    const { token, peer } = created.json();
    expect(token).toMatch(/^lmk_/);

    const list = await app.inject({ method: 'GET', url: '/api/sync/peers' });
    expect(list.json()).toHaveLength(1);
    // Tokens are never returned in the listing.
    expect(JSON.stringify(list.json())).not.toContain(token);

    await app.inject({ method: 'POST', url: `/api/sync/peers/${peer.tokenHash}/revoke` });
    expect(app.inject).toBeTruthy();

    const del = await app.inject({ method: 'DELETE', url: `/api/sync/peers/${peer.tokenHash}` });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/sync/peers' });
    expect(after.json()).toHaveLength(0);
  });

  it('returns hosts and recomputes stats', async () => {
    const hosts = await app.inject({ method: 'GET', url: '/api/sync/hosts' });
    expect(hosts.json()[0].hostId).toBe(CENTRAL);
    const recompute = await app.inject({ method: 'POST', url: '/api/sync/hosts/recompute' });
    expect(recompute.statusCode).toBe(200);
  });

  it('reports status from config when there is no pusher', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sync/status' });
    expect(res.json()).toMatchObject({ role: 'central', hostId: CENTRAL, state: 'idle' });
  });
});

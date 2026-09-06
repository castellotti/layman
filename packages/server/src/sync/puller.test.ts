import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncState } from './state.js';
import { SyncApplier } from './applier.js';
import { SyncJournal } from './journal.js';
import { SYNC_ENTITIES } from './entities.js';
import { hostsWithStats } from './stats.js';
import { SyncPuller } from './puller.js';
import { PusherError, type PullClient } from './pusher.js';
import { LaymanConfigSchema, type LaymanConfig } from '../config/schema.js';
import type { HelloResponse, SnapshotPage, ChangesResponse, SyncKind, PushEntry } from './protocol.js';

const MIRROR = 'mirror-host';   // the local host doing the pull
const CENTRAL = 'central-host';
const OTHER = 'other-host';     // a third host whose data central relays

function mirrorDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', MIRROR);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'Mirror', 'local', 1, 1)").run(MIRROR);
  return db;
}

function centralDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', CENTRAL);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'Central', 'local', 1, 1)").run(CENTRAL);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'Other', 'remote', 1, 1)").run(OTHER);
  return db;
}

/** Seed a session + event owned by `host` on central. */
function seedOn(db: Database, host: string, sessionId: string, eventId: string): void {
  db.prepare(
    "INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen, host_id, updated_at) VALUES (?, '', 'pi', 1, 2, ?, 2)",
  ).run(sessionId, host);
  db.prepare(
    "INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES (?, ?, 'user_prompt', 3, 'pi', '{}')",
  ).run(eventId, sessionId);
}

function config(overrides: Partial<LaymanConfig['sync']> = {}): LaymanConfig {
  return LaymanConfigSchema.parse({ sync: { role: 'remote', mirror: true, hostId: MIRROR, hostName: 'Mirror', centralUrl: 'http://c', token: 't', ...overrides } });
}

/** A pull client backed by a real central database (mirrors the routes' logic). */
class FakeCentralPull implements PullClient {
  journal: SyncJournal;
  constructor(public central: Database, private requester = MIRROR) {
    this.journal = new SyncJournal(central);
  }
  async hello(): Promise<HelloResponse> {
    return { centralHostId: CENTRAL, centralHostName: 'Central', protocolVersion: 1, lastAckedSeq: null, headSeq: this.journal.headSeq() };
  }
  async snapshot(kind: SyncKind, cursor: string, limit: number): Promise<SnapshotPage> {
    const entity = SYNC_ENTITIES[kind];
    const rows = entity.pageExcludingOrigin(this.central, { afterId: cursor, limit, excludeHostId: this.requester });
    const entries: PushEntry[] = rows.map((r) => ({ op: 'upsert', kind, id: String(r[entity.idColumn]), row: r }));
    const nextCursor = rows.length === limit ? String(rows[rows.length - 1][entity.idColumn]) : null;
    return { kind, entries, nextCursor, headSeq: this.journal.headSeq(), hosts: hostsWithStats(this.central) };
  }
  async changes(since: number, limit: number): Promise<ChangesResponse> {
    const oldest = this.journal.oldestSeq();
    if (oldest !== null && since > 0 && since + 1 < oldest) {
      return { resync: true, entries: [], headSeq: this.journal.headSeq(), hosts: hostsWithStats(this.central) };
    }
    const log = this.journal.readChangesSince(this.requester, since, limit);
    const byEntity = new Map<string, { kind: SyncKind; entityId: string; op: 'upsert' | 'delete' }>();
    for (const e of log) byEntity.set(`${e.kind}:${e.entityId}`, { kind: e.kind, entityId: e.entityId, op: e.op });
    const entries: PushEntry[] = [];
    for (const e of byEntity.values()) {
      if (e.op === 'delete') { entries.push({ op: 'delete', kind: e.kind, id: e.entityId }); continue; }
      const row = SYNC_ENTITIES[e.kind].load(this.central, [e.entityId])[0];
      if (row) entries.push({ op: 'upsert', kind: e.kind, id: e.entityId, row });
    }
    const more = log.length >= limit;
    const headSeq = more ? log[log.length - 1].seq : this.journal.headSeq();
    return { entries, headSeq, more, hosts: hostsWithStats(this.central) };
  }
}

describe('SyncPuller', () => {
  let mdb: Database;
  let cdb: Database;
  let cfg: LaymanConfig;
  beforeEach(() => {
    mdb = mirrorDb();
    cdb = centralDb();
    cfg = config();
  });

  it('bootstraps a snapshot of other hosts, keeping true origins', async () => {
    seedOn(cdb, CENTRAL, 's-central', 'e-central');
    seedOn(cdb, OTHER, 's-other', 'e-other');
    const puller = new SyncPuller(mdb, new FakeCentralPull(cdb), () => cfg);

    await puller.drain();

    expect(mdb.prepare('SELECT COUNT(*) AS n FROM recorded_sessions').get()).toEqual({ n: 2 });
    const central = mdb.prepare("SELECT host_id FROM recorded_sessions WHERE session_id='s-central'").get() as { host_id: string };
    const other = mdb.prepare("SELECT host_id FROM recorded_sessions WHERE session_id='s-other'").get() as { host_id: string };
    expect(central.host_id).toBe(CENTRAL);
    expect(other.host_id).toBe(OTHER); // origin preserved, not rewritten to central
    // Host rows learned so chips can render.
    expect(mdb.prepare("SELECT name FROM sync_hosts WHERE host_id=?").get(OTHER)).toEqual({ name: 'Other' });
    // Snapshot complete → cursors cleared.
    expect(new SyncState(mdb).get('pull_snapshot_cursor')).toBeNull();
    expect(new SyncState(mdb).get('pull_acked_seq')).not.toBeNull();
  });

  it('applies incremental changes after bootstrap and excludes own-origin', async () => {
    seedOn(cdb, CENTRAL, 's1', 'e1');
    const puller = new SyncPuller(mdb, new FakeCentralPull(cdb), () => cfg);
    await puller.drain();

    // New central activity, plus a mirror-owned row on central (must be excluded).
    seedOn(cdb, CENTRAL, 's2', 'e2');
    seedOn(cdb, MIRROR, 's-mine', 'e-mine');

    await puller.drain();
    expect(mdb.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 2 }); // s1, s2 — not s-mine
    expect(mdb.prepare("SELECT COUNT(*) AS n FROM recorded_sessions WHERE session_id='s-mine'").get()).toEqual({ n: 0 });
  });

  it('resumes an interrupted snapshot from the persisted cursor', async () => {
    seedOn(cdb, CENTRAL, 's1', 'e1');
    seedOn(cdb, OTHER, 's2', 'e2');

    // A client that throws on the first snapshot call for events, after sessions.
    const real = new FakeCentralPull(cdb);
    let failOnce = true;
    const flaky: PullClient = {
      hello: () => real.hello(),
      snapshot: (kind, cursor, limit) => {
        if (kind === 'event' && failOnce) { failOnce = false; throw new PusherError('network', 'boom'); }
        return real.snapshot(kind, cursor, limit);
      },
      changes: (since, limit) => real.changes(since, limit),
    };
    const puller = new SyncPuller(mdb, flaky, () => cfg);
    await expect(puller.drain()).rejects.toBeInstanceOf(PusherError);
    // Sessions already applied; a cursor persisted.
    expect(mdb.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 2 });
    expect(new SyncState(mdb).get('pull_snapshot_cursor')).not.toBeNull();

    // Resume completes without duplicates.
    await puller.drain();
    expect(mdb.prepare("SELECT COUNT(*) AS n FROM recorded_events").get()).toEqual({ n: 2 });
  });

  it('keeps pulling when central dedups a full page below the limit (more=true)', async () => {
    // Skip the bootstrap snapshot so we exercise runIncremental directly.
    new SyncState(mdb).set('pull_acked_seq', '0');
    const sessionRow = (id: string) => ({
      session_id: id, cwd: '', agent_type: 'pi', started_at: 1, last_seen: 2,
      source: 'live', host_id: OTHER, updated_at: 2,
    });
    // First page: only one surviving entry (a full scanned page deduped away) but
    // more=true; the old length<limit break would stop here and strand page two.
    const pages: ChangesResponse[] = [
      { entries: [{ op: 'upsert', kind: 'session', id: 's-a', row: sessionRow('s-a') }], headSeq: 500, more: true, hosts: [] },
      { entries: [{ op: 'upsert', kind: 'session', id: 's-b', row: sessionRow('s-b') }], headSeq: 1000, more: false, hosts: [] },
    ];
    let calls = 0;
    const client: PullClient = {
      hello: async () => ({ centralHostId: CENTRAL, centralHostName: 'C', protocolVersion: 1, lastAckedSeq: null, headSeq: 1000 }),
      snapshot: async () => { throw new Error('should not snapshot'); },
      changes: async () => pages[calls++] ?? { entries: [], headSeq: 1000, more: false, hosts: [] },
    };
    const puller = new SyncPuller(mdb, client, () => cfg);
    await puller.drain();

    expect(calls).toBe(2); // did not stop after the short first page
    expect(mdb.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 2 });
    expect(new SyncState(mdb).get('pull_acked_seq')).toBe('1000');
  });

  it('restarts the snapshot when central reports resync (behind retention)', async () => {
    seedOn(cdb, CENTRAL, 's1', 'e1');
    const puller = new SyncPuller(mdb, new FakeCentralPull(cdb), () => cfg);
    await puller.drain();

    // Central compacts its whole log and adds new data far ahead.
    cdb.prepare('DELETE FROM sync_log').run();
    seedOn(cdb, CENTRAL, 's2', 'e2');
    // Force a big gap so oldestSeq > pull_acked_seq + 1.
    cdb.prepare('UPDATE sync_log SET seq = seq + 1000').run();

    await puller.drain();
    // Re-snapshot picked up s2 (and still has s1).
    expect(mdb.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 2 });
  });
});

describe('SyncApplier trustRowOrigin', () => {
  it('push forces the pusher origin, pull keeps the row origin', () => {
    const db = mirrorDb();
    const applier = new SyncApplier(db);
    const row = { session_id: 's1', cwd: '', agent_type: 'pi', started_at: 1, last_seen: 2, source: 'live', host_id: OTHER, updated_at: 2 };

    // Pull: trustRowOrigin keeps OTHER.
    applier.apply(CENTRAL, [{ op: 'upsert', kind: 'session', id: 's1', row }], { trustRowOrigin: true });
    expect((db.prepare("SELECT host_id FROM recorded_sessions WHERE session_id='s1'").get() as { host_id: string }).host_id).toBe(OTHER);
  });
});

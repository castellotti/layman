import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncState } from './state.js';
import { SyncApplier } from './applier.js';
import { SyncPusher, PusherError, type PushClient } from './pusher.js';
import { LaymanConfigSchema, type LaymanConfig } from '../config/schema.js';
import type { HelloResponse, PushBatch, PushResponse } from './protocol.js';

const REMOTE = 'remote-host';
const CENTRAL = 'central-host';

function remoteDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', REMOTE);
  return db;
}

function centralDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', CENTRAL);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'remote', 'remote', 1, 1)").run(REMOTE);
  return db;
}

function seed(db: Database, sessions: number, eventsPer: number): void {
  const s = db.prepare("INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen) VALUES (?, '', 'claude-code', 1, 2)");
  const e = db.prepare("INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES (?, ?, 'user_prompt', 1, 'claude-code', '{\"prompt\":\"hi\"}')");
  for (let i = 0; i < sessions; i++) {
    const sid = `s${i}`;
    s.run(sid);
    for (let j = 0; j < eventsPer; j++) e.run(`e${i}_${j}`, sid);
  }
}

function config(overrides: Partial<LaymanConfig['sync']> = {}): LaymanConfig {
  return LaymanConfigSchema.parse({ sync: { role: 'remote', hostId: REMOTE, hostName: 'box', centralUrl: 'http://c', token: 't', ...overrides } });
}

/** A fake client that applies batches into a real central database. */
class FakeCentral implements PushClient {
  applier: SyncApplier;
  journal = () => this.central.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM sync_log').get() as { s: number };
  helloCalls = 0;
  pushCalls = 0;
  constructor(public central: Database) {
    this.applier = new SyncApplier(central);
  }
  async hello(): Promise<HelloResponse> {
    this.helloCalls++;
    return { centralHostId: CENTRAL, centralHostName: 'central', protocolVersion: 1, lastAckedSeq: null, headSeq: this.journal().s };
  }
  async push(batch: PushBatch): Promise<PushResponse> {
    this.pushCalls++;
    const { applied, conflicts } = this.applier.apply(batch.hostId, batch.entries);
    return { ackSeq: batch.upToSeq ?? null, applied, conflicts, headSeq: this.journal().s };
  }
}

describe('SyncPusher', () => {
  let rdb: Database;
  let cdb: Database;
  let cfg: LaymanConfig;
  beforeEach(() => {
    rdb = remoteDb();
    cdb = centralDb();
    cfg = config();
  });

  it('backfills every kind then marks itself up to date', async () => {
    seed(rdb, 3, 2); // 3 sessions, 6 events
    const central = new FakeCentral(cdb);
    const pusher = new SyncPusher(rdb, central, () => cfg);

    const pushed = await pusher.drain();
    expect(pushed).toBe(3 + 6);
    expect(cdb.prepare('SELECT COUNT(*) AS n FROM recorded_sessions').get()).toEqual({ n: 3 });
    expect(cdb.prepare('SELECT COUNT(*) AS n FROM recorded_events').get()).toEqual({ n: 6 });

    // Cursor cleared; push_acked_seq set → no longer in backfill.
    const state = new SyncState(rdb);
    expect(state.get('push_backfill_cursor')).toBeNull();
    expect(state.get('push_acked_seq')).not.toBeNull();
    expect(pusher.status().backlog).toBe(0);
  });

  it('replays new journal entries incrementally after backfill', async () => {
    seed(rdb, 1, 1);
    const central = new FakeCentral(cdb);
    const pusher = new SyncPusher(rdb, central, () => cfg);
    await pusher.drain();

    // New activity after backfill.
    rdb.prepare("INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen) VALUES ('s-new', '', 'pi', 5, 6)").run();
    rdb.prepare("INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES ('e-new', 's-new', 'user_prompt', 5, 'pi', '{}')").run();

    const pushed = await pusher.drain();
    expect(pushed).toBeGreaterThanOrEqual(2);
    expect(cdb.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 2 });
    expect(pusher.status().backlog).toBe(0);
  });

  it('resumes an interrupted backfill from the persisted cursor', async () => {
    seed(rdb, 2, 1);
    const failing: PushClient = {
      async hello() { return { centralHostId: CENTRAL, centralHostName: 'c', protocolVersion: 1, lastAckedSeq: null, headSeq: 0 }; },
      async push() { throw new PusherError('network', 'boom'); },
    };
    const pusher1 = new SyncPusher(rdb, failing, () => cfg);
    await expect(pusher1.drain()).rejects.toBeInstanceOf(PusherError);

    // A cursor was persisted; nothing reached central.
    expect(new SyncState(rdb).get('push_backfill_cursor')).not.toBeNull();

    // Resume with a working client → completes without re-sending duplicates.
    const central = new FakeCentral(cdb);
    const pusher2 = new SyncPusher(rdb, central, () => cfg);
    await pusher2.drain();
    expect(cdb.prepare('SELECT COUNT(*) AS n FROM recorded_sessions').get()).toEqual({ n: 2 });
    expect(cdb.prepare("SELECT id, COUNT(*) AS n FROM recorded_events GROUP BY id HAVING n > 1").all()).toEqual([]);
  });

  it('leaves the acked cursor untouched when an incremental push fails', async () => {
    seed(rdb, 1, 1);
    const central = new FakeCentral(cdb);
    const pusher = new SyncPusher(rdb, central, () => cfg);
    await pusher.drain();
    const ackedAfterBackfill = new SyncState(rdb).get('push_acked_seq');

    // New entry, but pushing now fails.
    rdb.prepare("INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen) VALUES ('s2','', 'pi', 7, 8)").run();
    const failing: PushClient = {
      async hello() { return { centralHostId: CENTRAL, centralHostName: 'c', protocolVersion: 1, lastAckedSeq: null, headSeq: 0 }; },
      async push() { throw new PusherError('network', 'down'); },
    };
    const pusher2 = new SyncPusher(rdb, failing, () => cfg);
    await expect(pusher2.drain()).rejects.toBeInstanceOf(PusherError);
    // Cursor unchanged → the same entries re-send next time.
    expect(new SyncState(rdb).get('push_acked_seq')).toBe(ackedAfterBackfill);
  });

  it('reports a fatal state and pauses on a 401 (revoked)', async () => {
    seed(rdb, 1, 0);
    const revoked: PushClient = {
      async hello() { throw new PusherError('revoked', '401'); },
      async push() { throw new PusherError('revoked', '401'); },
    };
    const pusher = new SyncPusher(rdb, revoked, () => cfg);
    pusher.start();
    await new Promise((r) => setTimeout(r, 20));
    const status = pusher.status();
    expect(status.state).toBe('paused');
    expect(status.lastError).toContain('401');
    pusher.stop();
  });

  it('dedupes repeated journal entries for the same entity into one push', async () => {
    seed(rdb, 1, 0);
    const central = new FakeCentral(cdb);
    const pusher = new SyncPusher(rdb, central, () => cfg);
    await pusher.drain();

    // Touch the same session many times → many journal rows, one entity.
    const touch = rdb.prepare("UPDATE recorded_sessions SET last_seen = ? WHERE session_id = 's0'");
    for (let i = 0; i < 10; i++) touch.run(100 + i);

    central.pushCalls = 0;
    await pusher.drain();
    // One incremental push carrying a single deduped session upsert.
    expect(central.pushCalls).toBe(1);
    expect(pusher.status().backlog).toBe(0);
  });
});

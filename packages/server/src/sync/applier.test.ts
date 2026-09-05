import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncState } from './state.js';
import { SyncApplier } from './applier.js';
import { SyncJournal } from './journal.js';
import { SYNC_ENTITIES } from './entities.js';
import type { PushEntry, WireRow } from './protocol.js';

const CENTRAL = 'central-host';
const REMOTE = 'remote-host';

function makeCentral(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', CENTRAL);
  // Central knows the remote host (created on hello/push in production).
  db.prepare(
    "INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'remote', 'remote', 1, 1)",
  ).run(REMOTE);
  return db;
}

function sessionRow(id: string, host: string, extra: Partial<WireRow> = {}): WireRow {
  return {
    session_id: id, cwd: '', agent_type: 'claude-code', started_at: 1, last_seen: 2,
    session_model: null, session_model_display_name: null, session_name: null, source: 'live',
    host_id: host, updated_at: 2, ...extra,
  };
}

function eventRow(id: string, sessionId: string, data: object = { prompt: 'hi' }): WireRow {
  return {
    id, session_id: sessionId, type: 'user_prompt', timestamp: 3, agent_type: 'claude-code',
    data_json: JSON.stringify(data), analysis_json: null, laymans_json: null, risk_level: null,
  };
}

const upsert = (kind: PushEntry extends { kind: infer K } ? K : never, id: string, row: WireRow): PushEntry =>
  ({ op: 'upsert', kind, id, row } as PushEntry);

describe('SyncApplier', () => {
  let db: Database;
  let applier: SyncApplier;
  beforeEach(() => {
    db = makeCentral();
    applier = new SyncApplier(db);
  });

  it('applies a session + event batch and stamps the pusher origin', () => {
    const res = applier.apply(REMOTE, [
      upsert('session', 's1', sessionRow('s1', 'ignored-client-value')),
      upsert('event', 'e1', eventRow('e1', 's1')),
    ]);
    expect(res).toMatchObject({ applied: 2, conflicts: 0 });

    const sess = db.prepare("SELECT host_id FROM recorded_sessions WHERE session_id='s1'").get() as { host_id: string };
    expect(sess.host_id).toBe(REMOTE); // origin forced to the authenticated peer
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_events").get()).toEqual({ n: 1 });
  });

  it('applies entries in registry order regardless of arrival order', () => {
    // Event and bookmark arrive before their session.
    const res = applier.apply(REMOTE, [
      upsert('event', 'e1', eventRow('e1', 's1')),
      upsert('bookmark', 'b1', { id: 'b1', folder_id: null, session_id: 's1', name: 'B', sort_order: 0, created_at: 1, host_id: REMOTE, updated_at: 1 }),
      upsert('session', 's1', sessionRow('s1', REMOTE)),
    ]);
    expect(res.applied).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_events").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bookmarks").get()).toEqual({ n: 1 });
  });

  it('is idempotent: applying the same batch twice leaves one row each', () => {
    const batch: PushEntry[] = [
      upsert('session', 's1', sessionRow('s1', REMOTE)),
      upsert('event', 'e1', eventRow('e1', 's1')),
    ];
    applier.apply(REMOTE, batch);
    applier.apply(REMOTE, batch);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_events").get()).toEqual({ n: 1 });
  });

  it('rejects a session id already owned by a different host as a conflict', () => {
    applier.apply(REMOTE, [upsert('session', 's1', sessionRow('s1', REMOTE))]);
    // A second, different host tries to push the same session id.
    db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES ('other', 'o', 'remote', 1, 1)").run();
    const res = applier.apply('other', [upsert('session', 's1', sessionRow('s1', 'other', { cwd: '/evil' }))]);
    expect(res).toMatchObject({ applied: 0, conflicts: 1 });
    const sess = db.prepare("SELECT host_id, cwd FROM recorded_sessions WHERE session_id='s1'").get() as { host_id: string; cwd: string };
    expect(sess).toEqual({ host_id: REMOTE, cwd: '' }); // untouched
  });

  it('honours a delete entry and cascades a session delete', () => {
    applier.apply(REMOTE, [
      upsert('session', 's1', sessionRow('s1', REMOTE)),
      upsert('event', 'e1', eventRow('e1', 's1')),
    ]);
    const res = applier.apply(REMOTE, [{ op: 'delete', kind: 'session', id: 's1' }]);
    expect(res.applied).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_events").get()).toEqual({ n: 0 });
  });

  it('ignores an upsert for a suppressed id', () => {
    new SyncJournal(db).suppress('session', 's1');
    const res = applier.apply(REMOTE, [upsert('session', 's1', sessionRow('s1', REMOTE))]);
    expect(res.applied).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM recorded_sessions").get()).toEqual({ n: 0 });
  });

  it('re-records applied rows in the journal with the remote origin (mirror-ready)', () => {
    db.prepare('DELETE FROM sync_log').run();
    applier.apply(REMOTE, [
      upsert('session', 's1', sessionRow('s1', REMOTE)),
      upsert('event', 'e1', eventRow('e1', 's1')),
    ]);
    const origins = new Set(
      (db.prepare('SELECT DISTINCT origin_host_id FROM sync_log').all() as Array<{ origin_host_id: string }>).map((r) => r.origin_host_id),
    );
    expect(origins).toEqual(new Set([REMOTE]));
  });

  it('re-redacts event PII on ingest when piiFilter is on', () => {
    applier.apply(REMOTE, [
      upsert('session', 's1', sessionRow('s1', REMOTE)),
      upsert('event', 'e1', eventRow('e1', 's1', { prompt: 'mail me alice@example.com now' })),
    ], { piiFilter: true });
    const row = db.prepare("SELECT data_json FROM recorded_events WHERE id='e1'").get() as { data_json: string };
    expect(row.data_json).not.toContain('alice@example.com');
  });

  it('updates the pushing host counters after a batch', () => {
    applier.apply(REMOTE, [
      upsert('session', 's1', sessionRow('s1', REMOTE)),
      upsert('event', 'e1', eventRow('e1', 's1')),
    ]);
    const host = db.prepare('SELECT session_count, event_count FROM sync_hosts WHERE host_id = ?').get(REMOTE) as { session_count: number; event_count: number };
    expect(host).toEqual({ session_count: 1, event_count: 1 });
  });
});

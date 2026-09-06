import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncState } from './state.js';
import { SYNC_ENTITIES } from './entities.js';
import type { WireRow } from './protocol.js';

const HOST = 'host-A';
const OTHER = 'host-B';

function makeDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', HOST);
  return db;
}

function seedSession(db: Database, id: string, host: string): void {
  db.prepare(
    `INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen, host_id, updated_at)
     VALUES (?, '', 'claude-code', 1, 2, ?, 2)`,
  ).run(id, host);
}

describe('sync entity registry', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('pages own-origin sessions only, keyset ordered', () => {
    seedSession(db, 's-a1', HOST);
    seedSession(db, 's-a2', HOST);
    seedSession(db, 's-b1', OTHER);

    const page = SYNC_ENTITIES.session.page(db, { limit: 10, originHostId: HOST });
    expect(page.map((r) => r.session_id)).toEqual(['s-a1', 's-a2']);

    const next = SYNC_ENTITIES.session.page(db, { afterId: 's-a1', limit: 10, originHostId: HOST });
    expect(next.map((r) => r.session_id)).toEqual(['s-a2']);
  });

  it('round-trips a session load → upsert into a second database', () => {
    seedSession(db, 's1', HOST);
    const [row] = SYNC_ENTITIES.session.load(db, ['s1']);
    expect(row.host_id).toBe(HOST);

    const dest = makeDb();
    SYNC_ENTITIES.session.upsert(dest, row as WireRow);
    const [copied] = SYNC_ENTITIES.session.load(dest, ['s1']);
    expect(copied).toEqual(row);
  });

  it('upsert is idempotent and updates mutable columns', () => {
    seedSession(db, 's1', HOST);
    const dest = makeDb();
    const [row] = SYNC_ENTITIES.session.load(db, ['s1']) as WireRow[];
    SYNC_ENTITIES.session.upsert(dest, row);
    SYNC_ENTITIES.session.upsert(dest, { ...row, last_seen: 999 });
    const rows = dest.prepare('SELECT last_seen FROM recorded_sessions WHERE session_id = ?').all('s1') as Array<{ last_seen: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].last_seen).toBe(999);
  });

  it('event page filters by the owning session host via join', () => {
    seedSession(db, 's-a', HOST);
    seedSession(db, 's-b', OTHER);
    db.prepare(
      "INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES ('e-a', 's-a', 'user_prompt', 1, 'claude-code', '{}')",
    ).run();
    db.prepare(
      "INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES ('e-b', 's-b', 'user_prompt', 1, 'claude-code', '{}')",
    ).run();

    const page = SYNC_ENTITIES.event.page(db, { limit: 10, originHostId: HOST });
    expect(page.map((r) => r.id)).toEqual(['e-a']);
  });

  it('qa travels keyed by sync_id, not the integer id', () => {
    seedSession(db, 's1', HOST);
    db.prepare(
      "INSERT INTO recorded_qa (event_id, session_id, question, answer, created_at, sync_id) VALUES ('e1', 's1', 'q', 'a', 1, 'qa-sync-1')",
    ).run();
    const page = SYNC_ENTITIES.qa.page(db, { limit: 10, originHostId: HOST });
    expect(page).toHaveLength(1);
    expect(page[0].sync_id).toBe('qa-sync-1');
    expect(page[0].id).toBeUndefined(); // integer id not carried on the wire

    const dest = makeDb();
    seedSession(dest, 's1', OTHER);
    SYNC_ENTITIES.qa.upsert(dest, page[0]);
    const copied = dest.prepare('SELECT sync_id, question FROM recorded_qa').get() as { sync_id: string; question: string };
    expect(copied).toEqual({ sync_id: 'qa-sync-1', question: 'q' });
  });

  it('session remove cascades to events and qa', () => {
    seedSession(db, 's1', HOST);
    db.prepare("INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES ('e1', 's1', 'user_prompt', 1, 'x', '{}')").run();
    db.prepare("INSERT INTO recorded_qa (event_id, session_id, question, answer, created_at, sync_id) VALUES ('e1', 's1', 'q', 'a', 1, 'qs1')").run();

    SYNC_ENTITIES.session.remove(db, 's1');

    expect(db.prepare('SELECT COUNT(*) AS n FROM recorded_events').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM recorded_qa').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM recorded_sessions').get()).toEqual({ n: 0 });
  });

  it('round-trips a bookmark including host_id and folder_id', () => {
    db.prepare("INSERT INTO bookmark_folders (id, name, sort_order, created_at, host_id, updated_at) VALUES ('f1', 'F', 0, 1, ?, 1)").run(HOST);
    db.prepare("INSERT INTO bookmarks (id, folder_id, session_id, name, sort_order, created_at, host_id, updated_at) VALUES ('b1', 'f1', 's1', 'B', 0, 1, ?, 1)").run(HOST);

    const [folderRow] = SYNC_ENTITIES.bookmark_folder.load(db, ['f1']);
    const [row] = SYNC_ENTITIES.bookmark.load(db, ['b1']);
    const dest = makeDb();
    // Folders apply before bookmarks in registry order, so the FK target exists.
    SYNC_ENTITIES.bookmark_folder.upsert(dest, folderRow as WireRow);
    SYNC_ENTITIES.bookmark.upsert(dest, row as WireRow);
    const [copied] = SYNC_ENTITIES.bookmark.load(dest, ['b1']);
    expect(copied).toEqual(row);
    expect(copied.folder_id).toBe('f1');
    expect(copied.host_id).toBe(HOST);
  });
});

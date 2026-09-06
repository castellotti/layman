import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from './database.js';
import { applyMigrations } from './database.js';
import { SyncState } from '../sync/state.js';
import { backfillHostColumns } from '../sync/identity.js';

/**
 * The pre-plan schema (base tables plus the session-metadata columns), written
 * out verbatim so the migration test upgrades a realistic old database rather
 * than one this file already knows how to build. Mirrors the base DDL + the four
 * ALTERs in database.ts so an upgraded DB converges on the same sqlite_master
 * as a fresh one.
 */
const OLD_DDL = `
  CREATE TABLE recorded_sessions (
    session_id  TEXT PRIMARY KEY,
    cwd         TEXT NOT NULL DEFAULT '',
    agent_type  TEXT NOT NULL DEFAULT 'claude-code',
    started_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
  );
  CREATE TABLE recorded_events (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL,
    type          TEXT NOT NULL,
    timestamp     INTEGER NOT NULL,
    agent_type    TEXT NOT NULL DEFAULT 'claude-code',
    data_json     TEXT NOT NULL,
    analysis_json TEXT,
    laymans_json  TEXT,
    risk_level    TEXT
  );
  CREATE INDEX idx_recorded_events_session ON recorded_events(session_id, timestamp);
  CREATE TABLE recorded_qa (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    model       TEXT,
    tokens_in   INTEGER,
    tokens_out  INTEGER,
    latency_ms  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE bookmark_folders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES bookmark_folders(id) ON DELETE SET NULL,
    session_id TEXT NOT NULL, name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_bookmarks_folder ON bookmarks(folder_id, sort_order);
  CREATE INDEX idx_recorded_events_type ON recorded_events(type);
  CREATE TABLE highlight_folders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE highlights (
    id TEXT PRIMARY KEY,
    folder_id TEXT REFERENCES highlight_folders(id) ON DELETE SET NULL,
    session_id TEXT NOT NULL, prompt_event_id TEXT NOT NULL,
    response_event_id TEXT NOT NULL, name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_highlights_folder ON highlights(folder_id, sort_order);
  ALTER TABLE recorded_sessions ADD COLUMN session_model TEXT;
  ALTER TABLE recorded_sessions ADD COLUMN session_model_display_name TEXT;
  ALTER TABLE recorded_sessions ADD COLUMN session_name TEXT;
  ALTER TABLE recorded_sessions ADD COLUMN source TEXT DEFAULT 'live';
`;

function schemaEntries(db: Database): Array<{ name: string; sql: string }> {
  return (
    db
      .prepare(
        "SELECT name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{ name: string; sql: string }>
  );
}

function columnNames(db: Database, table: string): Set<string> {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function triggerNames(db: Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('applyMigrations (multi-host sync migration)', () => {
  it('upgrades an old database in place: columns, triggers, and origin backfill', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec(OLD_DDL);

    // Seed a realistic pre-migration database.
    db.prepare(
      "INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen) VALUES ('s1', '/a', 'claude-code', 100, 200)",
    ).run();
    db.prepare(
      "INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen) VALUES ('s2', '/b', 'pi', 300, 400)",
    ).run();
    db.prepare(
      "INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES ('e1', 's1', 'user_prompt', 150, 'claude-code', '{\"prompt\":\"hi\"}')",
    ).run();
    db.prepare(
      "INSERT INTO recorded_qa (event_id, session_id, question, answer, created_at) VALUES ('e1', 's1', 'q1', 'a1', 160)",
    ).run();
    db.prepare(
      "INSERT INTO recorded_qa (event_id, session_id, question, answer, created_at) VALUES ('e1', 's1', 'q2', 'a2', 170)",
    ).run();

    applyMigrations(db);

    // New columns present.
    expect(columnNames(db, 'recorded_sessions').has('host_id')).toBe(true);
    expect(columnNames(db, 'recorded_sessions').has('updated_at')).toBe(true);
    for (const t of ['bookmark_folders', 'bookmarks', 'highlight_folders', 'highlights']) {
      expect(columnNames(db, t).has('host_id')).toBe(true);
      expect(columnNames(db, t).has('updated_at')).toBe(true);
    }
    expect(columnNames(db, 'recorded_qa').has('sync_id')).toBe(true);

    // Sync scaffolding tables exist.
    for (const t of ['schema_migrations', 'sync_state', 'sync_hosts', 'sync_peers', 'sync_log', 'sync_suppressions']) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(t);
      expect(row, `expected table ${t}`).toBeTruthy();
    }

    // Both migration versions recorded.
    const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
    expect(versions).toEqual([1, 2]);

    // Journal triggers installed.
    const triggers = triggerNames(db);
    for (const t of ['trg_sessions_log_ins', 'trg_sessions_log_upd', 'trg_sessions_log_del', 'trg_events_log_ins', 'trg_events_log_upd', 'trg_qa_log_ins', 'trg_bm_log_ins', 'trg_hl_log_ins']) {
      expect(triggers.has(t), `expected trigger ${t}`).toBe(true);
    }

    // Backfill (runs from ensureHostIdentity in production; exercised directly here).
    new SyncState(db).set('hostId', 'local-host');
    backfillHostColumns(db, 'local-host');

    const hosts = db.prepare('SELECT session_id, host_id FROM recorded_sessions ORDER BY session_id').all() as Array<{ session_id: string; host_id: string }>;
    expect(hosts.every((h) => h.host_id === 'local-host')).toBe(true);

    const syncIds = (db.prepare('SELECT sync_id FROM recorded_qa').all() as Array<{ sync_id: string }>).map((r) => r.sync_id);
    expect(syncIds).toHaveLength(2);
    expect(syncIds[0]).toBeTruthy();
    expect(new Set(syncIds).size).toBe(2); // distinct
  });

  it('is idempotent: applying twice is a no-op', () => {
    const db = new BetterSqlite3(':memory:');
    applyMigrations(db);
    const before = schemaEntries(db);
    expect(() => applyMigrations(db)).not.toThrow();
    expect(schemaEntries(db)).toEqual(before);
  });

  it('a fresh database and an upgraded one converge on the same schema', () => {
    const fresh = new BetterSqlite3(':memory:');
    applyMigrations(fresh);

    const upgraded = new BetterSqlite3(':memory:');
    upgraded.exec(OLD_DDL);
    applyMigrations(upgraded);

    // Same set of objects (tables, indexes, triggers) by name. Base tables keep
    // their original CREATE text (whitespace / ALTER ordering differs between a
    // hand-written OLD_DDL and the code's base DDL), so full-SQL equality is
    // asserted only for the sync-created objects, whose CREATE text is emitted
    // identically down both paths.
    const names = (entries: Array<{ name: string }>) => new Set(entries.map((e) => e.name));
    expect(names(schemaEntries(upgraded))).toEqual(names(schemaEntries(fresh)));

    const syncSql = (db: Database) =>
      schemaEntries(db).filter((e) => e.name.startsWith('sync_') || e.name.startsWith('trg_') || e.name.startsWith('idx_sync') || e.name === 'schema_migrations' || e.name === 'idx_recorded_qa_sync_id' || e.name === 'idx_recorded_sessions_host');
    expect(syncSql(upgraded)).toEqual(syncSql(fresh));
  });
});

import BetterSqlite3 from 'better-sqlite3';
import { join } from 'path';
import { homedir } from 'os';

export type Database = BetterSqlite3.Database;

export function openDatabase(): Database {
  const dbPath = join(homedir(), '.claude', 'layman.db');
  const db = new BetterSqlite3(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recorded_sessions (
      session_id  TEXT PRIMARY KEY,
      cwd         TEXT NOT NULL DEFAULT '',
      agent_type  TEXT NOT NULL DEFAULT 'claude-code',
      started_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recorded_events (
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

    CREATE INDEX IF NOT EXISTS idx_recorded_events_session
      ON recorded_events(session_id, timestamp);

    CREATE TABLE IF NOT EXISTS recorded_qa (
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

    CREATE TABLE IF NOT EXISTS bookmark_folders (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id          TEXT PRIMARY KEY,
      folder_id   TEXT REFERENCES bookmark_folders(id) ON DELETE SET NULL,
      session_id  TEXT NOT NULL,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookmarks_folder
      ON bookmarks(folder_id, sort_order);

    CREATE INDEX IF NOT EXISTS idx_recorded_events_type
      ON recorded_events(type);
  `);

  // Migration: add session metadata columns
  const columns = db.prepare("PRAGMA table_info(recorded_sessions)").all() as Array<{ name: string }>;
  const colNames = new Set(columns.map(c => c.name));
  if (!colNames.has('session_model'))
    db.exec("ALTER TABLE recorded_sessions ADD COLUMN session_model TEXT");
  if (!colNames.has('session_model_display_name'))
    db.exec("ALTER TABLE recorded_sessions ADD COLUMN session_model_display_name TEXT");
  if (!colNames.has('session_name'))
    db.exec("ALTER TABLE recorded_sessions ADD COLUMN session_name TEXT");
}

import BetterSqlite3 from 'better-sqlite3';
import { ensureLaymanDataDir, laymanDbPath } from '../config/paths.js';

export type Database = BetterSqlite3.Database;

export function openDatabase(): Database {
  // Ensure the data directory exists — better-sqlite3 will not create the
  // parent directory, and on a fresh install nothing else has created it yet.
  ensureLaymanDataDir();
  const dbPath = laymanDbPath();
  const db = new BetterSqlite3(dbPath);

  /*
   * DELETE, not WAL — deliberately, and the reason matters.
   *
   * The database lives at ~/.local/share/layman/layman.db, which in the normal
   * Docker deployment is a *bind mount* into the container (docker-compose.yml
   * mounts ${HOME}/.local/share/layman). On macOS that mount is FUSE-backed
   * (virtiofs / gRPC-FUSE), and WAL mode depends on two things such mounts do
   * not reliably provide:
   * a shared-memory `-shm` file coordinated via mmap, and POSIX advisory locks
   * with correct cross-process semantics. Running WAL over one is a documented
   * way to corrupt a SQLite database.
   *
   * This is not hypothetical here: on 2026-08-05 this database was found
   * malformed (`btreeInitPage() returns error code 11` on two pages of
   * recorded_events, plus three indexes with wrong entry counts). It was
   * recovered in full via `sqlite3 .recover` with zero rows lost, and the
   * journal mode changed to DELETE at the same time.
   *
   * The cost is that writers take an exclusive lock for the duration of a
   * transaction instead of appending to a WAL. Layman has exactly one writer
   * process and writes one small row per hook event, so this is not a
   * throughput concern — and correctness over a bind mount is worth far more
   * than write concurrency we do not use.
   *
   * If Layman is ever run natively (no container, real filesystem), WAL would
   * be safe and faster. Detect that before changing it back; do not simply
   * assume WAL is the better default.
   */
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');

  applyMigrations(db);
  return db;
}

export function applyMigrations(db: Database): void {
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

    CREATE TABLE IF NOT EXISTS highlight_folders (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id                TEXT PRIMARY KEY,
      folder_id         TEXT REFERENCES highlight_folders(id) ON DELETE SET NULL,
      session_id        TEXT NOT NULL,
      prompt_event_id   TEXT NOT NULL,
      response_event_id TEXT NOT NULL,
      name              TEXT NOT NULL,
      sort_order        INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_highlights_folder
      ON highlights(folder_id, sort_order);
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
  if (!colNames.has('source'))
    db.exec("ALTER TABLE recorded_sessions ADD COLUMN source TEXT DEFAULT 'live'");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  recordMigration(db, 1);

  applySyncMigration(db);
  recordMigration(db, 2);
}

function recordMigration(db: Database, version: number): void {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(version, Date.now());
}

function addColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * Migration 2 — multi-host sync scaffolding (schema only; no host backfill).
 *
 * See docs/planning/multi-host-sync.md §4. Structural DDL lives here and is
 * idempotent; the row backfill (host_id / sync_id / updated_at and the local
 * sync_hosts row) runs from `ensureHostIdentity()` once the host id is known,
 * because the triggers and backfill both read `sync_state.hostId`.
 *
 * Every recorded-data write is captured by AFTER INSERT/UPDATE/DELETE triggers
 * into `sync_log`, so no scattered write site (recorder, bookmarks, highlights,
 * raw UPDATEs in server.ts / pii/purge.ts) needs instrumenting to be journaled.
 */
export function applySyncMigration(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS sync_hosts (
      host_id        TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      kind           TEXT NOT NULL,
      platform       TEXT, layman_version TEXT,
      first_seen     INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      session_count  INTEGER NOT NULL DEFAULT 0,
      event_count    INTEGER NOT NULL DEFAULT 0,
      content_bytes  INTEGER NOT NULL DEFAULT 0,
      first_activity INTEGER, last_activity INTEGER
    );

    CREATE TABLE IF NOT EXISTS sync_peers (
      token_hash     TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      host_id        TEXT,
      created_at     INTEGER NOT NULL,
      last_seen_at   INTEGER, last_push_seq INTEGER, last_pull_seq INTEGER,
      interval_seconds INTEGER,
      revoked_at     INTEGER,
      last_error     TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind           TEXT NOT NULL,
      entity_id      TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      op             TEXT NOT NULL,
      session_id     TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_origin ON sync_log(origin_host_id, seq);
    CREATE INDEX IF NOT EXISTS idx_sync_log_entity ON sync_log(kind, entity_id);

    CREATE TABLE IF NOT EXISTS sync_suppressions (
      kind TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (kind, entity_id));
  `);

  addColumn(db, 'recorded_sessions', 'host_id', 'host_id TEXT');
  addColumn(db, 'recorded_sessions', 'updated_at', 'updated_at INTEGER');
  addColumn(db, 'bookmark_folders', 'host_id', 'host_id TEXT');
  addColumn(db, 'bookmark_folders', 'updated_at', 'updated_at INTEGER');
  addColumn(db, 'bookmarks', 'host_id', 'host_id TEXT');
  addColumn(db, 'bookmarks', 'updated_at', 'updated_at INTEGER');
  addColumn(db, 'highlight_folders', 'host_id', 'host_id TEXT');
  addColumn(db, 'highlight_folders', 'updated_at', 'updated_at INTEGER');
  addColumn(db, 'highlights', 'host_id', 'host_id TEXT');
  addColumn(db, 'highlights', 'updated_at', 'updated_at INTEGER');
  addColumn(db, 'recorded_qa', 'sync_id', 'sync_id TEXT');

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_recorded_qa_sync_id ON recorded_qa(sync_id);
    CREATE INDEX IF NOT EXISTS idx_recorded_sessions_host ON recorded_sessions(host_id);
  `);

  createSyncTriggers(db);
}

// `now` in milliseconds, matching every other timestamp in the DB.
const NOW_MS = `CAST(strftime('%s','now') AS INTEGER) * 1000`;
const LOCAL_HOST = `(SELECT value FROM sync_state WHERE key = 'hostId')`;

/**
 * Journal triggers. Two shapes:
 *  - a "host default" trigger back-fills the local host id on insert so no
 *    existing INSERT site needs to set host_id;
 *  - "log" triggers append an upsert/delete entry to sync_log with the row's
 *    true origin. Ordering: the default-host trigger is created before the log
 *    triggers so it fires first; the extra log row its UPDATE produces dedupes
 *    away at read/compaction time (see plan §3.4).
 */
function createSyncTriggers(db: Database): void {
  const stmts: string[] = [];

  // ── Curation tables (host_id + id) ────────────────────────────────────────
  const curation: Array<{ table: string; kind: string; hasSession: boolean }> = [
    { table: 'bookmark_folders', kind: 'bookmark_folder', hasSession: false },
    { table: 'bookmarks', kind: 'bookmark', hasSession: true },
    { table: 'highlight_folders', kind: 'highlight_folder', hasSession: false },
    { table: 'highlights', kind: 'highlight', hasSession: true },
  ];
  const abbr: Record<string, string> = {
    bookmark_folders: 'bmf', bookmarks: 'bm',
    highlight_folders: 'hlf', highlights: 'hl',
  };
  for (const { table, kind, hasSession } of curation) {
    const t = abbr[table];
    const sess = (ref: 'NEW' | 'OLD') => (hasSession ? `${ref}.session_id` : 'NULL');
    stmts.push(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_host_default AFTER INSERT ON ${table}
      WHEN NEW.host_id IS NULL BEGIN
        UPDATE ${table} SET host_id = ${LOCAL_HOST} WHERE id = NEW.id;
      END;`);
    stmts.push(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_log_ins AFTER INSERT ON ${table} BEGIN
        INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
        VALUES ('${kind}', NEW.id, COALESCE(NEW.host_id, ${LOCAL_HOST}), 'upsert', ${sess('NEW')}, ${NOW_MS});
      END;`);
    stmts.push(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_log_upd AFTER UPDATE ON ${table} BEGIN
        INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
        VALUES ('${kind}', NEW.id, COALESCE(NEW.host_id, ${LOCAL_HOST}), 'upsert', ${sess('NEW')}, ${NOW_MS});
      END;`);
    stmts.push(`
      CREATE TRIGGER IF NOT EXISTS trg_${t}_log_del AFTER DELETE ON ${table} BEGIN
        INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
        VALUES ('${kind}', OLD.id, COALESCE(OLD.host_id, ${LOCAL_HOST}), 'delete', ${sess('OLD')}, ${NOW_MS});
      END;`);
  }

  // ── recorded_sessions ─────────────────────────────────────────────────────
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_sessions_host_default AFTER INSERT ON recorded_sessions
    WHEN NEW.host_id IS NULL BEGIN
      UPDATE recorded_sessions SET host_id = ${LOCAL_HOST} WHERE session_id = NEW.session_id;
    END;`);
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_sessions_log_ins AFTER INSERT ON recorded_sessions BEGIN
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('session', NEW.session_id, COALESCE(NEW.host_id, ${LOCAL_HOST}), 'upsert', NEW.session_id, ${NOW_MS});
    END;`);
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_sessions_log_upd AFTER UPDATE ON recorded_sessions BEGIN
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('session', NEW.session_id, COALESCE(NEW.host_id, ${LOCAL_HOST}), 'upsert', NEW.session_id, ${NOW_MS});
    END;`);
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_sessions_log_del AFTER DELETE ON recorded_sessions BEGIN
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('session', OLD.session_id, COALESCE(OLD.host_id, ${LOCAL_HOST}), 'delete', OLD.session_id, ${NOW_MS});
    END;`);

  // ── recorded_events (origin via session join; no host_id column; no DELETE trigger) ──
  const eventOrigin = `COALESCE((SELECT host_id FROM recorded_sessions WHERE session_id = NEW.session_id), ${LOCAL_HOST})`;
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_events_log_ins AFTER INSERT ON recorded_events BEGIN
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('event', NEW.id, ${eventOrigin}, 'upsert', NEW.session_id, ${NOW_MS});
    END;`);
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_events_log_upd AFTER UPDATE OF type, data_json, analysis_json, laymans_json, risk_level ON recorded_events BEGIN
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('event', NEW.id, ${eventOrigin}, 'upsert', NEW.session_id, ${NOW_MS});
    END;`);

  // ── recorded_qa (entity is the portable sync_id, not the local integer id) ──
  // The portable id is assigned in the log trigger's own body rather than a
  // separate default trigger: a sibling AFTER INSERT trigger does not see the
  // other's UPDATE, but statements within one trigger body run in order, so the
  // INSERT below reads the sync_id the UPDATE above just set. Applier-supplied
  // rows already carry a sync_id and keep it (the `IS NULL` guard).
  const qaOrigin = `COALESCE((SELECT host_id FROM recorded_sessions WHERE session_id = NEW.session_id), ${LOCAL_HOST})`;
  const qaSyncId = `(SELECT sync_id FROM recorded_qa WHERE id = NEW.id)`;
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_qa_log_ins AFTER INSERT ON recorded_qa BEGIN
      UPDATE recorded_qa SET sync_id = lower(hex(randomblob(16))) WHERE id = NEW.id AND sync_id IS NULL;
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('qa', ${qaSyncId}, ${qaOrigin}, 'upsert', NEW.session_id, ${NOW_MS});
    END;`);
  stmts.push(`
    CREATE TRIGGER IF NOT EXISTS trg_qa_log_upd AFTER UPDATE OF question, answer ON recorded_qa BEGIN
      INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
      VALUES ('qa', ${qaSyncId}, ${qaOrigin}, 'upsert', NEW.session_id, ${NOW_MS});
    END;`);

  for (const s of stmts) db.exec(s);
}

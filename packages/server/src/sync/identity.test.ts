import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir, hostname } from 'os';
import { join } from 'path';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { LaymanConfigSchema, type LaymanConfig } from '../config/schema.js';
import { setConfig, updateConfig } from '../config/config.js';
import { defaultHostName, detectContainer, ensureHostIdentity } from './identity.js';
import { SyncState } from './state.js';

function cfg(overrides: Partial<LaymanConfig['sync']> = {}): LaymanConfig {
  return LaymanConfigSchema.parse({ sync: overrides });
}

function makeDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  return db;
}

describe('defaultHostName resolution order', () => {
  const savedEnv = process.env.LAYMAN_HOST_NAME;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LAYMAN_HOST_NAME;
    else process.env.LAYMAN_HOST_NAME = savedEnv;
  });

  it('prefers an explicit sync.hostName over everything', () => {
    process.env.LAYMAN_HOST_NAME = 'from-env';
    expect(defaultHostName(cfg({ hostName: 'explicit' }), 'abcd1234-rest')).toBe('explicit');
  });

  it('uses LAYMAN_HOST_NAME when no explicit name is set', () => {
    process.env.LAYMAN_HOST_NAME = 'from-env';
    expect(defaultHostName(cfg(), 'abcd1234-rest')).toBe('from-env');
  });

  it('falls back to a container placeholder or os.hostname()', () => {
    delete process.env.LAYMAN_HOST_NAME;
    const result = defaultHostName(cfg(), 'abcd1234-rest');
    const expected = detectContainer() ? 'layman-abcd1234' : hostname();
    expect(result).toBe(expected);
  });
});

describe('ensureHostIdentity', () => {
  let dataDir: string;
  const savedDataDir = process.env.LAYMAN_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'layman-identity-'));
    process.env.LAYMAN_DATA_DIR = dataDir;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.LAYMAN_DATA_DIR;
    else process.env.LAYMAN_DATA_DIR = savedDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('mints a stable host id, persists it, and writes it to sync_state', () => {
    const db = makeDb();
    const config = cfg();
    const { hostId } = ensureHostIdentity(config, db);

    expect(hostId).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.sync.hostId).toBe(hostId);
    expect(new SyncState(db).get('hostId')).toBe(hostId);
    // Persisted to layman.json in the temp data dir.
    expect(existsSync(join(dataDir, 'layman.json'))).toBe(true);
  });

  it('keeps an already-persisted host id instead of minting a new one', () => {
    const db = makeDb();
    const config = cfg({ hostId: 'preset-host-id' });
    const { hostId } = ensureHostIdentity(config, db);
    expect(hostId).toBe('preset-host-id');
    expect(new SyncState(db).get('hostId')).toBe('preset-host-id');
  });

  it('records a local sync_hosts row with computed counters', () => {
    // Simulate a real in-place upgrade: rows predate the sync migration (and its
    // triggers), so they carry a NULL host_id that identity backfill must fill.
    const db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE recorded_sessions (
        session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL DEFAULT '',
        agent_type TEXT NOT NULL DEFAULT 'claude-code',
        started_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE recorded_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
        timestamp INTEGER NOT NULL, agent_type TEXT NOT NULL DEFAULT 'claude-code',
        data_json TEXT NOT NULL, analysis_json TEXT, laymans_json TEXT, risk_level TEXT);
    `);
    db.prepare(
      "INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen) VALUES ('s1', '', 'claude-code', 10, 20)",
    ).run();
    db.prepare(
      "INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES ('e1', 's1', 'user_prompt', 12, 'claude-code', '{\"prompt\":\"hi\"}')",
    ).run();
    applyMigrations(db);

    const config = cfg();
    const { hostId } = ensureHostIdentity(config, db);

    const row = db.prepare('SELECT * FROM sync_hosts WHERE host_id = ?').get(hostId) as {
      kind: string; session_count: number; event_count: number; content_bytes: number;
    };
    expect(row.kind).toBe('local');
    expect(row.session_count).toBe(1);
    expect(row.event_count).toBe(1);
    expect(row.content_bytes).toBeGreaterThan(0);

    // The pre-existing session was stamped with the local host id.
    const sess = db.prepare("SELECT host_id FROM recorded_sessions WHERE session_id = 's1'").get() as { host_id: string };
    expect(sess.host_id).toBe(hostId);
  });
});

describe('config update preserves the persisted host id', () => {
  it('updateConfig without sync.hostId keeps the identity (deep-merge)', () => {
    const config = LaymanConfigSchema.parse({ sync: { hostId: 'stable-id', hostName: 'box' } });
    setConfig(config);

    // A Settings change that omits sync entirely, and one that sends a partial sync.
    const afterTheme = updateConfig({ theme: 'light' });
    expect(afterTheme.sync.hostId).toBe('stable-id');

    const afterRole = updateConfig({ sync: { role: 'central' } as LaymanConfig['sync'] });
    expect(afterRole.sync.hostId).toBe('stable-id');
    expect(afterRole.sync.role).toBe('central');
    expect(afterRole.sync.hostName).toBe('box');
  });
});

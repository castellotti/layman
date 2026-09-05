import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from './database.js';
import { applyMigrations } from './database.js';
import { searchEvents } from './search.js';

const LOCAL = 'local-host';
const REMOTE = 'remote-host';

function makeDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'This box', 'local', 1, 1)").run(LOCAL);
  db.prepare("INSERT INTO sync_hosts (host_id, name, kind, first_seen, last_seen) VALUES (?, 'Workstation', 'remote', 1, 1)").run(REMOTE);
  return db;
}

function seedSession(db: Database, sessionId: string, host: string, prompt: string): void {
  db.prepare(
    "INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen, host_id, updated_at) VALUES (?, '', 'claude-code', 1, 2, ?, 2)",
  ).run(sessionId, host);
  db.prepare(
    "INSERT INTO recorded_events (id, session_id, type, timestamp, agent_type, data_json) VALUES (?, ?, 'user_prompt', 3, 'claude-code', ?)",
  ).run(`e-${sessionId}`, sessionId, JSON.stringify({ prompt }));
}

describe('searchEvents host attribution', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
    seedSession(db, 's-local', LOCAL, 'the quick brown fox');
    seedSession(db, 's-remote', REMOTE, 'the quick brown fox');
  });

  it('returns host attribution on session summaries', () => {
    const res = searchEvents(db, { query: 'quick', fields: ['dataPrompt'] });
    const byId = new Map(res.sessions.map((s) => [s.sessionId, s]));
    expect(byId.get('s-local')).toMatchObject({ hostId: LOCAL, hostName: 'This box' });
    expect(byId.get('s-remote')).toMatchObject({ hostId: REMOTE, hostName: 'Workstation' });
  });

  it('filters to a single host with hostIds', () => {
    const res = searchEvents(db, { query: 'quick', fields: ['dataPrompt'], hostIds: [REMOTE] });
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['s-remote']);
    expect(res.events.every((e) => e.sessionId === 's-remote')).toBe(true);
  });

  it('returns both hosts when hostIds is omitted', () => {
    const res = searchEvents(db, { query: 'quick', fields: ['dataPrompt'] });
    expect(new Set(res.sessions.map((s) => s.sessionId))).toEqual(new Set(['s-local', 's-remote']));
  });

  it('an unknown host filter matches nothing', () => {
    const res = searchEvents(db, { query: 'quick', fields: ['dataPrompt'], hostIds: ['nope'] });
    expect(res.totalMatches).toBe(0);
  });
});

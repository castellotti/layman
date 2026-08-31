import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { countRecordedSessionsByAgentType } from './recorder.js';

function makeDb() {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE recorded_sessions (
      session_id  TEXT PRIMARY KEY,
      cwd         TEXT NOT NULL DEFAULT '',
      agent_type  TEXT NOT NULL DEFAULT 'claude-code',
      started_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
  `);
  return db;
}

describe('countRecordedSessionsByAgentType', () => {
  it('returns an empty map for an empty table', () => {
    const db = makeDb();
    expect(countRecordedSessionsByAgentType(db)).toEqual({});
  });

  it('counts sessions grouped by agent_type', () => {
    const db = makeDb();
    const insert = db.prepare(
      'INSERT INTO recorded_sessions (session_id, agent_type, started_at, last_seen) VALUES (?, ?, 0, 0)',
    );
    const rows: Array<[string, string]> = [
      ['s1', 'claude-code'],
      ['s2', 'claude-code'],
      ['s3', 'cline'],
      ['s4', 'pi'],
      ['s5', 'pi'],
      ['s6', 'pi'],
      ['s7', 'open-webui'],
    ];
    for (const [id, agent] of rows) insert.run(id, agent);

    expect(countRecordedSessionsByAgentType(db)).toEqual({
      'claude-code': 2,
      cline: 1,
      pi: 3,
      'open-webui': 1,
    });
  });
});

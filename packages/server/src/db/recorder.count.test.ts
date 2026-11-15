import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { countRecordedSessionsByAgentType, recordedActivityProbe, recordedSubagentsProbe } from './recorder.js';

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

describe('recordedActivityProbe', () => {
  it('is true only for a session that recorded something other than start-up noise', () => {
    const db = new BetterSqlite3(':memory:');
    db.exec('CREATE TABLE recorded_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO recorded_events (id, session_id, type) VALUES (?, ?, ?)');
    insert.run('1', 'quiet', 'instructions_loaded');
    insert.run('2', 'quiet', 'session_metrics');
    insert.run('3', 'quiet', 'config_change');
    insert.run('4', 'busy', 'instructions_loaded');
    insert.run('5', 'busy', 'user_prompt');
    const probe = recordedActivityProbe(db);
    expect([probe('quiet'), probe('busy'), probe('unknown')]).toEqual([false, true, false]);
  });
});

describe('recordedSubagentsProbe', () => {
  it("lists a session's subagents by their first event, oldest first", () => {
    const db = new BetterSqlite3(':memory:');
    db.exec('CREATE TABLE recorded_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, data_json TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO recorded_events (id, session_id, timestamp, data_json) VALUES (?, ?, ?, ?)');
    insert.run('1', 's', 10, JSON.stringify({ toolName: 'Read' }));
    insert.run('2', 's', 20, JSON.stringify({ subagentId: 'b' }));
    insert.run('3', 's', 30, JSON.stringify({ subagentId: 'a' }));
    insert.run('4', 's', 40, JSON.stringify({ subagentId: 'b' }));
    insert.run('5', 'other', 5, JSON.stringify({ subagentId: 'c' }));
    const probe = recordedSubagentsProbe(db);
    expect(probe('s')).toEqual(['b', 'a']);
    expect(probe('none')).toEqual([]);
  });
});

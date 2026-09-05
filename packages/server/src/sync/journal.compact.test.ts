import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncJournal } from './journal.js';

const LOCAL = 'local-host';
const OTHER = 'other-host';

function makeDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  return db;
}

/** Insert a raw journal row (bypassing triggers) with an explicit created_at. */
function log(db: Database, kind: string, entityId: string, origin: string, op: string, createdAt: number): void {
  db.prepare(
    'INSERT INTO sync_log (kind, entity_id, origin_host_id, op, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(kind, entityId, origin, op, null, createdAt);
}

function seqs(db: Database): number[] {
  return (db.prepare('SELECT seq FROM sync_log ORDER BY seq').all() as Array<{ seq: number }>).map((r) => r.seq);
}

describe('SyncJournal.compact', () => {
  let db: Database;
  let journal: SyncJournal;
  beforeEach(() => {
    db = makeDb();
    journal = new SyncJournal(db);
  });

  it('collapses duplicate entries for the same entity to the newest', () => {
    log(db, 'session', 's1', LOCAL, 'upsert', 100); // seq 1
    log(db, 'session', 's1', LOCAL, 'upsert', 200); // seq 2 (newer)
    log(db, 'event', 'e1', LOCAL, 'upsert', 150);   // seq 3
    journal.compact({ localHostId: LOCAL });
    // Only the newest per (kind, entity_id) survives.
    const rows = db.prepare('SELECT kind, entity_id, seq FROM sync_log ORDER BY seq').all();
    expect(rows).toEqual([
      { kind: 'session', entity_id: 's1', seq: 2 },
      { kind: 'event', entity_id: 'e1', seq: 3 },
    ]);
  });

  it('on a remote, drops own-origin entries already acked but keeps unacked ones', () => {
    log(db, 'session', 's1', LOCAL, 'upsert', 100); // seq 1 (acked)
    log(db, 'session', 's2', LOCAL, 'upsert', 100); // seq 2 (acked)
    log(db, 'session', 's3', LOCAL, 'upsert', 100); // seq 3 (unacked)
    log(db, 'session', 's4', OTHER, 'upsert', 100); // seq 4 (other host — never dropped by ack)
    journal.compact({ localHostId: LOCAL, pushAckedSeq: 2 });
    // seq 1,2 dropped (own-origin <= ack); seq 3 (unacked own) and seq 4 (other) kept.
    expect(seqs(db)).toEqual([3, 4]);
  });

  it('on a central, drops entries older than the retention window', () => {
    const now = Date.now();
    log(db, 'session', 's-old', OTHER, 'upsert', now - 40 * 24 * 60 * 60 * 1000); // 40 days
    log(db, 'session', 's-new', OTHER, 'upsert', now - 1 * 24 * 60 * 60 * 1000);  // 1 day
    journal.compact({ localHostId: LOCAL, retentionMs: 30 * 24 * 60 * 60 * 1000 });
    const rows = db.prepare('SELECT entity_id FROM sync_log').all();
    expect(rows).toEqual([{ entity_id: 's-new' }]);
  });

  it('reports the oldest retained seq', () => {
    expect(journal.oldestSeq()).toBeNull();
    log(db, 'session', 's1', LOCAL, 'upsert', 100);
    log(db, 'session', 's2', LOCAL, 'upsert', 100);
    db.prepare('DELETE FROM sync_log WHERE seq = 1').run();
    expect(journal.oldestSeq()).toBe(2);
  });
});

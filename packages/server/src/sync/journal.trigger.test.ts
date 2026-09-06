import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../db/database.js';
import { applyMigrations } from '../db/database.js';
import { SyncState } from './state.js';
import { SessionRecorder } from '../db/recorder.js';
import { BookmarkStore } from '../db/bookmarks.js';
import { HighlightStore } from '../db/highlights.js';
import { executePurge } from '../pii/purge.js';
import { EventStore } from '../events/store.js';
import type { TimelineEvent } from '../events/types.js';

const HOST = 'local-host';

function makeDb(): Database {
  const db = new BetterSqlite3(':memory:');
  applyMigrations(db);
  new SyncState(db).set('hostId', HOST);
  return db;
}

interface LogRow {
  kind: string;
  entity_id: string;
  origin_host_id: string;
  op: string;
  session_id: string | null;
}

function log(db: Database): LogRow[] {
  return db
    .prepare('SELECT kind, entity_id, origin_host_id, op, session_id FROM sync_log ORDER BY seq')
    .all() as LogRow[];
}

function clearLog(db: Database): void {
  db.prepare('DELETE FROM sync_log').run();
}

function ev(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: overrides.id ?? 'e1',
    type: overrides.type ?? 'user_prompt',
    timestamp: overrides.timestamp ?? 1000,
    sessionId: overrides.sessionId ?? 's1',
    agentType: overrides.agentType ?? 'claude-code',
    data: overrides.data ?? { prompt: 'hello world' },
    analysis: overrides.analysis,
    laymans: overrides.laymans,
    riskLevel: overrides.riskLevel,
  };
}

describe('sync journal triggers', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('journals a session and event on SessionRecorder inserts', () => {
    const recorder = new SessionRecorder(db, () => true, () => false);
    recorder.saveEventsFromMemory([ev()]);

    const entries = log(db);
    const kinds = entries.map((e) => e.kind);
    expect(kinds).toContain('session');
    expect(kinds).toContain('event');
    // Every entry is stamped with the local origin.
    expect(entries.every((e) => e.origin_host_id === HOST)).toBe(true);
    const sessionEntry = entries.find((e) => e.kind === 'session')!;
    expect(sessionEntry.entity_id).toBe('s1');
    expect(sessionEntry.op).toBe('upsert');
    const eventEntry = entries.find((e) => e.kind === 'event')!;
    expect(eventEntry.entity_id).toBe('e1');
    expect(eventEntry.session_id).toBe('s1');
  });

  it('journals an event upsert when the recorder updates laymans', () => {
    const store = new EventStore();
    const recorder = new SessionRecorder(db, () => true, () => false);
    recorder.attach(store);

    const added = store.add('user_prompt', 's1', { prompt: 'x' }, undefined, 'claude-code');
    clearLog(db);

    // A layman's explanation attaches to the existing event → recorder UPDATE.
    store.attachLaymans(added.id, { explanation: 'plain english', model: 'm', latencyMs: 1, tokens: { input: 1, output: 1 } });

    const kinds = log(db).map((e) => e.kind);
    expect(kinds).toContain('event');
  });

  it('journals a session delete (cascade) without per-event delete rows', () => {
    const recorder = new SessionRecorder(db, () => true, () => false);
    recorder.saveEventsFromMemory([ev({ id: 'e1' }), ev({ id: 'e2', timestamp: 1001 })]);
    recorder.recordQA('e1', 's1', { question: 'q', answer: 'a', model: null, tokensIn: null, tokensOut: null, latencyMs: null });
    clearLog(db);

    new BookmarkStore(db).deleteSession('s1');

    const entries = log(db);
    // Exactly one delete entry, for the session — no per-event or per-qa deletes.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'session', op: 'delete', entity_id: 's1', origin_host_id: HOST });
  });

  it('journals a portable sync_id for Q&A, not the integer id', () => {
    const recorder = new SessionRecorder(db, () => true, () => false);
    recorder.saveEventsFromMemory([ev()]);
    clearLog(db);

    recorder.recordQA('e1', 's1', { question: 'q', answer: 'a', model: null, tokensIn: null, tokensOut: null, latencyMs: null });

    const entries = log(db);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('qa');
    // entity_id is the 32-hex sync_id, not "1".
    expect(entries[0].entity_id).toMatch(/^[0-9a-f]{32}$/);
    const syncId = (db.prepare('SELECT sync_id FROM recorded_qa').get() as { sync_id: string }).sync_id;
    expect(entries[0].entity_id).toBe(syncId);
  });

  it('journals bookmark folder and bookmark CRUD', () => {
    const store = new BookmarkStore(db);
    const folder = store.createFolder('Work');
    const bm = store.createBookmark('s1', 'A session', folder.id);
    clearLog(db);

    store.renameBookmark(bm.id, 'Renamed');
    store.deleteBookmark(bm.id);

    const entries = log(db);
    expect(entries.map((e) => `${e.kind}:${e.op}`)).toEqual(['bookmark:upsert', 'bookmark:delete']);
    expect(entries.every((e) => e.origin_host_id === HOST)).toBe(true);
    expect(entries[0].entity_id).toBe(bm.id);
  });

  it('journals highlight folder and highlight CRUD', () => {
    const store = new HighlightStore(db);
    const folder = store.createFolder('Picks');
    const hl = store.createHighlight('s1', 'p1', 'r1', 'A highlight', folder.id);
    clearLog(db);

    store.updateHighlight(hl.id, { name: 'Renamed' });
    store.deleteHighlight(hl.id);

    const entries = log(db);
    expect(entries.map((e) => `${e.kind}:${e.op}`)).toEqual(['highlight:upsert', 'highlight:delete']);
    expect(entries[0].entity_id).toBe(hl.id);
  });

  it('journals rows rewritten by a PII purge with their true origin', () => {
    const recorder = new SessionRecorder(db, () => true, () => false);
    recorder.saveEventsFromMemory([
      ev({ id: 'e1', data: { prompt: 'email me at alice@example.com' } as TimelineEvent['data'] }),
    ]);
    recorder.recordQA('e1', 's1', { question: 'reach bob@example.com', answer: 'ok', model: null, tokensIn: null, tokensOut: null, latencyMs: null });
    clearLog(db);

    const result = executePurge(db);
    expect(result.redacted).toBeGreaterThan(0);

    const kinds = new Set(log(db).map((e) => e.kind));
    // The rewritten event and qa rows are journaled as upserts.
    expect(kinds.has('event')).toBe(true);
    expect(kinds.has('qa')).toBe(true);
    expect(log(db).every((e) => e.origin_host_id === HOST)).toBe(true);
  });

  it('stamps a new curation row with the local host id via the default trigger', () => {
    const store = new BookmarkStore(db);
    const folder = store.createFolder('Work');
    const row = db.prepare('SELECT host_id FROM bookmark_folders WHERE id = ?').get(folder.id) as { host_id: string };
    expect(row.host_id).toBe(HOST);
  });
});

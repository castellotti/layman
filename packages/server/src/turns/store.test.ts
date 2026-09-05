import { describe, it, expect, beforeEach } from 'vitest';
import { EventStore } from '../events/store.js';
import { TurnStore } from './store.js';
import type { Database } from '../db/database.js';
import type { BookmarkStore } from '../db/bookmarks.js';
import type { TimelineEvent, EventType } from '../events/types.js';

/**
 * better-sqlite3 is a native module with no prebuild for this Node ABI, so the
 * whole suite avoids touching a real database (no existing test does either).
 * This fake implements only the two query shapes TurnStore.resolveId issues —
 * `WHERE col = ?` and `WHERE col >= ? AND col < ?` — with plain JS string
 * comparison, which orders ASCII test fixtures the same way SQLite's BINARY
 * collation does, so prefix matching is genuinely covered.
 */
class FakeDb {
  constructor(private tables: Record<string, Array<Record<string, string>>>) {}

  prepare(sql: string) {
    const table = /FROM (\w+)/.exec(sql)?.[1] ?? '';
    const column = /WHERE (\w+)/.exec(sql)?.[1] ?? '';
    const isRange = sql.includes('>=');
    // Extra columns are whatever follows `<col> AS id, ` in the SELECT list. The
    // session query selects `session_id AS id`, which is the key, not an extra.
    const extra = (/SELECT \w+ AS id, ([\w, ]+) FROM/.exec(sql)?.[1] ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const rows = this.tables[table] ?? [];

    return {
      all: (...params: string[]) => {
        const matches = rows.filter((row) => {
          const value = row[column];
          if (value === undefined) return false;
          if (isRange) {
            const [lower, upper] = params;
            return value >= lower && value < upper;
          }
          return value === params[0];
        });
        return matches.map((row) => {
          const out: Record<string, string> = { id: row[column] };
          for (const col of extra) {
            if (row[col] !== undefined) out[col] = row[col];
          }
          return out;
        });
      },
    };
  }
}

function makeStore(
  tables: Record<string, Array<Record<string, string>>> = {},
  events: TimelineEvent[] = [],
  eventStore = new EventStore(),
): TurnStore {
  const bookmarkStore = { getEventsForSession: () => events } as unknown as BookmarkStore;
  return new TurnStore(new FakeDb(tables) as unknown as Database, eventStore, bookmarkStore);
}

let clock = 0;
function ev(sessionId: string, type: EventType, data: Record<string, unknown> = {}, id?: string): TimelineEvent {
  clock += 10;
  return {
    id: id ?? `${type}-${clock}`,
    type,
    timestamp: clock,
    sessionId,
    agentType: 'claude-code',
    data,
  } as TimelineEvent;
}

describe('TurnStore', () => {
  it('builds turns from recorded events', () => {
    const prompt = ev('s1', 'user_prompt', { prompt: 'do the thing' });
    const tool = ev('s1', 'tool_call_completed', { toolName: 'Bash' });
    const response = ev('s1', 'agent_response', { prompt: 'done' });
    const store = makeStore({}, [prompt, tool, response]);

    const turns = store.listTurns('s1');

    expect(turns).toHaveLength(1);
    expect(turns[0].promptEventId).toBe(prompt.id);
    expect(turns[0].responseEventId).toBe(response.id);
    expect(turns[0].toolCallCount).toBe(1);
  });

  it('falls back to the live event store when nothing is recorded', () => {
    const eventStore = new EventStore();
    eventStore.addRaw(ev('live', 'user_prompt', { prompt: 'hello' }, 'live-p'));
    eventStore.addRaw(ev('live', 'agent_response', { prompt: 'hi' }, 'live-r'));
    eventStore.addRaw(ev('other', 'user_prompt', { prompt: 'unrelated' }, 'other-p'));

    const turns = makeStore({}, [], eventStore).listTurns('live');

    expect(turns).toHaveLength(1);
    expect(turns[0].responseEventId).toBe('live-r');
  });

  it('returns an empty list for an unknown session', () => {
    expect(makeStore().listTurns('nope')).toEqual([]);
  });

  it('serves repeated calls from its memo', () => {
    const events = [ev('s1', 'user_prompt', { prompt: 'first' })];
    const store = makeStore({}, events);

    expect(store.listTurns('s1')).toBe(store.listTurns('s1'));
  });

  it('invalidates the memo when a new event arrives for the session', () => {
    const events = [ev('s1', 'user_prompt', { prompt: 'first' })];
    const eventStore = new EventStore();
    const store = makeStore({}, events, eventStore);

    expect(store.listTurns('s1')).toHaveLength(1);

    events.push(ev('s1', 'user_prompt', { prompt: 'second' }));
    eventStore.emit('event:new', { sessionId: 's1' } as TimelineEvent);

    expect(store.listTurns('s1')).toHaveLength(2);
  });

  it('addresses the same turn by prompt id and by any owned event id', () => {
    const prompt = ev('s1', 'user_prompt', { prompt: 'go' });
    const tool = ev('s1', 'tool_call_completed', { toolName: 'Read' });
    const store = makeStore({}, [prompt, tool]);

    expect(store.getTurn('s1', prompt.id)?.promptEventId).toBe(prompt.id);
    expect(store.getTurnForEvent('s1', tool.id)?.promptEventId).toBe(prompt.id);
    expect(store.getTurn('s1', 'missing')).toBeNull();
  });

  it('resolves a collapsed duplicate prompt id, but not a non-prompt event id', () => {
    const events = [
      { ...ev('s1', 'user_prompt', { prompt: 'go' }, 'p1'), timestamp: 1000 },
      { ...ev('s1', 'user_prompt', { prompt: 'go' }, 'p1-dup'), timestamp: 1010 },
      { ...ev('s1', 'tool_call_completed', { toolName: 'Read' }, 'tool'), timestamp: 1020 },
    ];
    const store = makeStore({}, events);

    expect(store.listTurns('s1')).toHaveLength(1);
    expect(store.getTurn('s1', 'p1-dup')?.promptEventId).toBe('p1');
    expect(store.getTurn('s1', 'tool')).toBeNull();
  });
});

describe('TurnStore.resolveId', () => {
  let store: TurnStore;

  beforeEach(() => {
    store = makeStore({
      recorded_sessions: [{ session_id: 'abcdefgh-unique-session' }],
      recorded_events: [{ id: 'event-abcdefgh-1', session_id: 'sess-xyz' }],
      highlights: [{ id: 'highlight-1234-5678', session_id: 'sess-hl', prompt_event_id: 'prompt-9' }],
      bookmarks: [{ id: 'bookmark-1234-5678', session_id: 'sess-bm' }],
      bookmark_folders: [],
      highlight_folders: [],
    });
  });

  it('resolves a full session id', () => {
    expect(store.resolveId('abcdefgh-unique-session')).toEqual({
      kind: 'session', id: 'abcdefgh-unique-session',
    });
  });

  it('resolves an event id and reports its session', () => {
    expect(store.resolveId('event-abcdefgh-1')).toEqual({
      kind: 'event', id: 'event-abcdefgh-1', sessionId: 'sess-xyz',
    });
  });

  it('resolves an unambiguous prefix of at least 8 characters', () => {
    expect(store.resolveId('abcdefgh')).toEqual({ kind: 'session', id: 'abcdefgh-unique-session' });
    expect(store.resolveId('highlight-12')).toMatchObject({ kind: 'highlight', id: 'highlight-1234-5678' });
  });

  it('reports the session (and turn) a highlight belongs to', () => {
    // /h/:id has to become /s/:sessionId/t/:promptEventId to be navigable.
    expect(store.resolveId('highlight-1234-5678')).toEqual({
      kind: 'highlight', id: 'highlight-1234-5678',
      sessionId: 'sess-hl', promptEventId: 'prompt-9',
    });
  });

  it('reports the session a bookmark belongs to', () => {
    expect(store.resolveId('bookmark-1234-5678')).toEqual({
      kind: 'bookmark', id: 'bookmark-1234-5678', sessionId: 'sess-bm',
    });
  });

  it('reports the origin host of a session/bookmark/highlight when present', () => {
    const withHosts = makeStore({
      recorded_sessions: [{ session_id: 'abcdefgh-remote-sess', host_id: 'remote-host' }],
      bookmarks: [{ id: 'bookmark-remote-1', session_id: 'sess-bm', host_id: 'remote-host' }],
    });
    expect(withHosts.resolveId('abcdefgh-remote-sess')).toEqual({
      kind: 'session', id: 'abcdefgh-remote-sess', hostId: 'remote-host',
    });
    expect(withHosts.resolveId('bookmark-remote-1')).toEqual({
      kind: 'bookmark', id: 'bookmark-remote-1', sessionId: 'sess-bm', hostId: 'remote-host',
    });
  });

  it('rejects prefixes shorter than the minimum', () => {
    expect(store.resolveId('abcdef')).toBeNull();
  });

  it('reports candidates rather than guessing on an ambiguous prefix', () => {
    const ambiguous = makeStore({
      recorded_sessions: [{ session_id: 'abcdefgh-one' }, { session_id: 'abcdefgh-two' }],
    });

    const result = ambiguous.resolveId('abcdefgh');

    expect(result).toHaveProperty('ambiguous', true);
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('treats % and _ as literal characters, not wildcards', () => {
    // Prefix matching is a plain range scan, not LIKE, so these have no special meaning.
    expect(store.resolveId('%')).toBeNull();
    expect(store.resolveId('abcdef%h')).toBeNull();
    expect(store.resolveId('abcdefg_')).toBeNull();
  });

  it('returns null for an empty or unmatched id', () => {
    expect(store.resolveId('')).toBeNull();
    expect(store.resolveId('no-such-id-at-all')).toBeNull();
  });
});

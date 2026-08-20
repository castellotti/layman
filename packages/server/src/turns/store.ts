import type { Database } from '../db/database.js';
import type { BookmarkStore } from '../db/bookmarks.js';
import type { EventStore } from '../events/store.js';
import type { TimelineEvent } from '../events/types.js';
import { extractTurns } from './extract.js';
import type { Turn } from './types.js';

export type ResolvedKind = 'session' | 'event' | 'highlight' | 'bookmark' | 'folder' | 'highlight_folder';

export interface ResolvedId {
  kind: ResolvedKind;
  id: string;
  /** Present for events, bookmarks and highlights — the session a URL needs. */
  sessionId?: string;
  /** Present for highlights — the turn they name, so /h/:id can open that turn. */
  promptEventId?: string;
}

export interface AmbiguousId {
  ambiguous: true;
  candidates: ResolvedId[];
}

/** Minimum prefix length accepted by resolveId — short enough to be readable, long enough to be near-unique. */
export const MIN_ID_PREFIX = 8;

/** Exclusive upper bound for a `col >= prefix AND col < upperBound` range scan over `prefix`. */
function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/**
 * `extra` columns ride along in the SELECT so a resolved id carries everything
 * needed to build a URL for it — a bookmark or highlight is useless to a client
 * without its session.
 */
const RESOLVE_TABLES: Array<{ table: string; column: string; kind: ResolvedKind; extra?: string[] }> = [
  { table: 'recorded_sessions', column: 'session_id', kind: 'session' },
  { table: 'recorded_events', column: 'id', kind: 'event', extra: ['session_id'] },
  { table: 'highlights', column: 'id', kind: 'highlight', extra: ['session_id', 'prompt_event_id'] },
  { table: 'bookmarks', column: 'id', kind: 'bookmark', extra: ['session_id'] },
  { table: 'bookmark_folders', column: 'id', kind: 'folder' },
  { table: 'highlight_folders', column: 'id', kind: 'highlight_folder' },
];

export class TurnStore {
  /** Memo keyed by sessionId → { lastTimestamp, count, turns }. Sessions are append-only. */
  private cache = new Map<string, { lastTimestamp: number; count: number; turns: Turn[] }>();

  constructor(
    private db: Database,
    private eventStore: EventStore,
    private bookmarkStore: BookmarkStore,
  ) {
    // Any new event for a session invalidates its memo.
    this.eventStore.on('event:new', (event: TimelineEvent) => this.cache.delete(event.sessionId));
    this.eventStore.on('event:update', () => this.cache.clear());
  }

  /**
   * Events for a session, preferring the recorded (SQLite) copy because the
   * in-memory EventStore caps at 10,000 events and a long session exceeds it.
   * Falls back to the live store for sessions not yet recorded.
   *
   * Public because callers building on top of a resolved Turn (e.g. the
   * single-turn markdown export route) need the same fallback `getTurn()`
   * already applies internally — going straight to BookmarkStore there would
   * silently return no events for a live, not-yet-persisted session.
   */
  eventsFor(sessionId: string): TimelineEvent[] {
    const recorded = this.bookmarkStore.getEventsForSession(sessionId);
    if (recorded.length > 0) return recorded;
    return this.eventStore.getAll().filter((e) => e.sessionId === sessionId);
  }

  listTurns(sessionId: string): Turn[] {
    const events = this.eventsFor(sessionId);
    if (events.length === 0) return [];

    const lastTimestamp = events[events.length - 1].timestamp;
    const cached = this.cache.get(sessionId);
    if (cached && cached.lastTimestamp === lastTimestamp && cached.count === events.length) {
      return cached.turns;
    }

    const turns = extractTurns(events);
    this.cache.set(sessionId, { lastTimestamp, count: events.length, turns });
    return turns;
  }

  getTurn(sessionId: string, promptEventId: string): Turn | null {
    const turns = this.listTurns(sessionId);
    const exact = turns.find((t) => t.promptEventId === promptEventId);
    if (exact) return exact;

    // A duplicate prompt collapsed by extractTurns is no longer any turn's
    // promptEventId, but links minted before the collapse still name it. Only
    // prompts get this fallback — an arbitrary owned event id is not a turn address.
    const isPrompt = this.eventsFor(sessionId).some(
      (e) => e.id === promptEventId && e.type === 'user_prompt',
    );
    if (!isPrompt) return null;
    return turns.find((t) => t.eventIds.includes(promptEventId)) ?? null;
  }

  /** The turn that owns an arbitrary event, so any event id can be addressed as a turn. */
  getTurnForEvent(sessionId: string, eventId: string): Turn | null {
    return this.listTurns(sessionId).find((t) => t.eventIds.includes(eventId)) ?? null;
  }

  /**
   * Resolves a full id or an unambiguous prefix (>= MIN_ID_PREFIX chars) to the
   * entity it names.  Returns the candidate list rather than guessing when a
   * prefix matches more than one row.
   */
  resolveId(idOrPrefix: string): ResolvedId | AmbiguousId | null {
    if (!idOrPrefix) return null;

    const exact = this.lookup(idOrPrefix, true);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return { ambiguous: true, candidates: exact };

    if (idOrPrefix.length < MIN_ID_PREFIX) return null;

    const prefixed = this.lookup(idOrPrefix, false);
    if (prefixed.length === 0) return null;
    if (prefixed.length === 1) return prefixed[0];
    return { ambiguous: true, candidates: prefixed };
  }

  private lookup(value: string, exact: boolean): ResolvedId[] {
    const results: ResolvedId[] = [];

    for (const { table, column, kind, extra } of RESOLVE_TABLES) {
      const columns = [`${column} AS id`, ...(extra ?? [])].join(', ');
      // Prefix matching uses a plain BINARY range (`>= prefix AND < successor`)
      // rather than `LIKE 'prefix%'`. SQLite's LIKE-to-index-range-scan optimization
      // is disabled by default whenever the pattern contains letters under the
      // default case-insensitive LIKE semantics, which turns every prefix lookup
      // into a full table scan of recorded_events — the largest, unbounded table.
      // A direct range comparison is index-eligible unconditionally.
      const stmt = exact
        ? this.db.prepare(`SELECT ${columns} FROM ${table} WHERE ${column} = ? LIMIT 5`)
        : this.db.prepare(`SELECT ${columns} FROM ${table} WHERE ${column} >= ? AND ${column} < ? LIMIT 5`);

      const rows = (exact ? stmt.all(value) : stmt.all(value, prefixUpperBound(value))) as
        Array<{ id: string; session_id?: string; prompt_event_id?: string }>;
      for (const row of rows) {
        results.push({
          kind,
          id: row.id,
          ...(row.session_id ? { sessionId: row.session_id } : {}),
          ...(row.prompt_event_id ? { promptEventId: row.prompt_event_id } : {}),
        });
      }
    }

    return results;
  }
}

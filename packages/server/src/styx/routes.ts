/**
 * `GET /api/styx/v1/matrix`: the destinations a session reached, in the shape of styx-os's
 * `GET /v1/matrix` (docs/extensions/styx.md). Computed on request from Layman's own records.
 *
 * Asked every two seconds by each open Matrix tab, so it must stay cheap: gloved answers come from
 * `NetStore` (memory), and a standard session's from the in-memory event store. Only a window that
 * reaches before memory begins reads the session's older history from its recording, at most once per
 * `CACHE_MS`, and what is new always comes from memory, so a new host is never held back by the cache.
 */
import type { FastifyInstance } from 'fastify';
import { callsFrom } from '../netobs/correlate.js';
import type { TraceCall } from '../netobs/types.js';
import type { NetStore } from '../netobs/store.js';
import type { TimelineEvent } from '../events/types.js';
import { mergeRows, parseRelative, rowsFromCalls, rowsFromDestinations, rowsFromFlows, type MatrixRow } from './matrix.js';

export interface StyxDeps {
  /** `getConfig().styx.enabled`, read per request: the setting changes at runtime. */
  enabled: () => boolean;
  store: NetStore;
  /** A Layman session's glove id, or null: its sessionName, when the store has that token. */
  gloveTokenOf: (sessionId: string) => string | null;
  sessionExists: (sessionId: string) => boolean;
  /** The session's whole recording. Expensive for a long session: never per poll. */
  events: (sessionId: string) => TimelineEvent[];
  /**
   * The session's events held in memory, and `since`: the time from which memory holds every one of
   * them (when the server started, or the oldest event held once the ring has dropped older ones).
   * Before `since` only the recording knows.
   */
  memory: (sessionId: string) => { events: TimelineEvent[]; since: number };
  /** Layman sessions that are live now and not gloved, for the no-selector answer. */
  liveStandardSessions: () => string[];
  now?: () => number;
}

/** Styx's own absolute-time parameters, which Layman does not take. */
const UNSUPPORTED = ['start_date', 'start_time', 'end_date', 'end_time', 'timezone', 'client'];
const NO_SELECTOR_WINDOW_MS = 15 * 60_000;
/**
 * How long the calls read from a recording are reused. A new host never waits for this: it comes from memory.
 */
const CACHE_MS = 30_000;
/** A window must start this long after `since` for memory alone to answer: a call is recorded slightly before its start time. */
const MEMORY_MARGIN_MS = 5000;

export function registerStyxRoutes(fastify: FastifyInstance, deps: StyxDeps): void {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; calls: TraceCall[] }>();

  /**
   * The session's calls as its recording holds them, read at most once per CACHE_MS. Keyed by session
   * alone: memory's horizon moves once its ring is full, and a key that moved with it would read the
   * recording at every poll. What the recording gained since is in memory, which is read each time.
   */
  const recordedCalls = (sessionId: string, t: number): TraceCall[] => {
    const hit = cache.get(sessionId);
    if (hit && t - hit.at < CACHE_MS) return hit.calls;
    const calls = callsFrom(deps.events(sessionId));
    for (const [k, v] of cache) if (t - v.at > CACHE_MS * 2) cache.delete(k);
    cache.set(sessionId, { at: t, calls });
    return calls;
  };

  const gloved = (token: string, from: number | null, t: number): MatrixRow[] =>
    from === null
      ? rowsFromDestinations(deps.store.destinations(token))
      : rowsFromFlows(deps.store.flowsBetween(token, from, t) ?? []);

  const standard = (sessionId: string, from: number | null, t: number): MatrixRow[] => {
    const mem = deps.memory(sessionId);
    const recent = callsFrom(mem.events);
    // A window memory reaches back to is answered from memory alone: never a recording, per poll.
    if (from !== null && from >= mem.since + MEMORY_MARGIN_MS) return rowsFromCalls(recent, from, t);
    // Otherwise the recording (cached), and everything in memory, which is newer than the cache and wins.
    const seen = new Set(recent.map((c) => c.eventId));
    const calls = [...recordedCalls(sessionId, t).filter((c) => !seen.has(c.eventId)), ...recent];
    return rowsFromCalls(calls, from ?? 0, t);
  };

  fastify.get<{ Querystring: Record<string, string | string[] | undefined> }>('/api/styx/v1/matrix', async (req, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Styx is not enabled' });
    const q = req.query;
    for (const name of UNSUPPORTED) {
      if (q[name] !== undefined) return reply.code(400).send({ error: `${name} is not supported by Layman's Styx feed` });
    }
    const one = (name: string): string | undefined | null => {
      const v = q[name];
      if (v === undefined) return undefined;
      return typeof v === 'string' && v !== '' ? v : null; // null: repeated or empty
    };
    const session = one('session');
    const glove = one('glove');
    const relative = one('relative');
    if (session === null || glove === null || relative === null) return reply.code(400).send({ error: 'Each parameter takes one non-empty value' });
    if (session !== undefined && glove !== undefined) return reply.code(400).send({ error: 'Give session or glove, not both' });
    const windowMs = relative === undefined ? null : parseRelative(relative);
    if (relative !== undefined && windowMs === null) {
      return reply.code(400).send({ error: 'relative is an integer and a unit: 60s, 15m, 1h, 2d' });
    }

    const t = now();
    const selected = session !== undefined || glove !== undefined;
    const span = windowMs ?? (selected ? null : NO_SELECTOR_WINDOW_MS);
    const from = span === null ? null : t - span;

    if (glove !== undefined) {
      if (!deps.store.has(glove)) return reply.code(404).send({ error: 'Unknown glove session' });
      return mergeRows([gloved(glove, from, t)]);
    }
    if (session !== undefined) {
      if (!deps.sessionExists(session)) return reply.code(404).send({ error: 'Unknown session' });
      const token = deps.gloveTokenOf(session);
      return mergeRows([token ? gloved(token, from, t) : standard(session, from, t)]);
    }
    return mergeRows([
      ...deps.store.tokens().filter((k) => deps.store.live(k)).map((k) => gloved(k, from, t)),
      ...deps.liveStandardSessions().map((id) => standard(id, from, t)),
    ]);
  });
}

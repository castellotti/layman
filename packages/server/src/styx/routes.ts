/**
 * `GET /api/styx/v1/matrix`: the destinations a session reached, in the shape of styx-os's
 * `GET /v1/matrix` (docs/extensions/styx.md). Computed on request from Layman's own records.
 *
 * Asked every two seconds by each open Matrix tab, so it must stay cheap: gloved answers come
 * from `NetStore` (memory), a windowed standard answer from the in-memory event store, and only
 * what memory cannot answer reads a whole recording, at most once per `CACHE_MS` per session.
 */
import type { FastifyInstance } from 'fastify';
import { callsFrom } from '../netobs/correlate.js';
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
  /** The session's events from `from` on, from memory; null when memory does not reach back that far. */
  recentEvents: (sessionId: string, from: number) => TimelineEvent[] | null;
  /** Layman sessions that are live now and not gloved, for the no-selector answer. */
  liveStandardSessions: () => string[];
  now?: () => number;
}

/** Styx's own absolute-time parameters, which Layman does not take. */
const UNSUPPORTED = ['start_date', 'start_time', 'end_date', 'end_time', 'timezone', 'client'];
const NO_SELECTOR_WINDOW_MS = 15 * 60_000;
/** How long a recording-backed answer is reused. */
const CACHE_MS = 5000;
const CACHE_DROP_MS = 60_000;

export function registerStyxRoutes(fastify: FastifyInstance, deps: StyxDeps): void {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; rows: MatrixRow[] }>();

  /** `compute` at most once per CACHE_MS for `key`. */
  const cached = (key: string, t: number, compute: () => MatrixRow[]): MatrixRow[] => {
    const hit = cache.get(key);
    if (hit && t - hit.at < CACHE_MS) return hit.rows;
    const rows = compute();
    for (const [k, v] of cache) if (t - v.at > CACHE_DROP_MS) cache.delete(k);
    cache.set(key, { at: t, rows });
    return rows;
  };

  const gloved = (token: string, from: number | null, t: number): MatrixRow[] =>
    from === null
      ? rowsFromDestinations(deps.store.destinations(token))
      : rowsFromFlows(deps.store.flowsBetween(token, from, t) ?? []);

  const standard = (sessionId: string, from: number | null, t: number): MatrixRow[] => {
    if (from !== null) {
      const recent = deps.recentEvents(sessionId, from);
      if (recent) return rowsFromCalls(callsFrom(recent), from, t);
    }
    return cached(`${sessionId}|${from === null ? 'all' : t - from}`, t, () =>
      rowsFromCalls(callsFrom(deps.events(sessionId)), from ?? 0, t));
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

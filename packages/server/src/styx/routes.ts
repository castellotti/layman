/**
 * `GET /api/styx/v1/matrix`: the destinations a session reached, in the shape of styx-os's
 * `GET /v1/matrix` (docs/extensions/styx.md). Computed on request from Layman's own records.
 *
 * Asked every two seconds by each open Matrix tab, so it must stay cheap: gloved answers come from
 * `NetStore` (memory), and a standard session's from the in-memory event store. Only a window that
 * reaches before memory begins reads the session's older history from its recording, at most once per
 * `CACHE_MS`, and what is new always comes from memory, so a new host is never held back by the cache.
 */
import { createReadStream, statSync } from 'fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GODOT_CSP, godotBuildStatus, insideFolder, resolveGodotFile } from './godot.js';
import { callsFrom } from '../netobs/correlate.js';
import type { FlowView, TraceCall } from '../netobs/types.js';
import type { NetStore } from '../netobs/store.js';
import type { TimelineEvent } from '../events/types.js';
import {
  hostsFromCalls, hostsFromDestinations, hostsFromFlows, linksFromCalls, linksFromFlows, logFromCalls, logFromFlows,
  mergeHosts, mergeLinks, mergeLog, parseLimit,
} from './gibson.js';
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
  /** Where the styx-godot web export is, expanded (`styx.godotDir`, or the default inside Layman's data folder). */
  godotDir: () => string;
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

type FeedQuery = Record<string, string | string[] | undefined>;
type FeedRequest = FastifyRequest<{ Querystring: FeedQuery }>;

/** Where one request's rows come from. */
type Source = { kind: 'glove'; token: string } | { kind: 'standard'; sessionId: string };
interface Selection { sources: Source[]; from: number | null; t: number }

/** One query value: undefined when absent, null when repeated or empty. */
const one = (q: FeedQuery, name: string): string | undefined | null => {
  const v = q[name];
  if (v === undefined) return undefined;
  return typeof v === 'string' && v !== '' ? v : null;
};

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

  /**
   * A standard session's tool calls for a window: memory alone when it reaches back far enough, else the
   * cached recording merged with memory. `from` is where the calls are cut (0 for the whole record).
   */
  const standardCalls = (sessionId: string, from: number | null, t: number): { calls: TraceCall[]; from: number } => {
    const mem = deps.memory(sessionId);
    const recent = callsFrom(mem.events);
    // A window memory reaches back to is answered from memory alone: never a recording, per poll.
    if (from !== null && from >= mem.since + MEMORY_MARGIN_MS) return { calls: recent, from };
    // Otherwise the recording (cached), and everything in memory, which is newer than the cache and wins.
    const seen = new Set(recent.map((c) => c.eventId));
    return { calls: [...recordedCalls(sessionId, t).filter((c) => !seen.has(c.eventId)), ...recent], from: from ?? 0 };
  };

  const standard = (sessionId: string, from: number | null, t: number): MatrixRow[] => {
    const c = standardCalls(sessionId, from, t);
    return rowsFromCalls(c.calls, c.from, t);
  };

  /**
   * Validates a feed request's query, as `/v1/matrix` always has, and says where its rows come from.
   * Sends the error and returns null when the query is bad. Other parameters (`host`, `limit`) are left alone.
   */
  const select = (req: FeedRequest, reply: FastifyReply): Selection | null => {
    const q = req.query;
    for (const name of UNSUPPORTED) {
      if (q[name] !== undefined) { reply.code(400).send({ error: `${name} is not supported by Layman's Styx feed` }); return null; }
    }
    const session = one(q, 'session');
    const glove = one(q, 'glove');
    const relative = one(q, 'relative');
    if (session === null || glove === null || relative === null) { reply.code(400).send({ error: 'Each parameter takes one non-empty value' }); return null; }
    if (session !== undefined && glove !== undefined) { reply.code(400).send({ error: 'Give session or glove, not both' }); return null; }
    const windowMs = relative === undefined ? null : parseRelative(relative);
    if (relative !== undefined && windowMs === null) {
      reply.code(400).send({ error: 'relative is an integer and a unit: 60s, 15m, 1h, 2d' });
      return null;
    }

    const t = now();
    const selected = session !== undefined || glove !== undefined;
    const span = windowMs ?? (selected ? null : NO_SELECTOR_WINDOW_MS);
    const from = span === null ? null : t - span;

    if (glove !== undefined) {
      if (!deps.store.has(glove)) { reply.code(404).send({ error: 'Unknown glove session' }); return null; }
      return { sources: [{ kind: 'glove', token: glove }], from, t };
    }
    if (session !== undefined) {
      // A glove session before its first prompt has no Layman session yet (pi writes its transcript then),
      // so a glove id is taken here too: styx-godot forwards only `session`, and the views show such a glove
      // from the start. A Layman session id wins: the two never look alike (a uuid, `<dirname>-<6 hex>`).
      if (!deps.sessionExists(session)) {
        if (deps.store.has(session)) return { sources: [{ kind: 'glove', token: session }], from, t };
        reply.code(404).send({ error: 'Unknown session' });
        return null;
      }
      const token = deps.gloveTokenOf(session);
      return { sources: [token ? { kind: 'glove', token } : { kind: 'standard', sessionId: session }], from, t };
    }
    return {
      sources: [
        ...deps.store.tokens().filter((k) => deps.store.live(k)).map((k): Source => ({ kind: 'glove', token: k })),
        ...deps.liveStandardSessions().map((id): Source => ({ kind: 'standard', sessionId: id })),
      ],
      from,
      t,
    };
  };

  // The build's files. A real 404 for anything missing: the SPA fallback must never answer for this prefix.
  fastify.get('/styx/godot/*', async (req, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Styx is not enabled' });
    const dir = deps.godotDir();
    const hit = resolveGodotFile(dir, req.url);
    let mtime: Date | null = null;
    let size = 0;
    if (hit && insideFolder(dir, hit.file)) {
      try {
        const st = statSync(hit.file);
        if (st.isFile()) { mtime = new Date(Math.floor(st.mtimeMs / 1000) * 1000); size = st.size; }
      } catch { /* missing */ }
    }
    if (!hit || !mtime) return reply.code(404).send({ error: 'Not found' });
    reply.header('Content-Security-Policy', GODOT_CSP).header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'no-cache').header('Last-Modified', mtime.toUTCString());
    const since = Date.parse(String(req.headers['if-modified-since'] ?? ''));
    if (!Number.isNaN(since) && mtime.getTime() <= since) return reply.code(304).send();
    // A length lets the loader show progress for the 35 MB wasm; a file replaced mid-request ends the
    // connection rather than quietly truncating.
    const stream = createReadStream(hit.file);
    stream.on('error', () => reply.raw.destroy());
    return reply.type(hit.type).header('Content-Length', size).send(stream);
  });

  fastify.get('/api/styx/godot/status', async (_req, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Styx is not enabled' });
    return godotBuildStatus(deps.godotDir());
  });

  /** A feed route: the enabled check and the query's selection, then `build`. */
  const feed = (path: string, build: (sel: Selection) => unknown): void => {
    fastify.get<{ Querystring: FeedQuery }>(path, async (req, reply) => {
      if (!deps.enabled()) return reply.code(404).send({ error: 'Styx is not enabled' });
      const sel = select(req, reply);
      if (!sel) return reply;
      return build(sel);
    });
  };

  /** A standard session's calls for the selection's window, turned into rows by `rows(calls, from)`. */
  const fromStandard = <T>(sessionId: string, sel: Selection, rows: (calls: TraceCall[], from: number) => T): T => {
    const c = standardCalls(sessionId, sel.from, sel.t);
    return rows(c.calls, c.from);
  };

  feed('/api/styx/v1/matrix', (sel) =>
    mergeRows(sel.sources.map((s) => (s.kind === 'glove' ? gloved(s.token, sel.from, sel.t) : standard(s.sessionId, sel.from, sel.t)))));

  /** Glove's connections for the window (the whole record when `from` is null): the one source of links and the log. */
  const flowsOf = (token: string, from: number | null, t: number): FlowView[] => deps.store.flowsBetween(token, from ?? 0, t) ?? [];

  feed('/api/styx/v1/hosts', (sel) =>
    mergeHosts(sel.sources.map((s) => {
      if (s.kind === 'standard') return fromStandard(s.sessionId, sel, (calls, from) => hostsFromCalls(calls, from, sel.t, sel.t));
      // Whole record: glove's running totals, which outlive the connections memory holds.
      return sel.from === null ? hostsFromDestinations(deps.store.destinations(s.token), sel.t) : hostsFromFlows(flowsOf(s.token, sel.from, sel.t), sel.t);
    })));

  feed('/api/styx/v1/links', (sel) =>
    mergeLinks(sel.sources.map((s) =>
      s.kind === 'standard'
        ? fromStandard(s.sessionId, sel, (calls, from) => linksFromCalls(calls, from, sel.t, sel.t))
        : linksFromFlows(flowsOf(s.token, sel.from, sel.t), sel.t))));

  fastify.get<{ Querystring: FeedQuery }>('/api/styx/v1/flows', async (req, reply) => {
    if (!deps.enabled()) return reply.code(404).send({ error: 'Styx is not enabled' });
    const host = one(req.query, 'host');
    if (host === null) return reply.code(400).send({ error: 'Each parameter takes one non-empty value' });
    const rawLimit = req.query.limit;
    const limit = parseLimit(typeof rawLimit === 'string' || rawLimit === undefined ? rawLimit : '');
    if (limit === null) return reply.code(400).send({ error: 'limit is an integer from 1 to 500' });
    const sel = select(req, reply);
    if (!sel) return reply;
    const want = host?.toLowerCase();
    return mergeLog(sel.sources.map((s) =>
      s.kind === 'standard'
        ? fromStandard(s.sessionId, sel, (calls, from) => logFromCalls(calls, from, sel.t, sel.t, want))
        : logFromFlows(flowsOf(s.token, sel.from, sel.t), sel.t, want)), limit);
  });
}

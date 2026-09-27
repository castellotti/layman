/**
 * One turn's trace for the Trace tab: the Layman sessions a glove
 * session belongs to, their turns, and the chosen turn's tool calls joined to
 * the flows it made (`correlate.ts`).
 *
 * A glove session's Layman sessions are those whose `sessionName` is its token
 * (`GloveSource` labels them so); one glove session can hold several harness
 * runs. Their events come through `TurnStore`, which reads SQLite and falls
 * back to the live store, so long sessions work. Dependencies are injected so
 * this is tested without a database.
 */
import type { TimelineEvent } from '../events/types.js';
import type { Turn } from '../turns/types.js';
import { callsFrom, correlate, JOIN_BEFORE_MS } from './correlate.js';
import type { NetStore } from './store.js';
import type { TraceCall, TraceCounts, TraceNav, TraceTurn, TraceView } from './types.js';

export interface TraceDeps {
  /** Layman session ids whose `sessionName` is this token. */
  sessionsNamed(token: string): string[];
  /** A session's turns and the events they were built from, from one read (a long session is a big one). */
  session(sessionId: string): { turns: Turn[]; events: TimelineEvent[] };
  events(sessionId: string): TimelineEvent[];
}

/** Turns this far outside the glove session's records are another run's, not this one's. */
const SPAN_MARGIN_MS = 5 * 60_000;
/** A prompt read by a passive watcher is stamped up to a poll late: start the turn's window this much earlier. */
const READ_LAG_MS = 3000;
const PROMPT_PREVIEW = 400;

interface TurnAt { turn: Turn; start: number; exact: boolean }

/** Which turn: by a prompt (or any) event id, the one in progress at a moment, or the latest. */
export type TraceSelect = { turn: string } | { at: number } | null;

export function buildTrace(store: NetStore, token: string, deps: TraceDeps, select: TraceSelect, now = Date.now()): TraceView | null {
  if (!store.has(token)) return null;
  const sessionIds = deps.sessionsNamed(token);
  const span = store.span(token);
  const events = new Map<string, Map<string, TimelineEvent>>();
  const all: TurnAt[] = [];
  for (const sid of sessionIds) {
    const session = deps.session(sid);
    const byId = new Map(session.events.map((e) => [e.id, e]));
    events.set(sid, byId);
    for (const turn of session.turns) {
      const prompt = byId.get(turn.promptEventId);
      const at = prompt?.data.transcriptAt;
      const start = typeof at === 'number' ? at : turn.startedAt;
      if (span && (start < span.first - SPAN_MARGIN_MS || start > span.last + SPAN_MARGIN_MS)) continue;
      all.push({ turn, start, exact: typeof at === 'number' });
    }
  }
  all.sort((a, b) => a.start - b.start);
  const view = (t: TurnAt): TraceTurn => ({
    sessionId: t.turn.sessionId, promptEventId: t.turn.promptEventId, responseEventId: t.turn.responseEventId, index: t.turn.index,
    startedAt: t.start, promptText: t.turn.promptText.slice(0, PROMPT_PREVIEW), toolCallCount: t.turn.toolCallCount,
  });
  const empty: TraceCounts = { calls: 0, flows: 0, refused: 0, blocked: 0, bytesUp: 0, bytesDown: 0 };
  // Only the neighbours, not the list: the tab polls, and a long session has thousands of turns.
  const nav = (j: number): TraceNav => ({
    index: j, count: all.length,
    prev: j > 0 ? all[j - 1].turn.promptEventId : null,
    next: j >= 0 && j < all.length - 1 ? all[j + 1].turn.promptEventId : null,
  });
  const windowStart = (t: TurnAt) => t.start - (t.exact ? JOIN_BEFORE_MS : READ_LAG_MS);
  let i: number;
  if (select === null) i = all.length - 1;
  else if ('turn' in select) i = all.findIndex((t) => t.turn.promptEventId === select.turn || t.turn.eventIds.includes(select.turn));
  else {
    i = -1;
    for (let j = 0; j < all.length && windowStart(all[j]) <= select.at; j++) i = j;
  }
  const base = { token, sessionIds, nav: nav(i) };
  if (i < 0) return { ...base, turn: null, window: null, items: [], unattributed: [], flows: [], counts: empty };

  const cur = all[i];
  // The turn owns the flows from its prompt until the next prompt of any of the glove session's runs.
  const from = windowStart(cur);
  const next = all[i + 1];
  const to = next ? windowStart(next) : Math.max(now, span?.last ?? now);
  const byId = events.get(cur.turn.sessionId)!;
  const turnEvents = cur.turn.eventIds.map((id) => byId.get(id)).filter((e): e is TimelineEvent => !!e);
  const calls = callsFrom(turnEvents);
  const flows = store.flowsBetween(token, from, to) ?? [];
  const services = store.sessionFile(token)?.services ?? [];
  const earlier = store.flowsOpenAt(token, from) ?? [];
  const { items, unattributed } = correlate({ calls, flows, earlier, services, from });
  // Name what `openIds` point at: the view's flows are the turn's own plus those still open from before it.
  const named = new Set(items.flatMap((i) => (i.kind === 'call' ? i.openIds : [])));
  const shown = [...flows, ...earlier.filter((f) => named.has(f.id))];

  const counts: TraceCounts = { ...empty, calls: calls.length, flows: flows.length };
  for (const f of flows) {
    counts.bytesUp += f.bytes.up;
    counts.bytesDown += f.bytes.down;
    if (f.state === 'guard') counts.refused++;
    else if (f.state === 'user_rule' || f.state === 'default_block') counts.blocked++;
  }
  return { ...base, turn: view(cur), window: { from, to }, items, unattributed, flows: shown, counts };
}

/** Every tool call of the glove session's Layman sessions that started in [from, to]: the Map ribbon's markers. */
export function callsBetween(store: NetStore, token: string, deps: TraceDeps, from: number, to: number): TraceCall[] | null {
  if (!store.has(token)) return null;
  return deps.sessionsNamed(token)
    .flatMap((sid) => callsFrom(deps.events(sid)))
    .filter((c) => c.start >= from && c.start <= to)
    .sort((a, b) => a.start - b.start);
}

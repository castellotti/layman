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
import { getEffectiveAgentContent } from '../events/agent-content.js';
import type { TimelineEvent } from '../events/types.js';
import type { Turn } from '../turns/types.js';
import { callsFrom, correlate, JOIN_BEFORE_MS } from './correlate.js';
import type { NetStore } from './store.js';
import type { FlowView, GateCallJoin, GateTraffic, GateLooseFlow, NetRange, NetService, SessionDownload, TraceCall, TraceCounts, TraceNav, TraceTurn, TraceView } from './types.js';

export interface TraceDeps {
  /** Layman session ids whose `sessionName` is this token. */
  sessionsNamed(token: string): string[];
  /** A session's turns and the events they were built from, from one read (a long session is a big one). */
  session(sessionId: string): { turns: Turn[]; events: TimelineEvent[] };
  events(sessionId: string): TimelineEvent[];
}

/** Turns this far outside the glove session's records are another run's, not this one's. */
const SPAN_MARGIN_MS = 5 * 60_000;
/** A prompt read by a passive watcher is stamped up to a poll late: start the turn's window this much earlier (web: `TURN_READ_LEAD_MS`). */
const READ_LAG_MS = 3000;
const PROMPT_PREVIEW = 400;

interface TurnAt { turn: Turn; start: number; exact: boolean; last: boolean }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const doneAt = (e: TimelineEvent) => num(e.data.transcriptCompletedAt) ?? num(e.data.transcriptAt) ?? e.timestamp;
const closes = (e: TimelineEvent) => e.type === 'agent_stop' || e.type === 'session_end' || e.type === 'stop_failure'
  || (e.type === 'agent_response' && getEffectiveAgentContent(e).response.trim() !== '');
const TOOL = /^tool_call_/;
/** Whether something closes the turn after its last tool call: its last event can be a note after the answer. */
const closed = (owned: readonly TimelineEvent[]) => {
  let i = owned.length - 1;
  while (i > 0 && !TOOL.test(owned[i].type)) { if (closes(owned[i])) return true; i--; }
  return false;
};
/** The events whose finishing ends a turn: not a session's end, which can come hours later. */
const ending = (owned: readonly TimelineEvent[]) => owned.filter((e, i) => i === 0 || e.type !== 'session_end');

/**
 * When a turn's last event finished, or null while it runs (the last turn of a live session that
 * nothing closed after its last tool call). The end of "Network for this turn": mirrors `turnSpan`
 * in packages/web/src/lib/turn-range.ts, which the transcript and Prompts use; change both or neither.
 * `live` is the glove gate's on both sides, and `last` the last turn of its Layman session.
 */
export function turnEnd(owned: readonly TimelineEvent[], { last, live }: { last: boolean; live: boolean }): number | null {
  if (!owned.length || (last && live && !closed(owned))) return null;
  return Math.max(...ending(owned).map(doneAt));
}

/** Which turn: by a prompt (or any) event id, the one in progress at a moment, or the latest. */
export type TraceSelect = { turn: string } | { at: number } | null;

/** The window a turn's flows are joined in starts this much before its prompt. */
const windowStart = (t: TurnAt) => t.start - (t.exact ? JOIN_BEFORE_MS : READ_LAG_MS);

/** Every turn of the glove session's Layman sessions within its records, oldest first, and their events by id. */
function turnsOf(store: NetStore, token: string, deps: TraceDeps, sessionIds: readonly string[]): { all: TurnAt[]; events: Map<string, Map<string, TimelineEvent>> } {
  const span = store.span(token);
  const events = new Map<string, Map<string, TimelineEvent>>();
  const all: TurnAt[] = [];
  for (const sid of sessionIds) {
    const session = deps.session(sid);
    const byId = new Map(session.events.map((e) => [e.id, e]));
    events.set(sid, byId);
    session.turns.forEach((turn, i) => {
      const prompt = byId.get(turn.promptEventId);
      const at = prompt?.data.transcriptAt;
      const start = typeof at === 'number' ? at : turn.startedAt;
      if (span && (start < span.first - SPAN_MARGIN_MS || start > span.last + SPAN_MARGIN_MS)) return;
      all.push({ turn, start, exact: typeof at === 'number', last: i === session.turns.length - 1 });
    });
  }
  all.sort((a, b) => a.start - b.start);
  return { all, events };
}

/**
 * Turn `i`'s calls joined to its flows. The turn owns the flows from its prompt until the next
 * prompt of any of the glove session's runs (or now, for the last).
 */
function joinTurn(store: NetStore, token: string, all: readonly TurnAt[], i: number, owned: readonly TimelineEvent[], now: number, span = store.span(token)) {
  const from = windowStart(all[i]);
  const next = all[i + 1];
  const to = next ? windowStart(next) : Math.max(now, span?.last ?? now);
  const calls = callsFrom(owned);
  const flows = store.flowsBetween(token, from, to) ?? [];
  const services = store.sessionFile(token)?.services ?? [];
  const earlier = store.flowsOpenAt(token, from) ?? [];
  return { from, to, calls, flows, earlier, services, ...correlate({ calls, flows, earlier, services, from }) };
}

/**
 * With a `range`, the turns counted and stepped through are those that began in it, and the
 * latest is the range's latest; a turn asked for by id is still shown when it began outside
 * (`nav.outside`), its arrows leading to the range's nearest turns. Which flows a turn owns
 * does not change: its window still ends at the next prompt, in the range or not.
 */
export function buildTrace(store: NetStore, token: string, deps: TraceDeps, select: TraceSelect, now = Date.now(), range: NetRange | null = null): TraceView | null {
  if (!store.has(token)) return null;
  const sessionIds = deps.sessionsNamed(token);
  const span = store.span(token);
  const { all, events } = turnsOf(store, token, deps, sessionIds);
  const live = store.live(token);
  const ownedBy = (t: TurnAt) => t.turn.eventIds.map((id) => events.get(t.turn.sessionId)?.get(id)).filter((e): e is TimelineEvent => !!e);
  const view = (t: TurnAt): TraceTurn => ({
    sessionId: t.turn.sessionId, promptEventId: t.turn.promptEventId, responseEventId: t.turn.responseEventId, index: t.turn.index,
    startedAt: t.start, promptText: t.turn.promptText.slice(0, PROMPT_PREVIEW), toolCallCount: t.turn.toolCallCount,
    endedAt: turnEnd(ownedBy(t), { last: t.last, live }), exact: t.exact,
  });
  const empty: TraceCounts = { calls: 0, flows: 0, refused: 0, blocked: 0, bytesUp: 0, bytesDown: 0 };
  const listed = range ? all.filter((t) => t.start >= range.from && (range.to === null || t.start <= range.to)) : all;
  // Only the neighbours, not the list: the tab polls, and a long session has thousands of turns.
  const nav = (i: number): TraceNav => {
    const j = i < 0 ? -1 : listed.indexOf(all[i]);
    if (j >= 0 || i < 0) {
      return {
        index: j, count: listed.length,
        prev: j > 0 ? listed[j - 1].turn.promptEventId : null,
        next: j >= 0 && j < listed.length - 1 ? listed[j + 1].turn.promptEventId : null,
      };
    }
    const start = all[i].start;
    return {
      index: -1, count: listed.length, outside: true,
      prev: listed.filter((t) => t.start < start).at(-1)?.turn.promptEventId ?? null,
      next: listed.find((t) => t.start > start)?.turn.promptEventId ?? null,
    };
  };
  let i: number;
  if (select === null) i = listed.length ? all.indexOf(listed[listed.length - 1]) : -1;
  else if ('turn' in select) i = all.findIndex((t) => t.turn.promptEventId === select.turn || t.turn.eventIds.includes(select.turn));
  else {
    i = -1;
    for (let j = 0; j < all.length && windowStart(all[j]) <= select.at; j++) i = j;
  }
  const base = { token, sessionIds, nav: nav(i) };
  if (i < 0) return { ...base, turn: null, window: null, items: [], unattributed: [], flows: [], counts: empty };

  const cur = all[i];
  const { from, to, calls, flows, earlier, items, unattributed } = joinTurn(store, token, all, i, ownedBy(cur), now, span);
  // Name what `openIds` point at: the view's flows are the turn's own plus those still open from before it.
  const named = new Set(items.flatMap((i) => (i.kind === 'call' ? i.openIds : [])));
  const shown = [...flows, ...earlier.filter((f) => named.has(f.id))];

  const counts: TraceCounts = { ...empty, calls: calls.length, flows: flows.length };
  for (const f of flows) {
    // A hop's bytes are its next leg's too (the llm hop to llm-auth): counted once, as the session totals do.
    if (!f.flags.hop) {
      counts.bytesUp += f.bytes.up;
      counts.bytesDown += f.bytes.down;
    }
    if (f.state === 'guard') counts.refused++;
    else if (f.state === 'user_rule' || f.state === 'default_block') counts.blocked++;
  }
  return { ...base, turn: view(cur), window: { from, to }, items, unattributed, flows: shown, counts };
}

/**
 * Every file a `web_download` call of the glove session reported saved, oldest first: read from
 * the results Layman already recorded, never from the sandbox. `web_download_status` repeats a
 * finished job, so a file is listed once, under the first call that reported it.
 */
export function downloadsIn(store: NetStore, token: string, deps: TraceDeps): SessionDownload[] | null {
  const calls = callsBetween(store, token, deps, -Infinity, Infinity);
  if (!calls) return null;
  const seen = new Set<string>();
  const out: SessionDownload[] = [];
  for (const c of calls) {
    for (const d of c.downloads) {
      const key = `${d.path}\n${d.sha256 ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...d, eventId: c.eventId, sessionId: c.sessionId, toolName: c.toolName, url: c.kind === 'fetch' && c.targets.length ? c.label : null, at: c.start });
    }
  }
  return out;
}

/** Every tool call of the glove session's Layman sessions that started in [from, to]: the Map ribbon's markers. */
export function callsBetween(store: NetStore, token: string, deps: TraceDeps, from: number, to: number): TraceCall[] | null {
  if (!store.has(token)) return null;
  return deps.sessionsNamed(token)
    .flatMap((sid) => callsFrom(deps.events(sid)))
    .filter((c) => c.start >= from && c.start <= to)
    .sort((a, b) => a.start - b.start);
}

/** How far back a flow no call claimed is still drawn on the Activity map. */
export const LOOSE_FLOW_MS = 60_000;

const REFUSED = new Set(['guard', 'user_rule', 'default_block']);
/** Tool egress: a gate that goes out on the agent's behalf (`harness: false`), or SearXNG's fan-out. */
const isEgress = (f: FlowView, services: readonly NetService[]) =>
  f.flags.fanout || services.find((s) => s.service === f.service)?.harness === false;

/**
 * One Layman session's tool calls joined to the flows they made, turn by turn, by the same join
 * Trace shows (`joinTurn`, `correlate`), for the Activity map's gate stations; and the flows of the
 * last minute that no call claimed. Only turns whose window still has flows in memory are joined:
 * an older call has nothing to join (the web places it by its tool, or on Network). With a `range`
 * (a turn's span, the web's `turnRange`), only calls that started in it, and every flow in it no
 * call claimed rather than the last minute's.
 */
export function sessionJoins(store: NetStore, token: string, deps: TraceDeps, sessionId: string, now = Date.now(), range: NetRange | null = null): { calls: GateCallJoin[]; loose: GateLooseFlow[] } {
  const sessionIds = deps.sessionsNamed(token);
  if (!sessionIds.includes(sessionId)) return { calls: [], loose: [] };
  const oldest = store.flows(token, 0, 1)?.[0]?.tOpen;
  if (oldest === undefined) return { calls: [], loose: [] };
  const { all, events } = turnsOf(store, token, deps, sessionIds);
  const byId = events.get(sessionId)!;
  const span = store.span(token);
  const calls: GateCallJoin[] = [];
  const loose: GateLooseFlow[] = [];
  const inRange = (t: number) => !range || (t >= range.from && t <= (range.to ?? now));
  all.forEach((t, i) => {
    if (t.turn.sessionId !== sessionId) return;
    // A window that ends before the oldest flow in memory has nothing to join.
    const next = all[i + 1];
    if (next && windowStart(next) < oldest) return;
    // With a range, a turn whose window cannot hold a call that started in it is not joined.
    if (range && (windowStart(t) > (range.to ?? now) || (next && windowStart(next) < range.from))) return;
    const owned = t.turn.eventIds.map((id) => byId.get(id)).filter((e): e is TimelineEvent => !!e);
    const { flows, earlier, services, items, unattributed } = joinTurn(store, token, all, i, owned, now, span);
    const flow = new Map([...flows, ...earlier].map((f) => [f.id, f]));
    for (const item of items) {
      if (item.kind !== 'call' || !inRange(item.call.start)) continue;
      const mine = [...item.flowIds, ...item.fanoutIds, ...item.openIds].flatMap((id) => flow.get(id) ?? []);
      if (!mine.length) continue;
      calls.push({
        eventId: item.call.eventId,
        services: [...new Set(mine.map((f) => f.service))],
        refused: mine.filter((f) => REFUSED.has(f.state)).length,
        egress: mine.filter((f) => isEgress(f, services)).length,
      });
    }
    for (const id of unattributed) {
      const f = flow.get(id);
      if (!f || (range ? !inRange(f.tOpen) : f.tOpen < now - LOOSE_FLOW_MS)) continue;
      loose.push({ service: f.service, t: f.tOpen, refused: REFUSED.has(f.state), egress: isEgress(f, services) });
    }
  });
  return { calls, loose };
}

/**
 * Flows as the gate stations' destinations, one per destination key: a turn's traffic (what
 * opened in its span), counted as All records counts it, a hop once, at its next leg (`flags.hop`).
 */
export function trafficOf(flows: readonly FlowView[]): GateTraffic[] {
  const out = new Map<string, GateTraffic>();
  for (const f of flows) {
    const key = f.destKey ?? f.id;
    const d = out.get(key) ?? { services: [], bytesUp: 0, bytesDown: 0, flows: 0, blocked: 0, scope: f.scope, flags: { hop: f.flags.hop, vpn: f.flags.vpn } };
    // A destination is a hop only if every flow to it was; a route is kept once any flow had one.
    d.flags.hop = d.flags.hop && f.flags.hop;
    d.flags.vpn = d.flags.vpn ?? f.flags.vpn;
    if (!d.services.includes(f.service)) d.services.push(f.service);
    d.bytesUp += f.bytes.up;
    d.bytesDown += f.bytes.down;
    d.flows++;
    if (REFUSED.has(f.state)) d.blocked++;
    out.set(key, d);
  }
  return [...out.values()];
}

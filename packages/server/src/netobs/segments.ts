/**
 * Ready-made time ranges for a glove session (`GET /api/net/sessions/:token/segments`):
 * its runs, its bursts of activity, and its agent sessions, plus the hourly activity a
 * calendar or timeline draws. Pure: built from the store's kept time axis
 * (`HistoryHour`, `HistoryRun`), so it covers what glove has since deleted.
 *
 * - A **run** is one `glove up` to its `glove down`: the collector's start and stop
 *   records. One with no stop ends where the next starts (the collector died and its
 *   stop was never written), or runs on if it is the last and the gate is running. Its
 *   totals are its hours', so they cannot disagree with the hours or the bursts. Traffic
 *   recorded while no run was up (between runs) belongs to none.
 * - A **burst** is the agent at work: model calls (`tool: llm`) with no pause of `gapMs`
 *   or more (default 6 h), inside one run. A gate left up for days holds several daily
 *   jobs, which a run alone lumps together. It is model calls, not any traffic, because
 *   a sandbox is never quiet: on a real session the headless browser's sidecar kept up
 *   ~550 connections an hour between jobs, with its telemetry, so no 6 h gap ever came.
 *   A session with no model calls observed (a model the gate does not carry) falls back
 *   to all traffic (`burstBasis`). Edges are exact (the hours keep their first and last
 *   active record, per run); totals are the whole hours the burst spans, all traffic.
 * - An **agent session** is a Layman session named after the glove session (as Trace
 *   joins them), from its first to its last event, by transcript time where kept.
 */
import type { TimelineEvent } from '../events/types.js';
import type { HistoryHour, HistoryRun } from './history.js';

export const DEFAULT_BURST_GAP_MS = 6 * 60 * 60_000;

export interface RunSegment {
  run: string;
  from: number;
  /** Null while it runs. */
  to: number | null;
  /** How it ended: glove down, the collector's inferred stop, the next run starting, or not yet. */
  end: 'stopped' | 'died' | 'replaced' | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
}

export interface BurstSegment {
  from: number;
  to: number;
  /** The run it is in, or null for records from before any collector run (an older gate). */
  run: string | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
}

export interface AgentSegment {
  sessionId: string;
  from: number;
  to: number;
  turns: number;
  /** Times from the transcript; false when only read times were kept, which can lag. */
  exact: boolean;
}

/** One hour of the session's activity, its hops' bytes left out (counted at the next leg). */
export interface HourActivity {
  hour: number;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  blocked: number;
  first: number;
  last: number;
  /** The agent called its model in this hour. */
  inference: boolean;
}

export interface NetSegments {
  token: string;
  gapMs: number;
  /** What bursts were found from: model calls, or (with none observed) all traffic. */
  burstBasis: 'inference' | 'traffic';
  runs: RunSegment[];
  bursts: BurstSegment[];
  agentSessions: AgentSegment[];
  hours: HourActivity[];
}

/** One run's traffic in one hour, its destinations together. */
interface RunHour {
  hour: number;
  run: string | null;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  blocked: number;
  first: number;
  last: number;
  /** First and last model call in the hour, or null for none. */
  llm: { first: number; last: number } | null;
}

/** Add an hour row. A hop's bytes and flows are the next leg's too, so they count there, not here. */
function add(into: { bytesUp: number; bytesDown: number; flows: number; blocked: number; first: number; last: number }, h: HistoryHour): void {
  if (!h.hop) {
    into.bytesUp += h.bytesUp;
    into.bytesDown += h.bytesDown;
    into.flows += h.flows;
  }
  into.blocked += h.blocked;
  into.first = Math.min(into.first, h.first);
  into.last = Math.max(into.last, h.last);
}

const blank = (h: HistoryHour) => ({ hour: h.hour, bytesUp: 0, bytesDown: 0, flows: 0, blocked: 0, first: h.first, last: h.last });

function runHours(hours: readonly HistoryHour[]): RunHour[] {
  const by = new Map<string, RunHour>();
  for (const h of hours) {
    const k = `${h.hour}|${h.run ?? ''}`;
    const r = by.get(k) ?? { ...blank(h), run: h.run, llm: null };
    add(r, h);
    if (h.tool === 'llm') r.llm = { first: Math.min(r.llm?.first ?? h.first, h.first), last: Math.max(r.llm?.last ?? h.last, h.last) };
    by.set(k, r);
  }
  return [...by.values()].sort((a, b) => a.hour - b.hour);
}

/** The session's hours across runs and destinations: what a calendar shades. */
export function sessionHours(hours: readonly HistoryHour[]): HourActivity[] {
  const by = new Map<number, HourActivity>();
  for (const h of hours) {
    const a = by.get(h.hour) ?? { ...blank(h), inference: false };
    add(a, h);
    a.inference ||= h.tool === 'llm';
    by.set(h.hour, a);
  }
  return [...by.values()].sort((a, b) => a.hour - b.hour);
}

/**
 * The runs as segments, oldest first, with what moved during each summed from its hours.
 * `live`: the gate is running now, so the last open run is still going. A last run that died
 * with no stop written ended at its last activity, as far as anyone can tell.
 */
export function runSegments(runs: readonly HistoryRun[], hours: readonly HistoryHour[], live: boolean): RunSegment[] {
  const totals = new Map<string, { bytesUp: number; bytesDown: number; flows: number; blocked: number; first: number; last: number }>();
  for (const h of hours) {
    if (h.run === null) continue;
    const t = totals.get(h.run) ?? { bytesUp: 0, bytesDown: 0, flows: 0, blocked: 0, first: h.first, last: h.last };
    add(t, h);
    totals.set(h.run, t);
  }
  const sorted = [...runs].sort((a, b) => a.started - b.started);
  return sorted.map((r, i) => {
    const next = sorted[i + 1];
    const t = totals.get(r.run);
    const end: RunSegment['end'] = r.ended !== null ? (r.inferred ? 'died' : 'stopped') : next ? 'replaced' : live ? null : 'died';
    const to = r.ended ?? next?.started ?? (live ? null : Math.max(r.started, t?.last ?? r.started));
    return { run: r.run, from: r.started, to, end, bytesUp: t?.bytesUp ?? 0, bytesDown: t?.bytesDown ?? 0, flows: t?.flows ?? 0 };
  });
}

export function burstSegments(hours: readonly HistoryHour[], gapMs = DEFAULT_BURST_GAP_MS): { bursts: BurstSegment[]; basis: NetSegments['burstBasis'] } {
  const rh = runHours(hours);
  const basis = rh.some((h) => h.llm) ? 'inference' : 'traffic';
  const byRun = new Map<string | null, RunHour[]>();
  for (const h of rh) byRun.set(h.run, [...(byRun.get(h.run) ?? []), h]);
  const bursts: BurstSegment[] = [];
  for (const [run, list] of byRun) {
    // Each burst's span in active times, and the hours it covers (for its totals).
    const spans: Array<{ from: number; to: number; firstHour: number; lastHour: number }> = [];
    for (const h of list) {
      const act = basis === 'inference' ? h.llm : { first: h.first, last: h.last };
      if (!act) continue;
      const cur = spans.at(-1);
      if (!cur || act.first - cur.to >= gapMs) spans.push({ from: act.first, to: act.last, firstHour: h.hour, lastHour: h.hour });
      else {
        cur.to = Math.max(cur.to, act.last);
        cur.lastHour = h.hour;
      }
    }
    for (const sp of spans) {
      const inside = list.filter((h) => h.hour >= sp.firstHour && h.hour <= sp.lastHour);
      bursts.push({
        from: sp.from, to: sp.to, run,
        bytesUp: inside.reduce((a, h) => a + h.bytesUp, 0),
        bytesDown: inside.reduce((a, h) => a + h.bytesDown, 0),
        flows: inside.reduce((a, h) => a + h.flows, 0),
      });
    }
  }
  return { bursts: bursts.sort((a, b) => a.from - b.from), basis };
}

/** An agent session's span: its first to its last event, by transcript time where kept (`data.transcriptAt`). */
export function agentSegment(sessionId: string, events: readonly TimelineEvent[], turns: number): AgentSegment | null {
  // Each edge, and whether it came from the transcript: `exact` only when both did.
  let from = { t: Infinity, exact: false };
  let to = { t: -Infinity, exact: false };
  for (const e of events) {
    const at = typeof e.data.transcriptAt === 'number' ? e.data.transcriptAt : null;
    const done = typeof e.data.transcriptCompletedAt === 'number' ? e.data.transcriptCompletedAt : null;
    const start = at ?? e.timestamp;
    const end = done ?? at ?? e.timestamp;
    if (start < from.t) from = { t: start, exact: at !== null };
    if (end > to.t) to = { t: end, exact: done !== null || at !== null };
  }
  return Number.isFinite(from.t) ? { sessionId, from: from.t, to: to.t, turns, exact: from.exact && to.exact } : null;
}

export function buildSegments(
  token: string,
  input: { hours: readonly HistoryHour[]; runs: readonly HistoryRun[]; live: boolean; agentSessions: AgentSegment[] },
  gapMs = DEFAULT_BURST_GAP_MS,
): NetSegments {
  const runs = runSegments(input.runs, input.hours, input.live);
  const { bursts, basis } = burstSegments(input.hours, gapMs);
  return {
    token, gapMs, burstBasis: basis, runs, bursts, hours: sessionHours(input.hours),
    agentSessions: [...input.agentSessions].sort((a, b) => a.from - b.from),
  };
}

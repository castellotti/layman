/**
 * Joins a turn's tool calls (from the harness transcript Layman records) to the
 * flows glove's gate saw (plan §7.4). This is what Layman can do and glove
 * cannot: glove never learns the URL behind an HTTPS CONNECT, but the
 * transcript has the exact `web_fetch` call.
 *
 * Pure: `trace.ts` gathers the inputs. The rules, in order:
 *   1. A call that names URLs claims a flow to the URL's host (and port, when
 *      the URL spells one out) that opened between its start − 1 s and its end
 *      + 2 s. Several calls could claim one flow: the nearest start wins.
 *   2. A search call claims the `search` service's flows and SearXNG's fan-out
 *      opened in its window, nearest start again.
 *   3. `llm` service flows become LLM rows between the calls.
 *   4. Anything else in the turn is Unattributed. Never guess.
 *
 * Calls whose times are only approximate (see `TraceTiming`) join by host,
 * against "had ended by `start`": the flow opened after the turn began and no
 * later than `start` + 2 s, and the first call read after the flow opened wins.
 */
import type { TimelineEvent } from '../events/types.js';
import { TOOL_CALL_TYPES } from '../turns/extract.js';
import type { FlowView, NetService, TraceCall, TraceItem, TraceTiming } from './types.js';

/** A flow may open this long before its call is recorded as starting (clock skew, recording lag). */
export const JOIN_BEFORE_MS = 1000;
/** …and this long after the call ended (a connection closing, a slow final flush). */
export const JOIN_AFTER_MS = 2000;

const URL_RE = /\bhttps?:\/\/[^\s'"<>`)\]}]+/gi;
const URL_KEYS = ['url', 'uri', 'href', 'link'];
const SEARCH_NAME = /^(web_?search|websearch|search)$/i;

/** A URL's host, lower-case and without IPv6 brackets, and its port only when written out. */
export function urlTarget(raw: string): { host: string; port: number | null } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return null;
  // `URL` drops a port equal to the scheme's default, so `:443` on https reads as unspelled; either way any port matches.
  return { host, port: u.port ? Number(u.port) : null };
}

/**
 * Every URL a call names: `url`-like arguments, a `urls` list, or URLs in a
 * shell command. With `raw`, also the ones that no longer parse — the PII
 * filter turns `http://169.254.169.254/` into `http://[REDACTED]/` — so the
 * call still reads as a fetch of something.
 */
export function urlsOf(input: Record<string, unknown> | undefined, raw = false): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const k of URL_KEYS) if (typeof input[k] === 'string' && /^https?:\/\//i.test(input[k] as string)) out.push(input[k] as string);
  if (Array.isArray(input.urls)) for (const u of input.urls) if (typeof u === 'string' && /^https?:\/\//i.test(u)) out.push(u);
  if (typeof input.command === 'string') for (const m of (input.command as string).matchAll(URL_RE)) out.push(m[0]);
  const all = [...new Set(out)];
  return raw ? all : all.filter((u) => urlTarget(u) !== null);
}

const REDACTED = /\[REDACTED[^\]]*\]/i;

function isSearch(toolName: string, input: Record<string, unknown> | undefined): boolean {
  return SEARCH_NAME.test(toolName) || (/search/i.test(toolName) && typeof input?.query === 'string');
}

/**
 * A call's times, and how far to trust them: the transcript's own when a
 * passive watcher kept them; the event's own when completion came after the
 * start (a hook harness, or a history import); otherwise only the read time.
 */
export function callTiming(e: Pick<TimelineEvent, 'type' | 'timestamp' | 'data'>): { start: number; end: number | null; timing: TraceTiming } {
  const d = e.data;
  if (typeof d.transcriptAt === 'number') {
    return { start: d.transcriptAt, end: typeof d.transcriptCompletedAt === 'number' ? d.transcriptCompletedAt : null, timing: 'exact' };
  }
  if (typeof d.completedAt === 'number' && d.completedAt > e.timestamp) return { start: e.timestamp, end: d.completedAt, timing: 'exact' };
  // Still pending or approved: a hook recorded it as it started, and it has not ended.
  if (e.type === 'tool_call_pending' || e.type === 'tool_call_approved') return { start: e.timestamp, end: null, timing: 'exact' };
  return { start: e.timestamp, end: e.timestamp, timing: 'approximate' };
}

/** The tool calls among a turn's events, in time order. */
export function callsFrom(events: readonly TimelineEvent[]): TraceCall[] {
  const calls: TraceCall[] = [];
  for (const e of events) {
    if (!TOOL_CALL_TYPES.has(e.type)) continue;
    const toolName = e.data.toolName ?? 'unknown';
    const input = e.data.toolInput;
    const urls = urlsOf(input);
    const named = urlsOf(input, true);
    const search = isSearch(toolName, input);
    const kind = search ? 'search' : named.length ? 'fetch' : 'other';
    const command = typeof input?.command === 'string' ? (input.command as string) : null;
    const label = kind === 'search' ? String(input?.query ?? '')
      : kind === 'fetch' ? named[0]
        : command ? command.slice(0, 120) : toolName;
    calls.push({
      eventId: e.id, sessionId: e.sessionId, toolName, kind, label,
      targets: kind === 'fetch' ? dedupeTargets(urls.filter((u) => !REDACTED.test(u)).map((u) => urlTarget(u)!)) : [],
      redacted: kind === 'fetch' && named.some((u) => REDACTED.test(u)),
      ...callTiming(e),
      failed: e.type === 'tool_call_failed' || e.type === 'tool_call_denied' || !!e.data.error,
    });
  }
  return calls.sort((a, b) => a.start - b.start);
}

function dedupeTargets(ts: Array<{ host: string; port: number | null }>) {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = `${t.host}:${t.port}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type FlowRole = 'llm' | 'search' | 'fanout' | 'other';

/** What a flow is, from its own fields and the service glove declared for it. */
export function flowRole(f: Pick<FlowView, 'service' | 'tool' | 'client' | 'flags'>, services: readonly NetService[]): FlowRole {
  if (f.flags.fanout || f.client === 'searxng') return 'fanout';
  const tool = f.tool ?? services.find((s) => s.service === f.service)?.tool ?? null;
  if (tool === 'llm' || f.service === 'llm') return 'llm';
  if (tool === 'web_search') return 'search';
  return 'other';
}

/**
 * How near a flow opened to a call, or null when it is outside the call's
 * window. `from` is the start of the turn: an approximate call's own start is
 * unknown, so the turn bounds it.
 */
export function joinDistance(call: Pick<TraceCall, 'start' | 'end' | 'timing'>, tOpen: number, from: number): number | null {
  if (call.timing === 'exact') {
    if (tOpen < call.start - JOIN_BEFORE_MS) return null;
    if (call.end !== null && tOpen > call.end + JOIN_AFTER_MS) return null;
    return Math.abs(tOpen - call.start);
  }
  if (tOpen < from - JOIN_BEFORE_MS || tOpen > call.start + JOIN_AFTER_MS) return null;
  // Read after the flow opened is the natural order; a read up to the slack before it is tolerated.
  return Math.abs(call.start - tOpen);
}

const targets = (call: TraceCall, f: FlowView) => {
  const host = f.dest.host?.toLowerCase();
  if (!host) return false;
  return call.targets.some((t) => t.host === host && (t.port === null || t.port === f.dest.port));
};

export interface CorrelateInput {
  calls: readonly TraceCall[];
  /** The flows opened in the turn's window. */
  flows: readonly FlowView[];
  services: readonly NetService[];
  /** Start of the turn's window. */
  from: number;
}

export interface Correlation {
  items: TraceItem[];
  unattributed: string[];
}

export function correlate({ calls, flows, services, from }: CorrelateInput): Correlation {
  const claimed = new Map<string, { flowIds: string[]; fanoutIds: string[] }>(calls.map((c) => [c.eventId, { flowIds: [], fanoutIds: [] }]));
  const llm: FlowView[] = [];
  const unattributed: string[] = [];
  const nearest = (cands: TraceCall[], f: FlowView): TraceCall | null => {
    let best: TraceCall | null = null;
    let bestD = Infinity;
    for (const c of cands) {
      const d = joinDistance(c, f.tOpen, from);
      if (d !== null && d < bestD) { best = c; bestD = d; }
    }
    return best;
  };
  const searches = calls.filter((c) => c.kind === 'search');
  const fetches = calls.filter((c) => c.kind === 'fetch');

  for (const f of [...flows].sort((a, b) => a.tOpen - b.tOpen)) {
    const role = flowRole(f, services);
    if (role === 'llm') { llm.push(f); continue; }
    if (role === 'search' || role === 'fanout') {
      const c = nearest(searches, f);
      if (c) { claimed.get(c.eventId)![role === 'fanout' ? 'fanoutIds' : 'flowIds'].push(f.id); continue; }
      unattributed.push(f.id);
      continue;
    }
    const c = nearest(fetches.filter((x) => targets(x, f)), f);
    if (c) claimed.get(c.eventId)!.flowIds.push(f.id);
    else unattributed.push(f.id);
  }

  const items: Array<{ at: number; item: TraceItem }> = [
    ...calls.map((call) => ({ at: call.start, item: { kind: 'call' as const, call, ...claimed.get(call.eventId)! } })),
    ...llm.map((f) => ({ at: f.tOpen, item: { kind: 'llm' as const, flowId: f.id } })),
  ];
  // Stable: a call and an LLM flow at the same instant keep calls first.
  items.sort((a, b) => a.at - b.at);
  return { items: items.map((x) => x.item), unattributed };
}

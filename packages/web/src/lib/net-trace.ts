/**
 * The Trace tab's waterfall (plan §7.4, trace-agent-trace.dc.html), pure so it
 * is tested in node: a turn's tool calls, each with the flows the server joined
 * to it (`netobs/correlate.ts`), LLM requests between them, and whatever no
 * call claimed under "Unattributed". Rows, the time axis, each flow's outcome
 * text and the default selection live here; `TraceView.tsx` only draws.
 */
import type { FlowView, Rule, TraceCall, TraceView } from './netobs-types.js';

export type Tone = 'muted' | 'ok' | 'tunnel' | 'warn' | 'error' | 'fanout' | 'local';
export type TraceIcon = 'search' | 'fetch' | 'tool' | 'llm' | 'globe' | 'lock' | 'blocked' | 'broken' | 'cut' | 'home' | 'fanout' | 'alert' | 'check' | 'pulse' | 'fold';

export interface Outcome { text: string; tone: Tone; icon: TraceIcon }

export interface TraceRow {
  /** `call:<eventId>`, `flow:<flowId>`, `fan:<eventId>`, `llm:<flowId>`, or `unattributed`. */
  id: string;
  kind: 'call' | 'flow' | 'fanout' | 'llm' | 'group';
  depth: 0 | 1 | 2;
  icon: TraceIcon;
  /** Tool name (a call), host (a flow), or the row's own title. */
  title: string;
  /** The call's URL or query; a flow's IP. */
  detail: string | null;
  outcome: Outcome | null;
  bytes: number | null;
  /** Position on the axis, 0–1. */
  bar: { x0: number; x1: number; tone: Tone; open: boolean; refused: boolean } | null;
  flowId: string | null;
  call: TraceCall | null;
  expandable: boolean;
  expanded: boolean;
}

export interface TraceAxis {
  t0: number;
  span: number;
  /** Tick offsets from t0, in ms. */
  ticks: number[];
}

const TICK_STEPS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => s * 1000);

/** The axis: from the turn's start to its last flow or call, in at most 5 ticks of a round step. */
export function traceAxis(view: Pick<TraceView, 'turn' | 'items' | 'flows'>, now: number): TraceAxis {
  const t0 = view.turn?.startedAt ?? now;
  let end = t0;
  for (const f of view.flows) end = Math.max(end, f.phase === 'close' ? (f.tClose ?? f.lastT) : Math.min(now, Math.max(f.lastT, f.tOpen)));
  for (const i of view.items) if (i.kind === 'call') end = Math.max(end, i.call.end ?? i.call.start);
  const raw = Math.max(1000, end - t0);
  const step = TICK_STEPS.find((s) => raw / s <= 4) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const span = Math.ceil(raw / step) * step;
  return { t0, span, ticks: Array.from({ length: Math.round(span / step) }, (_, i) => i * step) };
}

/** `9 s`, `1.5 min`: a tick label. */
export function tickLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = ms / 60_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} min`;
}

function ruleNote(id: string | null, rules: readonly Rule[]): string {
  if (!id) return 'your rule';
  const note = rules.find((r) => r.id === id)?.note;
  return note ? `your rule “${note}”` : 'your rule';
}

/** What happened to one flow, in the waterfall's words. */
export function flowOutcome(f: FlowView, rules: readonly Rule[] = []): Outcome {
  switch (f.state) {
    case 'guard': return { text: 'refused by glove guard', tone: 'warn', icon: 'lock' };
    case 'user_rule': return { text: `blocked · ${ruleNote(f.rule, rules)}`, tone: 'error', icon: 'blocked' };
    case 'default_block': return { text: 'blocked · the default', tone: 'error', icon: 'blocked' };
    case 'broken': return { text: `path broken · ${f.closeReason === 'timeout' ? 'timed out' : 'upstream'}`, tone: 'warn', icon: 'broken' };
    case 'gate_shutdown': return { text: 'cut · gate shutdown', tone: 'muted', icon: 'cut' };
    case 'gate_lost': return { text: 'cut · the gate went away', tone: 'muted', icon: 'cut' };
    case 'active': return { text: 'live', tone: 'tunnel', icon: 'pulse' };
    case 'pooled': return { text: 'open · idle', tone: 'muted', icon: 'pulse' };
    case 'empty': return { text: 'empty · folded', tone: 'muted', icon: 'fold' };
    default:
      if (f.flags.scope === 'local') return { text: `local · ${f.closeReason ?? 'closed'}`, tone: 'local', icon: 'home' };
      if (f.flags.scope === 'direct') return { text: 'finished · untunnelled', tone: 'error', icon: 'alert' };
      if (f.flags.cleartext) return { text: 'finished · cleartext', tone: 'warn', icon: 'alert' };
      return { text: `finished · ${f.closeReason ?? 'closed'}`, tone: 'ok', icon: 'check' };
  }
}

const REFUSED = new Set(['guard', 'user_rule', 'default_block']);

function barFor(f: FlowView, axis: TraceAxis, tone: Tone, now: number) {
  const x = (t: number) => Math.min(1, Math.max(0, (t - axis.t0) / axis.span));
  const open = f.phase !== 'close';
  const end = open ? Math.min(now, axis.t0 + axis.span) : (f.tClose ?? f.lastT);
  return { x0: x(f.tOpen), x1: Math.max(x(end), x(f.tOpen) + 0.006), tone, open, refused: REFUSED.has(f.state) };
}

/**
 * A call that opened nothing while a matching connection was already open:
 * "no new connection · searxng:8080 + 9 fan-out already open". Said as a fact
 * about timing; the flows stay with the call that opened them.
 */
function alreadyOpen(call: TraceCall, open: FlowView[]): Outcome {
  const hosts = [...new Set(open.filter((f) => !f.flags.fanout).map((f) => (f.dest.port !== null && f.dest.port !== 443 ? `${f.dest.host}:${f.dest.port}` : f.dest.host ?? `${f.service} endpoint`)))];
  const fan = open.filter((f) => f.flags.fanout).length;
  const what = [hosts.length > 2 ? `${hosts.slice(0, 2).join(', ')} +${hosts.length - 2}` : hosts.join(', '), fan ? `${fan} fan-out` : ''].filter(Boolean).join(' + ');
  return { text: `${call.failed ? 'failed · ' : ''}no new connection · ${what} already open`, tone: 'muted', icon: call.kind === 'search' ? 'fanout' : 'globe' };
}

const flowTone = (f: FlowView): Tone => (f.flags.fanout ? 'fanout' : f.flags.scope === 'local' ? 'local' : f.flags.scope === 'direct' ? 'error' : 'tunnel');
const hasTraffic = (flowIds: string[], fanoutIds: string[]) => flowIds.length + fanoutIds.length > 0;

/** Rows open by default: every call and Unattributed; the fan-out group starts folded. */
export function isRowExpanded(id: string, toggled: ReadonlySet<string>): boolean {
  return !id.startsWith('fan:') !== toggled.has(id);
}

export interface RowOptions {
  toggled: ReadonlySet<string>;
  /** Hide calls that made no traffic (the mockup's "Only calls with traffic"). */
  onlyTraffic: boolean;
  rules?: readonly Rule[];
  /** A client name for the fan-out's route line: `via SearXNG · VPN`. */
  routeKind?: string | null;
  now: number;
}

export function traceRows(view: TraceView, axis: TraceAxis, opts: RowOptions): TraceRow[] {
  const byId = new Map(view.flows.map((f) => [f.id, f]));
  const rules = opts.rules ?? [];
  const rows: TraceRow[] = [];
  const flowRow = (f: FlowView, depth: 1 | 2): TraceRow => ({
    id: `flow:${f.id}`, kind: 'flow', depth, icon: f.dest.host === null ? 'lock' : REFUSED.has(f.state) ? flowOutcome(f, rules).icon : f.flags.scope === 'local' ? 'home' : 'globe',
    title: f.dest.host === null ? `${f.service} endpoint` : f.dest.port !== null && f.dest.port !== 443 ? `${f.dest.host}:${f.dest.port}` : f.dest.host,
    detail: f.dest.ip && f.dest.ip !== f.dest.host ? f.dest.ip : f.dest.resolution === 'unavailable' ? 'unresolved' : null, outcome: flowOutcome(f, rules), bytes: f.bytes.up + f.bytes.down,
    bar: barFor(f, axis, flowTone(f), opts.now), flowId: f.id, call: null, expandable: false, expanded: false,
  });
  let llmN = 0;
  for (const item of view.items) {
    if (item.kind === 'llm') {
      const f = byId.get(item.flowId);
      if (!f) continue;
      llmN++;
      const secs = ((f.tClose ?? f.lastT) - f.tOpen) / 1000;
      rows.push({
        id: `llm:${f.id}`, kind: 'llm', depth: 0, icon: 'llm', title: `llm request ${llmN}`, detail: null,
        outcome: { text: `local · ${secs.toFixed(1)} s`, tone: 'local', icon: 'home' }, bytes: f.bytes.up + f.bytes.down,
        bar: barFor(f, axis, 'local', opts.now), flowId: f.id, call: null, expandable: false, expanded: false,
      });
      continue;
    }
    const { call, flowIds, fanoutIds, openIds } = item;
    // A call that rode an already-open connection made traffic too, just no new flow.
    if (opts.onlyTraffic && !hasTraffic(flowIds, fanoutIds) && !openIds.length) continue;
    const id = `call:${call.eventId}`;
    const expanded = isRowExpanded(id, opts.toggled);
    const any = hasTraffic(flowIds, fanoutIds);
    rows.push({
      id, kind: 'call', depth: 0, icon: call.kind === 'search' ? 'search' : call.kind === 'fetch' ? 'fetch' : 'tool',
      title: call.toolName, detail: call.kind === 'search' ? `“${call.label}”` : call.label,
      outcome: call.kind === 'search' && any ? { text: [flowIds.length ? `${flowIds.length} local` : null, fanoutIds.length ? `${fanoutIds.length} fan-out` : null].filter(Boolean).join(' + '), tone: 'fanout', icon: 'fanout' }
        : !any && call.redacted ? { text: 'host redacted · not joined', tone: 'warn', icon: 'alert' }
          : !any && openIds.length ? alreadyOpen(call, openIds.map((fid) => byId.get(fid)).filter((f): f is FlowView => !!f))
            : !any && call.kind !== 'other' ? { text: call.failed ? 'failed · no traffic seen' : 'no traffic seen', tone: 'muted', icon: 'fold' } : null,
      bytes: null, bar: null, flowId: null, call, expandable: any, expanded: any && expanded,
    });
    if (!any || !expanded) continue;
    for (const fid of flowIds) { const f = byId.get(fid); if (f) rows.push(flowRow(f, 1)); }
    if (fanoutIds.length) {
      const fans = fanoutIds.map((fid) => byId.get(fid)).filter((f): f is FlowView => !!f);
      const fanId = `fan:${call.eventId}`;
      const open = isRowExpanded(fanId, opts.toggled);
      const x0 = Math.min(...fans.map((f) => barFor(f, axis, 'fanout', opts.now).x0));
      const x1 = Math.max(...fans.map((f) => barFor(f, axis, 'fanout', opts.now).x1));
      const kind = opts.routeKind === 'tor' ? 'Tor' : opts.routeKind === 'vpn' ? 'VPN' : opts.routeKind ?? 'tunnel';
      rows.push({
        id: fanId, kind: 'fanout', depth: 1, icon: 'fanout', title: `fan-out · ${fans.length} engine${fans.length === 1 ? '' : 's'}`, detail: null,
        outcome: { text: `via SearXNG · ${kind}`, tone: 'fanout', icon: 'fanout' }, bytes: fans.reduce((a, f) => a + f.bytes.up + f.bytes.down, 0),
        bar: { x0, x1, tone: 'fanout', open: fans.some((f) => f.phase !== 'close'), refused: false }, flowId: null, call: null, expandable: true, expanded: open,
      });
      if (open) for (const f of fans) rows.push(flowRow(f, 2));
    }
  }
  if (view.unattributed.length) {
    const open = isRowExpanded('unattributed', opts.toggled);
    const fs = view.unattributed.map((fid) => byId.get(fid)).filter((f): f is FlowView => !!f);
    rows.push({
      id: 'unattributed', kind: 'group', depth: 0, icon: 'fold', title: 'Unattributed', detail: `${fs.length} flow${fs.length === 1 ? '' : 's'} no tool call in this turn names`,
      outcome: null, bytes: fs.reduce((a, f) => a + f.bytes.up + f.bytes.down, 0), bar: null, flowId: null, call: null, expandable: true, expanded: open,
    });
    if (open) for (const f of fs) rows.push(flowRow(f, 1));
  }
  return rows;
}

/**
 * What the Details panel shows before the reader picks anything: a guard
 * refusal when the turn has one ("the agent tried to reach cloud metadata" is
 * the most important thing this tab can say), else a rule block, else nothing.
 */
export function defaultSelection(view: TraceView): string | null {
  const byId = new Map(view.flows.map((f) => [f.id, f]));
  const claimed = view.items.flatMap((i) => (i.kind === 'call' ? i.flowIds : []));
  for (const state of ['guard', 'user_rule', 'default_block'] as const) {
    const hit = [...claimed, ...view.unattributed].find((id) => byId.get(id)?.state === state);
    if (hit) return `flow:${hit}`;
  }
  return null;
}

/** The call that claimed a flow, if any: "The agent asked for …". */
export function callForFlow(view: TraceView, flowId: string): TraceCall | null {
  for (const i of view.items) if (i.kind === 'call' && (i.flowIds.includes(flowId) || i.fanoutIds.includes(flowId))) return i.call;
  return null;
}

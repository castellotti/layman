/**
 * The Network tab's destination table (plan §7.1, network-ledger.dc.html) as
 * data: grouping, filtering, sorting, and what every cell says. Pure, so it is
 * tested in node; `components/network/DestinationTable.tsx` only draws rows.
 *
 * The tree is group → host → flow. A group whose one host *is* the group
 * (`arxiv.org`) skips the host level. Four groups are fixed, whatever the
 * grouping: "Search fan-out", "Local links", "Refused by glove guard" and "Not
 * watched" (declared services glove cannot see, which have no records at all).
 */
import { BLOCK_STATES, LEGEND_BY_KEY, NET_STATE_INFO, formatAge, type StateIcon, type ToggleKind } from './net-format.js';
import type { NetSessionData } from './net-state.js';
import type { DestinationAggregate, FlowView, NetService, NetState, RateBucket, Rule } from './netobs-types.js';

export type GroupBy = 'domain' | 'route' | 'tool';
export type SortBy = 'recent' | 'bytes';
export type StateFilter = 'all' | 'live' | 'blocked' | 'broken' | 'local';

export const GROUP_FANOUT = '@fanout';
export const GROUP_LOCAL = '@local';
export const GROUP_GUARD = '@guard';
export const GROUP_UNWATCHED = '@unwatched';
export const GROUP_EMPTY = '@empty';

/** Fixed groups that start expanded: the guard's refusals and the unwatched routes are what a glance should catch. */
const EXPANDED_BY_DEFAULT = new Set([GROUP_GUARD, GROUP_UNWATCHED]);

/** Past this many rows the table renders only what is on screen (plan §7.1). */
export const WINDOW_THRESHOLD = 200;
export const GROUP_ROW_HEIGHT = 30;
export const ROW_HEIGHT = 28;

/** The window a "live · N KB/s" rate is measured over. */
const RATE_WINDOW_MS = 3_000;
const SPARK_WINDOW_MS = 60_000;

export interface CellText {
  text: string;
  colourVar: string;
  icon: StateIcon | null;
}

export interface TableRow {
  kind: 'group' | 'host' | 'flow' | 'unwatched' | 'more';
  /** Unique within the table; also the expansion key for groups and hosts. */
  key: string;
  depth: 0 | 1 | 2;
  label: string;
  sublabel: string | null;
  /** Hosts, flows and endpoints are set in the monospace face; registrable domains are not. */
  mono: boolean;
  expandable: boolean;
  expanded: boolean;
  /** The host this row selects (the URL's `dest=`), or null. */
  host: string | null;
  toggle: ToggleKind;
  /** What a toggle acts on, for its aria-label ("Block arxiv.org"). */
  target: string;
  route: CellText | null;
  tools: string[];
  spark: RateBucket[];
  sent: number | null;
  received: number | null;
  flows: number | null;
  last: CellText | null;
  state: CellText;
  /** Tint the row: untunnelled traffic must be unmissable. */
  loud: boolean;
}

export interface FilterCounts {
  all: number;
  live: number;
  blocked: number;
  broken: number;
  local: number;
}

export interface TableOptions {
  groupBy: GroupBy;
  sortBy: SortBy;
  filter: StateFilter;
  text: string;
  /** Keys whose expansion the viewer flipped from its default. */
  toggled: ReadonlySet<string>;
  /** Wall clock, for ages ("open 2 s"). */
  now: number;
  /** List the folded empty connections (the footer's "show"). */
  showEmpty?: boolean;
}

export interface TableModel {
  rows: TableRow[];
  counts: FilterCounts;
  /** Destinations after filtering, before grouping. */
  shown: number;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

const LIVE: ReadonlySet<NetState> = new Set(['active', 'pooled']);
const ROUTE_NAME: Record<string, string> = { vpn: 'VPN', tor: 'Tor', direct: 'Direct' };
const TOOL_LABEL: Record<string, string> = { 'search-engine-fanout': 'fan-out' };
/** How the Local links group names its members. */
const LOCAL_NAME: Record<string, string> = { llm: 'LLM', web_search: 'SearXNG' };

const isLocalLink = (d: DestinationAggregate) => d.flags.scope === 'local' && d.state !== 'guard';

export function toolLabel(tool: string): string {
  return TOOL_LABEL[tool] ?? tool;
}

export function isExpanded(key: string, toggled: ReadonlySet<string>): boolean {
  return EXPANDED_BY_DEFAULT.has(key) !== toggled.has(key);
}

/** `f_01M3…9W4R` → `flow f_…9W4R`, as the mockup abbreviates flow ids. */
export function flowLabel(id: string): string {
  return `flow ${id.slice(0, 2)}…${id.slice(-4)}`;
}

/** A clock time for the Last column: `14:14:43`. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Host plus its port where the port says something (not 443, and not 80, which the cleartext flag says). */
export function hostLabel(d: Pick<DestinationAggregate, 'host' | 'port' | 'endpoint'>): string {
  if (d.host === null) return 'proxy endpoint';
  return d.port !== null && d.port !== 443 && d.port !== 80 ? `${d.host}:${d.port}` : d.host;
}

/** Why glove's guard refused a destination, as the mockup's sublabels put it. */
export function guardReason(d: Pick<DestinationAggregate, 'host' | 'rule'>): string {
  if (d.rule === 'builtin:malformed-request' || d.host === null) return 'no destination';
  const h = d.host.toLowerCase();
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return 'cloud metadata';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return 'private address';
  return 'internal name';
}

/** A rule's match as one line: `host *.tracker.example`, `ip 10.0.0.0/8 · port 443`. */
export function matchText(rule: Pick<Rule, 'match'>): string {
  const parts = Object.entries(rule.match).map(([k, v]) => `${k} ${v}`);
  return parts.length ? parts.join(' · ') : 'everything';
}

/** Bytes per second over the last few seconds of a sparkline, ending at `anchor`. */
export function rateOf(spark: readonly RateBucket[], anchor: number): number {
  let sum = 0;
  for (const b of spark) if (b.t > anchor - RATE_WINDOW_MS) sum += b.up + b.down;
  return sum / (RATE_WINDOW_MS / 1000);
}

/** Buckets inside the sparkline window ending at `anchor`. */
export function sparkWindow(spark: readonly RateBucket[], anchor: number): RateBucket[] {
  return spark.filter((b) => b.t > anchor - SPARK_WINDOW_MS && b.t <= anchor);
}

function sumSparks(sparks: RateBucket[][]): RateBucket[] {
  const m = new Map<number, RateBucket>();
  for (const s of sparks) {
    for (const b of s) {
      const x = m.get(b.t) ?? { t: b.t, up: 0, down: 0 };
      x.up += b.up;
      x.down += b.down;
      m.set(b.t, x);
    }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

function formatRate(bps: number): string {
  if (bps < 1000) return `${Math.round(bps)} B/s`;
  if (bps < 1_000_000) return `${Math.round(bps / 1000)} KB/s`;
  return `${(bps / 1_000_000).toFixed(1)} MB/s`;
}

// ─── Cells ────────────────────────────────────────────────────────────────────

interface Ctx {
  data: NetSessionData;
  /** Latest record time the session has: sparklines and rates end here, so a stopped gate's freeze. */
  anchor: number;
  now: number;
  rules: Map<string, Rule>;
  flowsByDest: Map<string, FlowView[]>;
}

function ruleNote(ctx: Ctx, id: string | null): string | null {
  return id ? ctx.rules.get(id)?.note ?? null : null;
}

/** The State column for one flow, or for a destination through its latest flow. */
function stateCell(
  ctx: Ctx,
  s: { state: NetState; rule: string | null; scope: string; cleartext: boolean; closeReason: string | null },
  live: { text: string } | null,
): CellText {
  const info = NET_STATE_INFO[s.state];
  const c = (text: string, colourVar = info.colourVar, icon: StateIcon | null = info.icon): CellText => ({ text, colourVar, icon });
  let cell: CellText;
  switch (s.state) {
    case 'active':
    case 'pooled':
      cell = c(live?.text ?? (s.state === 'active' ? 'live' : 'pooled'));
      break;
    case 'finished':
      cell = s.cleartext
        ? c('finished · cleartext http', LEGEND_BY_KEY.cleartext.colourVar, LEGEND_BY_KEY.cleartext.icon)
        : c(`finished · ${s.closeReason ?? 'eof'}`);
      break;
    case 'guard':
      cell = c(s.rule === 'builtin:malformed-request' ? 'refused · malformed request' : 'refused by glove guard');
      break;
    case 'user_rule': {
      const note = ruleNote(ctx, s.rule);
      cell = c(note ? `blocked · your rule “${note}”` : 'blocked · your rule');
      break;
    }
    case 'default_block':
      cell = c('blocked · nothing allowed it');
      break;
    case 'broken':
      cell = c(`path broken · ${s.closeReason === 'timeout' ? 'timeout' : 'upstream'}`);
      break;
    case 'gate_shutdown':
      cell = c('cut · gate shut down');
      break;
    case 'gate_lost':
      cell = c('cut · gate went away (inferred)');
      break;
    case 'empty':
      cell = c('empty · folded');
      break;
  }
  // Untunnelled traffic keeps its state but is always said, in red, first.
  if (s.scope === 'direct' && !BLOCK_STATES.has(s.state)) {
    return { text: `untunnelled · ${cell.text}`, colourVar: LEGEND_BY_KEY.direct.colourVar, icon: LEGEND_BY_KEY.direct.icon };
  }
  return cell;
}

/** The Route column: how the traffic left, or that it never did. */
function routeCell(ctx: Ctx, d: { state: NetState; scope: string }): CellText {
  if (d.state === 'guard' || (BLOCK_STATES.has(d.state) && d.scope === 'local')) {
    return { text: 'never left', colourVar: 'var(--text-faint)', icon: 'shield' };
  }
  if (d.scope === 'local') return { text: 'local', colourVar: 'var(--text-muted)', icon: 'home' };
  if (d.scope === 'direct') return { text: 'Direct', colourVar: 'var(--error)', icon: 'direct' };
  const kind = ctx.data.gate.route.kind;
  const name = kind ? ROUTE_NAME[kind] ?? kind : 'tunnel';
  return { text: name, colourVar: 'var(--net-tunnel)', icon: 'tunnel' };
}

export function toggleKindFor(state: NetState, noHost: boolean): ToggleKind {
  if (state === 'empty') return 'none';
  if (noHost) return 'locked';
  return NET_STATE_INFO[state].toggleKind;
}

function lastCell(ctx: Ctx, t: number, live: boolean): CellText {
  return live
    ? { text: 'now', colourVar: 'var(--net-tunnel)', icon: null }
    : { text: clockTime(t), colourVar: 'var(--text-body)', icon: null };
}

function latestFlow(ctx: Ctx, key: string): FlowView | undefined {
  return ctx.flowsByDest.get(key)?.[0];
}

function destState(ctx: Ctx, d: DestinationAggregate): CellText {
  const f = latestFlow(ctx, d.key);
  const live = LIVE.has(d.state)
    ? { text: d.state === 'active'
        ? (() => { const r = rateOf(d.spark, ctx.anchor); return r > 0 ? `live · ${formatRate(r)}` : 'live'; })()
        : `pooled · idle ${formatAge(ctx.anchor - d.lastSeen)}` }
    : null;
  return stateCell(ctx, { state: d.state, rule: d.rule, scope: d.scope, cleartext: d.flags.cleartext, closeReason: f?.closeReason ?? null }, live);
}

function flowState(ctx: Ctx, f: FlowView): CellText {
  const live = f.state === 'active'
    ? { text: `open ${formatAge(ctx.now - f.tOpen)}` }
    : f.state === 'pooled' ? { text: `pooled · idle ${formatAge(ctx.now - f.lastActivityAt)}` } : null;
  return stateCell(ctx, { state: f.state, rule: f.rule, scope: f.scope, cleartext: f.flags.cleartext, closeReason: f.closeReason }, live);
}

function hostSublabel(ctx: Ctx, d: DestinationAggregate): string | null {
  if (d.state === 'guard') return guardReason(d);
  if (d.state === 'user_rule' && d.rule) {
    const rule = ctx.rules.get(d.rule);
    return rule ? String(rule.match.host ?? matchText(rule)) : d.rule;
  }
  if (d.host === null) return d.endpoint;
  if (d.flags.cleartext) return `:${d.port ?? 80} cleartext`;
  if (d.flags.unresolved) return 'unresolved';
  return d.ips[0] ?? null;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

function groupOf(d: DestinationAggregate, by: GroupBy, ctx: Ctx): { key: string; label: string } {
  if (d.flags.fanout) return { key: GROUP_FANOUT, label: 'Search fan-out' };
  if (d.state === 'guard') return { key: GROUP_GUARD, label: 'Refused by glove guard' };
  if (isLocalLink(d)) return { key: GROUP_LOCAL, label: 'Local links' };
  if (by === 'route') {
    const r = routeCell(ctx, d);
    return { key: `route:${r.text}`, label: r.text };
  }
  if (by === 'tool') {
    const tool = d.tools[0] ?? 'unknown';
    return { key: `tool:${tool}`, label: toolLabel(tool) };
  }
  return { key: `domain:${d.groupKey}`, label: d.groupKey };
}

function matchesText(ctx: Ctx, d: DestinationAggregate, q: string): boolean {
  if (!q) return true;
  const hay = [d.host, d.endpoint, ...d.ips, ...d.tools, ...d.services, d.rule, ruleNote(ctx, d.rule)];
  return hay.some((h) => h !== null && h !== undefined && h.toLowerCase().includes(q));
}

function matchesFilter(d: DestinationAggregate, f: StateFilter): boolean {
  switch (f) {
    case 'all': return true;
    case 'live': return LIVE.has(d.state);
    case 'blocked': return BLOCK_STATES.has(d.state);
    case 'broken': return d.state === 'broken';
    case 'local': return isLocalLink(d);
  }
}

export function filterCounts(dests: readonly DestinationAggregate[]): FilterCounts {
  const n = (f: StateFilter) => dests.filter((d) => matchesFilter(d, f)).length;
  return { all: dests.length, live: n('live'), blocked: n('blocked'), broken: n('broken'), local: n('local') };
}

/** The latest record time in the session: the right edge of every sparkline. */
export function sessionAnchor(data: NetSessionData, now: number): number {
  let t = 0;
  for (const k of data.buckets.keys()) if (k > t) t = k;
  for (const d of data.destinations.values()) if (d.lastSeen > t) t = d.lastSeen;
  return t || now;
}

interface Group {
  key: string;
  label: string;
  dests: DestinationAggregate[];
  lastSeen: number;
  bytes: number;
}

function summaryState(ctx: Ctx, dests: DestinationAggregate[]): CellText {
  const live = dests.filter((d) => d.state === 'active').length;
  const pooled = dests.some((d) => d.state === 'pooled');
  const loud = dests.find((d) => d.scope === 'direct' && !BLOCK_STATES.has(d.state));
  if (live || pooled) {
    const text = live ? `${live} live${pooled ? ' · pooled' : ''}` : 'pooled';
    if (loud) return { text: `untunnelled · ${text}`, colourVar: 'var(--error)', icon: 'alert' };
    return { text, colourVar: 'var(--net-tunnel)', icon: 'pulse' };
  }
  return destState(ctx, dests[0]);
}

function groupSublabel(ctx: Ctx, g: Group): string | null {
  if (g.key === GROUP_FANOUT) return `via SearXNG · ${g.dests.length} engine${g.dests.length === 1 ? '' : 's'}`;
  if (g.key === GROUP_LOCAL) {
    const names = [...new Set(g.dests.map((d) => LOCAL_NAME[d.tools[0] ?? ''] ?? hostLabel(d)))];
    return names.join(' · ');
  }
  if (g.key === GROUP_GUARD) return `${g.dests.length} refused`;
  return `${g.dests.length} host${g.dests.length === 1 ? '' : 's'}`;
}

function unwatchedRows(ctx: Ctx, services: NetService[], opts: TableOptions): TableRow[] {
  if (!services.length || (opts.filter !== 'all') || opts.text) {
    // "Not watched" has no records to filter on: it only shows unfiltered.
    return [];
  }
  const info = LEGEND_BY_KEY.not_watched;
  const row = (s: NetService, depth: 0 | 1): TableRow => ({
    kind: 'unwatched', key: `unwatched:${s.service}`, depth,
    label: s.listen ? `${s.service} ${s.listen.replace(/^.*?(:\d+)$/, '$1')}` : s.service,
    sublabel: 'declared service', mono: true, expandable: false, expanded: false, host: null,
    toggle: 'none', target: s.service,
    route: { text: 'unknown', colourVar: 'var(--text-faint)', icon: 'eye-off' },
    tools: s.tool ? [s.tool] : [s.service], spark: [], sent: null, received: null, flows: null, last: null,
    state: { text: 'not watched · no records', colourVar: info.colourVar, icon: info.icon }, loud: false,
  });
  if (services.length === 1) return [row(services[0], 0)];
  const expanded = isExpanded(GROUP_UNWATCHED, opts.toggled);
  return [
    {
      kind: 'group', key: GROUP_UNWATCHED, depth: 0, label: 'Not watched', sublabel: `${services.length} declared services`,
      mono: false, expandable: true, expanded, host: null, toggle: 'none', target: 'Not watched',
      route: { text: 'unknown', colourVar: 'var(--text-faint)', icon: 'eye-off' }, tools: [], spark: [],
      sent: null, received: null, flows: null, last: null,
      state: { text: 'not watched · no records', colourVar: info.colourVar, icon: info.icon }, loud: false,
    },
    ...(expanded ? services.map((s) => row(s, 1)) : []),
  ];
}

function flowRows(ctx: Ctx, d: DestinationAggregate, depth: 1 | 2): TableRow[] {
  const flows = ctx.flowsByDest.get(d.key) ?? [];
  const rows: TableRow[] = flows.map((f) => ({
    kind: 'flow', key: `flow:${f.id}`, depth, label: flowLabel(f.id), sublabel: null, mono: true,
    expandable: false, expanded: false, host: d.host, toggle: 'none', target: f.id,
    route: routeCell(ctx, f), tools: f.tool ? [f.tool] : [], spark: sparkWindow(f.spark, ctx.anchor),
    sent: f.bytes.up, received: f.bytes.down, flows: 1,
    last: lastCell(ctx, f.lastT, f.state === 'active'), state: flowState(ctx, f),
    loud: f.flags.scope === 'direct',
  }));
  const missing = d.flows - flows.length;
  if (missing > 0) {
    rows.push({
      kind: 'more', key: `more:${d.key}`, depth, label: `${missing} earlier flow${missing === 1 ? '' : 's'} not loaded`,
      sublabel: null, mono: false, expandable: false, expanded: false, host: d.host, toggle: 'none', target: '',
      route: null, tools: [], spark: [], sent: null, received: null, flows: null, last: null,
      state: { text: '', colourVar: 'var(--text-faint)', icon: null }, loud: false,
    });
  }
  return rows;
}

/** Folded empty connections, listed on request: they have no destination to group under. */
function emptyRows(ctx: Ctx): TableRow[] {
  const flows = [...ctx.data.flows.values()].filter((f) => f.state === 'empty').sort((a, b) => b.tOpen - a.tOpen);
  if (!flows.length) return [];
  const info = NET_STATE_INFO.empty;
  return [
    {
      kind: 'group', key: GROUP_EMPTY, depth: 0, label: 'Empty connections', sublabel: 'eof / timeout, no host',
      mono: false, expandable: false, expanded: true, host: null, toggle: 'none', target: 'Empty connections',
      route: { text: 'never left', colourVar: 'var(--text-faint)', icon: 'shield' }, tools: [], spark: [],
      sent: 0, received: 0, flows: flows.length, last: lastCell(ctx, flows[0].lastT, false),
      state: { text: 'empty · folded', colourVar: info.colourVar, icon: info.icon }, loud: false,
    },
    ...flows.map((f): TableRow => ({
      kind: 'flow', key: `flow:${f.id}`, depth: 1, label: flowLabel(f.id), sublabel: f.service, mono: true,
      expandable: false, expanded: false, host: null, toggle: 'none', target: f.id,
      route: routeCell(ctx, f), tools: f.tool ? [f.tool] : [], spark: [], sent: f.bytes.up, received: f.bytes.down, flows: 1,
      last: lastCell(ctx, f.lastT, false), state: { text: `empty · ${f.closeReason ?? 'eof'}`, colourVar: info.colourVar, icon: info.icon },
      loud: false,
    })),
  ];
}

function hostRow(ctx: Ctx, d: DestinationAggregate, depth: 0 | 1, opts: TableOptions, label = hostLabel(d), sublabel = hostSublabel(ctx, d)): TableRow {
  const key = `host:${d.key}`;
  return {
    kind: 'host', key, depth, label, sublabel, mono: depth > 0,
    expandable: true, expanded: isExpanded(key, opts.toggled), host: d.host,
    toggle: toggleKindFor(d.state, d.flags.noHost), target: d.host ?? d.endpoint ?? d.key,
    route: routeCell(ctx, d), tools: d.tools, spark: sparkWindow(d.spark, ctx.anchor),
    sent: d.bytesUp, received: d.bytesDown, flows: d.flows,
    last: lastCell(ctx, d.lastSeen, d.state === 'active'), state: destState(ctx, d),
    loud: d.scope === 'direct' && !BLOCK_STATES.has(d.state),
  };
}

/** The table's rows, top to bottom, with only expanded subtrees included. */
export function buildTable(data: NetSessionData, opts: TableOptions): TableModel {
  const all = [...data.destinations.values()];
  const flowsByDest = new Map<string, FlowView[]>();
  for (const f of data.flows.values()) {
    if (!f.destKey) continue;
    const list = flowsByDest.get(f.destKey) ?? [];
    list.push(f);
    flowsByDest.set(f.destKey, list);
  }
  for (const list of flowsByDest.values()) list.sort((a, b) => b.tOpen - a.tOpen);
  const ctx: Ctx = {
    data,
    anchor: sessionAnchor(data, opts.now),
    now: opts.now,
    rules: new Map((data.rules.file?.rules ?? []).map((r) => [r.id, r])),
    flowsByDest,
  };

  const q = opts.text.trim().toLowerCase();
  const shown = all.filter((d) => matchesFilter(d, opts.filter) && matchesText(ctx, d, q));

  const groups = new Map<string, Group>();
  for (const d of shown) {
    const { key, label } = groupOf(d, opts.groupBy, ctx);
    const g = groups.get(key) ?? { key, label, dests: [], lastSeen: 0, bytes: 0 };
    g.dests.push(d);
    g.lastSeen = Math.max(g.lastSeen, d.lastSeen);
    g.bytes += d.bytesUp + d.bytesDown;
    groups.set(key, g);
  }
  const byRecent = (a: { lastSeen: number }, b: { lastSeen: number }) => b.lastSeen - a.lastSeen;
  const cmpGroup = opts.sortBy === 'bytes' ? (a: Group, b: Group) => b.bytes - a.bytes || byRecent(a, b) : byRecent;
  const cmpDest = opts.sortBy === 'bytes'
    ? (a: DestinationAggregate, b: DestinationAggregate) => b.bytesUp + b.bytesDown - (a.bytesUp + a.bytesDown) || byRecent(a, b)
    : byRecent;

  const rows: TableRow[] = [];
  for (const g of [...groups.values()].sort(cmpGroup)) {
    g.dests.sort(cmpDest);
    const fixed = g.key.startsWith('@');
    // A group whose only host is the group itself (arxiv.org) is that host: no extra level.
    if (!fixed && g.dests.length === 1 && hostLabel(g.dests[0]) === g.label) {
      const d = g.dests[0];
      const row = hostRow(ctx, d, 0, opts, g.label, hostSublabel(ctx, d));
      rows.push(row);
      if (row.expanded) rows.push(...flowRows(ctx, d, 1));
      continue;
    }
    const expanded = isExpanded(g.key, opts.toggled);
    const first = g.dests[0];
    const allToggles = new Set(g.dests.map((d) => toggleKindFor(d.state, d.flags.noHost)));
    rows.push({
      kind: 'group', key: g.key, depth: 0, label: g.label, sublabel: groupSublabel(ctx, g), mono: false,
      expandable: true, expanded, host: g.dests.length === 1 ? first.host : null,
      // One toggle for the group only when every member agrees; phase 4 writes one rule for it.
      toggle: allToggles.size === 1 ? [...allToggles][0] : 'none',
      target: g.label,
      route: routeCell(ctx, first),
      tools: [...new Set(g.dests.flatMap((d) => d.tools))],
      spark: sumSparks(g.dests.map((d) => sparkWindow(d.spark, ctx.anchor))),
      sent: g.dests.reduce((a, d) => a + d.bytesUp, 0),
      received: g.dests.reduce((a, d) => a + d.bytesDown, 0),
      flows: g.dests.reduce((a, d) => a + d.flows, 0),
      last: lastCell(ctx, g.lastSeen, g.dests.some((d) => d.state === 'active')),
      state: summaryState(ctx, g.dests),
      loud: g.dests.some((d) => d.scope === 'direct' && !BLOCK_STATES.has(d.state)),
    });
    if (!expanded) continue;
    for (const d of g.dests) {
      const row = hostRow(ctx, d, 1, opts);
      rows.push(row);
      if (row.expanded) rows.push(...flowRows(ctx, d, 2));
    }
  }

  const unwatched = (data.session?.services ?? []).filter((s) => !s.observed);
  rows.push(...unwatchedRows(ctx, unwatched, opts));
  if (opts.showEmpty) rows.push(...emptyRows(ctx));

  return { rows, counts: filterCounts(all), shown: shown.length };
}

// ─── Windowing ────────────────────────────────────────────────────────────────

export const rowHeight = (r: Pick<TableRow, 'depth'>): number => (r.depth === 0 ? GROUP_ROW_HEIGHT : ROW_HEIGHT);

export interface WindowRange {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
}

/**
 * Which rows of a list of `heights` intersect the viewport, plus `overscan`
 * either side, and the spacer heights above and below them. Two row heights
 * only, so a linear prefix sum is plenty for thousands of rows.
 */
export function windowRange(heights: readonly number[], scrollTop: number, viewport: number, overscan = 8): WindowRange {
  let y = 0;
  let start = heights.length;
  for (let i = 0; i < heights.length; i++) {
    if (y + heights[i] > scrollTop) {
      start = i;
      break;
    }
    y += heights[i];
  }
  let end = start;
  let bottom = y;
  while (end < heights.length && bottom < scrollTop + viewport) bottom += heights[end++];
  const s = Math.max(0, start - overscan);
  const e = Math.min(heights.length, end + overscan);
  const sum = (a: number, b: number) => heights.slice(a, b).reduce((x, h) => x + h, 0);
  return { start: s, end: e, padTop: sum(0, s), padBottom: sum(e, heights.length) };
}

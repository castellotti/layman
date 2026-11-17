/**
 * The Gibson feed's pure core: Layman's own records as the rows of styx-os's `GET /v1/hosts`,
 * `/v1/links` and `/v1/flows` (docs/extensions/styx.md → "The Gibson feed"). No I/O and no
 * fastify, so every rule is tested alone. Written like `matrix.ts`: small accumulators, one
 * `finish` per row type that sorts and cuts.
 *
 * The three row types are to be mirrored by hand in the web package (`lib/gibson-feed.ts`, added with
 * the Gibson views): change both or neither.
 */
import { REFUSED } from '../netobs/trace.js';
import { isIpLiteral, registrableDomain } from '../netobs/domain.js';
import type { DestinationAggregate, FlowView, TraceCall } from '../netobs/types.js';
import { targetPort, untunnelled } from './matrix.js';

/** One tower. Field names are the wire's. */
export interface HostRow {
  host: string;
  block: string;
  ports: number[];
  sent: number;
  received: number;
  count: number;
  open: number;
  blocked: number;
  untunnelled: boolean;
  scope: string;
  first_seen_ago: number;
  last_seen_ago: number;
  clients: string[];
  tools: string[];
  services: string[];
}

/** Who talks to whom: one row per (source, via, target). */
export interface LinkRow {
  source: string;
  source_kind: 'client' | 'agent' | 'device';
  via: string;
  target: string;
  sent: number;
  received: number;
  count: number;
  open: number;
  blocked: number;
  last_seen_ago: number;
}

/** One connection (gloved) or tool call (standard): a line of a tower's log. */
export interface LogRow {
  host: string;
  time: number;
  ago: number;
  source: string;
  via: string;
  tool: string | null;
  port: number | null;
  proto: string | null;
  sent: number;
  received: number;
  state: string;
  blocked: boolean;
  rule: string | null;
  method: string | null;
  url: string | null;
  label: string | null;
}

export const GIBSON_MAX_HOSTS = 256;
export const GIBSON_MAX_LINKS = 512;
export const GIBSON_MAX_LOG = 500;
export const GIBSON_DEFAULT_LOG = 100;
const MAX_PORTS = 16;
const MAX_NAMES = 8;

/** The city block a host stands in: an IPv4's /16, an IPv6 literal itself, a name's registrable domain. */
export function blockOf(host: string): string {
  const h = host.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && isIpLiteral(h)) {
    const [a, b] = h.split('.');
    return `${a}.${b}.0.0/16`;
  }
  return registrableDomain(h) ?? h;
}

/** `limit`: undefined → the default; 1..500 → it; anything else → null (400). */
export function parseLimit(raw: string | undefined): number | null {
  if (raw === undefined) return GIBSON_DEFAULT_LOG;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= GIBSON_MAX_LOG ? n : null;
}

/** Whole seconds from `ms` to `now`, never negative. */
const ageOf = (now: number, ms: number): number => Math.max(0, Math.floor((now - ms) / 1000));

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A sorted union cut to `max`. */
const union = <T extends string | number>(a: readonly T[], b: readonly T[], max: number): T[] =>
  [...new Set([...a, ...b])].sort((x, y) => (typeof x === 'number' ? x - (y as number) : cmp(x as string, y as string))).slice(0, max);

const compact = (...v: Array<string | null | undefined>): string[] => v.filter((x): x is string => typeof x === 'string' && x !== '');

/** The host a flow went to, lower-case: null for a hop (not a destination) or a flow with no host and no IP. */
function flowHost(f: FlowView): string | null {
  if (f.flags.hop) return null;
  return (f.dest.host ?? f.dest.ip)?.toLowerCase() || null;
}

const isOpen = (f: FlowView): boolean => f.tClose === null && (f.state === 'active' || f.state === 'pooled');

// ---------------------------------------------------------------- hosts

/** Adds `part` into `rows`: numbers add, lists unite, `scope` and `block` follow the larger count. */
function addHost(rows: Map<string, HostRow>, part: HostRow): void {
  const row = rows.get(part.host);
  if (!row) {
    rows.set(part.host, { ...part, ports: [...part.ports], clients: [...part.clients], tools: [...part.tools], services: [...part.services] });
    return;
  }
  if (part.count > row.count) {
    row.block = part.block;
    if (part.scope !== '') row.scope = part.scope;
  } else if (row.scope === '') row.scope = part.scope;
  row.sent += part.sent;
  row.received += part.received;
  row.count += part.count;
  row.open += part.open;
  row.blocked += part.blocked;
  row.untunnelled ||= part.untunnelled;
  row.first_seen_ago = Math.max(row.first_seen_ago, part.first_seen_ago);
  row.last_seen_ago = Math.min(row.last_seen_ago, part.last_seen_ago);
  row.ports = union(row.ports, part.ports, MAX_PORTS);
  row.clients = union(row.clients, part.clients, MAX_NAMES);
  row.tools = union(row.tools, part.tools, MAX_NAMES);
  row.services = union(row.services, part.services, MAX_NAMES);
}

/** Busiest first, ties by host; cut after sorting. */
function finishHosts(rows: Iterable<HostRow>): HostRow[] {
  return [...rows].sort((a, b) => b.count - a.count || cmp(a.host, b.host)).slice(0, GIBSON_MAX_HOSTS);
}

/** Gloved, with a window: one row per host among these connections. */
export function hostsFromFlows(flows: readonly FlowView[], now: number): HostRow[] {
  const rows = new Map<string, HostRow>();
  for (const f of flows) {
    const host = flowHost(f);
    if (!host) continue;
    addHost(rows, {
      host,
      block: blockOf(host),
      ports: typeof f.dest.port === 'number' ? [f.dest.port] : [],
      sent: f.bytes.up,
      received: f.bytes.down,
      count: 1,
      open: isOpen(f) ? 1 : 0,
      blocked: REFUSED.has(f.state) ? 1 : 0,
      untunnelled: untunnelled(f.scope, f.flags),
      scope: f.scope,
      first_seen_ago: ageOf(now, f.tOpen),
      last_seen_ago: ageOf(now, f.lastActivityAt),
      clients: compact(f.client),
      tools: compact(f.tool),
      services: compact(f.service),
    });
  }
  return finishHosts(rows.values());
}

/** Gloved, whole record: glove's running totals per destination, ports merged. */
export function hostsFromDestinations(dests: readonly DestinationAggregate[], now: number): HostRow[] {
  const rows = new Map<string, HostRow>();
  for (const d of dests) {
    // A null host is a service endpoint, not a destination.
    if (d.flags.hop || !d.host) continue;
    const host = d.host.toLowerCase();
    addHost(rows, {
      host,
      block: blockOf(host),
      ports: typeof d.port === 'number' ? [d.port] : [],
      sent: d.bytesUp,
      received: d.bytesDown,
      count: d.flows,
      open: d.openFlows,
      blocked: d.blocked,
      untunnelled: untunnelled(d.scope, d.flags),
      scope: d.scope,
      first_seen_ago: ageOf(now, d.firstSeen),
      last_seen_ago: ageOf(now, d.lastSeen),
      clients: [...d.clients],
      tools: [...d.tools],
      services: [...d.services],
    });
  }
  return finishHosts(rows.values());
}

/** The distinct hosts a call named, each with the ports it spelled or implied. */
function callHosts(c: TraceCall): Map<string, number[]> {
  const hosts = new Map<string, number[]>();
  for (const t of c.targets) {
    const host = t.host.toLowerCase();
    const port = targetPort(t);
    const ports = hosts.get(host) ?? [];
    if (port !== null && !ports.includes(port)) ports.push(port);
    hosts.set(host, ports);
  }
  return hosts;
}

/** Standard session: the hosts its tool calls named, for calls that started in [from, to]. A call counts once per host. */
export function hostsFromCalls(calls: readonly TraceCall[], from: number, to: number, now: number): HostRow[] {
  const rows = new Map<string, HostRow>();
  for (const c of calls) {
    if (c.start < from || c.start > to) continue;
    for (const [host, ports] of callHosts(c)) {
      addHost(rows, {
        host,
        block: blockOf(host),
        ports,
        sent: 0,
        received: 0,
        count: 1,
        open: c.end === null ? 1 : 0,
        blocked: 0,
        untunnelled: false,
        scope: '',
        first_seen_ago: ageOf(now, c.start),
        last_seen_ago: ageOf(now, c.start),
        clients: [],
        tools: [c.toolName],
        services: [],
      });
    }
  }
  return finishHosts(rows.values());
}

/** Several sources as one answer: the same host summed, sorted, capped. */
export function mergeHosts(parts: ReadonlyArray<readonly HostRow[]>): HostRow[] {
  const rows = new Map<string, HostRow>();
  for (const part of parts) for (const r of part) addHost(rows, r);
  return finishHosts(rows.values());
}

// ---------------------------------------------------------------- links

const linkKey = (source: string, via: string, target: string): string => `${source}\u0000${via}\u0000${target}`;

function addLink(rows: Map<string, LinkRow>, part: LinkRow): void {
  const key = linkKey(part.source, part.via, part.target);
  const row = rows.get(key);
  if (!row) {
    rows.set(key, { ...part });
    return;
  }
  row.sent += part.sent;
  row.received += part.received;
  row.count += part.count;
  row.open += part.open;
  row.blocked += part.blocked;
  row.last_seen_ago = Math.min(row.last_seen_ago, part.last_seen_ago);
}

function finishLinks(rows: Iterable<LinkRow>): LinkRow[] {
  return [...rows]
    .sort((a, b) => b.count - a.count || cmp(a.source, b.source) || cmp(a.via, b.via) || cmp(a.target, b.target))
    .slice(0, GIBSON_MAX_LINKS);
}

/** Gloved: one row per (client, gate, host) among these connections. */
export function linksFromFlows(flows: readonly FlowView[], now: number): LinkRow[] {
  const rows = new Map<string, LinkRow>();
  for (const f of flows) {
    const target = flowHost(f);
    if (!target) continue;
    addLink(rows, {
      source: f.client ?? 'harness',
      source_kind: 'client',
      via: f.service,
      target,
      sent: f.bytes.up,
      received: f.bytes.down,
      count: 1,
      open: isOpen(f) ? 1 : 0,
      blocked: REFUSED.has(f.state) ? 1 : 0,
      last_seen_ago: ageOf(now, f.lastActivityAt),
    });
  }
  return finishLinks(rows.values());
}

/** Standard session: the agent, through each tool, to each host the tool's calls named. */
export function linksFromCalls(calls: readonly TraceCall[], from: number, to: number, now: number): LinkRow[] {
  const rows = new Map<string, LinkRow>();
  for (const c of calls) {
    if (c.start < from || c.start > to) continue;
    for (const target of callHosts(c).keys()) {
      addLink(rows, {
        source: 'agent', source_kind: 'agent', via: c.toolName, target,
        sent: 0, received: 0, count: 1, open: c.end === null ? 1 : 0, blocked: 0, last_seen_ago: ageOf(now, c.start),
      });
    }
  }
  return finishLinks(rows.values());
}

export function mergeLinks(parts: ReadonlyArray<readonly LinkRow[]>): LinkRow[] {
  const rows = new Map<string, LinkRow>();
  for (const part of parts) for (const r of part) addLink(rows, r);
  return finishLinks(rows.values());
}

// ---------------------------------------------------------------- the log

/** Newest first, ties by host; cut to `limit`. */
function finishLog(rows: LogRow[], limit: number): LogRow[] {
  return rows.sort((a, b) => b.time - a.time || cmp(a.host, b.host)).slice(0, limit);
}

/** Every row of a source is built, then only the newest `GIBSON_MAX_LOG` are kept: a source never returns more than a request can ask for. */
export function logFromFlows(flows: readonly FlowView[], now: number, host?: string): LogRow[] {
  const want = host?.toLowerCase();
  const rows: LogRow[] = [];
  for (const f of flows) {
    const h = flowHost(f);
    if (!h || (want !== undefined && h !== want)) continue;
    rows.push({
      host: h,
      time: Math.floor(f.tOpen / 1000),
      ago: ageOf(now, f.tOpen),
      source: f.client ?? 'harness',
      via: f.service,
      tool: f.tool,
      port: f.dest.port,
      proto: f.proto,
      sent: f.bytes.up,
      received: f.bytes.down,
      state: f.state,
      blocked: REFUSED.has(f.state),
      rule: f.rule,
      // Present only when glove recorded in full, and already through the PII filter: never reformatted here.
      method: f.request?.method ?? null,
      url: f.request?.url ?? null,
      label: null,
    });
  }
  return finishLog(rows, GIBSON_MAX_LOG);
}

export function logFromCalls(calls: readonly TraceCall[], from: number, to: number, now: number, host?: string): LogRow[] {
  const want = host?.toLowerCase();
  const rows: LogRow[] = [];
  for (const c of calls) {
    if (c.start < from || c.start > to) continue;
    // One row per call and host: the first target that names it gives the port and scheme.
    const seen = new Set<string>();
    for (const t of c.targets) {
      const h = t.host.toLowerCase();
      if (seen.has(h) || (want !== undefined && h !== want)) continue;
      seen.add(h);
      rows.push({
        host: h,
        time: Math.floor(c.start / 1000),
        ago: ageOf(now, c.start),
        source: 'agent',
        via: c.toolName,
        tool: c.toolName,
        port: targetPort(t),
        proto: t.scheme ?? null,
        sent: 0,
        received: 0,
        state: c.end === null ? 'active' : c.failed ? 'broken' : 'finished',
        blocked: false,
        rule: null,
        method: null,
        url: null,
        // Never the call's own label: it is content (a query, a command line, a full URL).
        label: null,
      });
    }
  }
  return finishLog(rows, GIBSON_MAX_LOG);
}

export function mergeLog(parts: ReadonlyArray<readonly LogRow[]>, limit: number): LogRow[] {
  return finishLog(parts.flat(), limit);
}

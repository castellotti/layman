/**
 * The Topology tab's diagram, pure so it is
 * tested in node: which boxes exist in each column, where they sit, and the
 * bands between them. `components/network/TopologyView.tsx` only draws.
 *
 * Columns, left to right: the sandbox → glove's services (every one
 * session.json declares, including those it does not watch) → the policy wall
 * (where refusals end) → the route (local link, the declared tunnel, direct) →
 * the apparent origin (the exit, as glove verified it, or "not verified") →
 * destinations. Band width is the square root of bytes, colour is the route.
 *
 * Deterministic: fixed column x, services in glove's declared order (so the
 * column does not reshuffle as bytes change), destinations by bytes within
 * their route, then one overlap-avoidance pass per column. Nothing here looks
 * anything up; every label comes from glove's files or the user's rules.
 */
import type { NetSessionData } from './net-state.js';
import { isInferenceScope, isLlmUpstream, nextServices, type DestinationAggregate, type FlowView, type NetService, type Rule } from './netobs-types.js';
import { BLOCK_STATES, formatBytes } from './net-format.js';
import { guardReason, hostLabel, toolLabel } from './net-table.js';

export type ColumnId = 'sandbox' | 'services' | 'policy' | 'route' | 'origin' | 'dests';

export const COLUMN_LABELS: Readonly<Record<ColumnId, string>> = {
  sandbox: 'Sandbox', services: 'Gate services', policy: 'Policy', route: 'Route', origin: 'Apparent origin', dests: 'Destinations',
};

/** Where each column would like to start, as a share of the width (the design's, at 1080 px). */
const COLUMN_X: Readonly<Record<'sandbox' | 'services' | 'route' | 'origin', number>> = { sandbox: 0.03, services: 0.225, route: 0.53, origin: 0.7 };
/** The least room between a column's boxes and the next column, so bands have somewhere to bend. */
const MIN_GAP = { originToDests: 90, routeToOrigin: 40 };
const NODE_W: Readonly<Record<Exclude<ColumnId, 'policy'>, number>> = { sandbox: 130, services: 140, route: 130, origin: 140, dests: 130 };

/** Below this the diagram is laid out at this width and scaled down, never scrolled. */
export const MIN_WIDTH = 1000;
export const MIN_HEIGHT = 420;
const TOP = 52;
const BOTTOM_PAD = 16;
const MAX_BAND = 30;
const DEST_H = 22;
const DEST_MIN_PITCH = 26;
const DEST_MAX_PITCH = 50;
/** Room above and below the destination window for the "↑ N above" / "↓ N below" stubs. */
const STUB_ROOM = 18;

/** A band's colour, by route; refusals by who refused. */
export type BandKind = 'tunnel' | 'fanout' | 'local' | 'direct' | 'guard' | 'refused' | 'broken' | 'unwatched' | 'trigger';
export type NodeKind = 'sandbox' | 'service' | 'route' | 'exit' | 'broken' | 'dest';
export type Tone = 'plain' | 'tunnel' | 'fanout' | 'local' | 'direct' | 'warn' | 'muted';
export type LineTone = 'faint' | 'mono' | 'ok' | 'tunnel' | 'warn' | 'error' | 'fanout';

export interface TopoLine { text: string; tone: LineTone }

export interface TopoNode {
  id: string;
  kind: NodeKind;
  column: ColumnId;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** The title is a host or a service name: monospace. */
  mono: boolean;
  lines: TopoLine[];
  tone: Tone;
  /** Declared but not watched, a local link, or a route with no traffic. */
  dashed: boolean;
  icon: 'eye-off' | 'check' | 'broken' | null;
  /** Destination hosts reached through this box: what selecting it selects. */
  hosts: string[];
  live: boolean;
}

export interface TopoBand {
  id: string;
  kind: BandKind;
  from: string;
  to: string;
  /** An SVG path, drawn as a stroke `width` wide. */
  d: string;
  /** Where the path starts: the centre of the band as it leaves its box. */
  start: [number, number];
  width: number;
  bytes: number;
  hosts: string[];
  live: boolean;
  dashed: boolean;
  label: { text: string; x: number; y: number; anchor: 'start' | 'end' } | null;
  /**
   * A band into a destination: its far end with the column unscrolled (the near end is `start`).
   * `projectTopology` redraws `d` from these as the column scrolls; the far end follows its row.
   */
  toDest?: { x2: number; y2: number };
}

export interface WallLabel { text: string; sub: string | null; y: number; kind: 'guard' | 'refused' }

export interface TopoWall {
  x: number;
  y1: number;
  y2: number;
  labels: WallLabel[];
  /** `default allow · 1 rule`. */
  caption: string;
}

export interface Caption { text: string; x: number; y: number; anchor: 'start' | 'end'; kind: BandKind }

export interface Topology {
  width: number;
  height: number;
  columns: Array<{ id: ColumnId; label: string; x: number }>;
  nodes: TopoNode[];
  bands: TopoBand[];
  /** Free-standing text: the fan-out's bytes beside its service. */
  captions: Caption[];
  wall: TopoWall;
  /**
   * The destination column, which scrolls on its own: every reached destination has a row
   * (nothing is folded). Rows' `y` are as drawn unscrolled; the window is [`top`, `bottom`].
   */
  dests: DestColumn;
}

export interface DestColumn {
  x: number;
  w: number;
  top: number;
  bottom: number;
  /** How far the column scrolls: 0 when every row fits. */
  maxScroll: number;
  /** From one row to the next: what an arrow key scrolls. */
  pitch: number;
  /** Row ids (`dest:<key>`), top to bottom. */
  rows: string[];
}

/** How the rows in each group (local, the harness's, the fan-out's, direct) are ordered. */
export type DestSort = 'bytes' | 'name' | 'recent';

export type TopoInput = Pick<NetSessionData, 'token' | 'session' | 'gate' | 'exit' | 'destinations' | 'flows' | 'rules'>;

// ─── Small pure helpers ───────────────────────────────────────────────────────

/**
 * One overlap-avoidance pass: keep the given order, put each box as near its
 * wanted centre as the one above allows, then push the column back up if it
 * ran off the bottom. Returns each box's top.
 */
export function spread(items: ReadonlyArray<{ want: number; h: number }>, top: number, bottom: number, gap: number): number[] {
  const ys: number[] = [];
  let floor = top;
  for (const it of items) {
    const y = Math.max(floor, it.want - it.h / 2);
    ys.push(y);
    floor = y + it.h + gap;
  }
  let ceil = bottom;
  for (let i = items.length - 1; i >= 0; i--) {
    if (ys[i] + items[i].h > ceil) ys[i] = Math.max(top, ceil - items[i].h);
    ceil = ys[i] - gap;
  }
  return ys;
}

/** Width by the square root of bytes, relative to the busiest band. */
export function bandWidth(bytes: number, maxBytes: number): number {
  if (bytes <= 0 || maxBytes <= 0) return 1;
  return Math.max(1.5, MAX_BAND * Math.sqrt(bytes / maxBytes));
}

/** A horizontal S-curve from one box edge to the next. */
export function bandPath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  const f = (n: number) => n.toFixed(1);
  return `M${f(x1)},${f(y1)}C${f(mx)},${f(y1)} ${f(mx)},${f(y2)} ${f(x2)},${f(y2)}`;
}

/** `tcp:host.docker.internal:8080` or `http://egress-proxy:8888` → the host (and port, if asked). */
export function upstreamHost(upstream: string | null | undefined, withPort = false): string | null {
  if (!upstream) return null;
  const s = upstream.replace(/^(chain|tcp):/, '').replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (withPort) return s || null;
  return s.replace(/:\d+$/, '') || null;
}

/** `via-proxy:https://am.i.mullvad.net/json` → `am.i.mullvad.net`. */
export function exitSourceHost(source: string | null): string | null {
  if (!source) return null;
  const rest = source.replace(/^via-[a-z]+:/, '');
  return upstreamHost(rest) ?? rest;
}

/**
 * An egress consumer: a sidecar that goes out on the harness's behalf. Not the llm
 * extension's `llm-upstream`, which is the second leg of the harness's own model call
 * (drawn from the `llm` service, through llm-auth).
 */
const isFanoutService = (s: NetService | undefined) =>
  !!s && !isLlmUpstream(s) && (s.harness === false || s.client === 'searxng' || s.tool === 'search-engine-fanout');

/** A service the sandbox connects to itself: not a consumer, not the upstream leg behind a sidecar. */
const fromSandbox = (s: NetService | undefined) => !!s && !isFanoutService(s) && s.harness !== false;

/** `glove-<token>-llm-auth:8080` → `llm-auth`: the sidecar a hop ends at. */
function sidecarName(upstream: string | null | undefined, token: string): string | null {
  const host = upstreamHost(upstream);
  return host ? host.replace(`glove-${token}-`, '') : null;
}

/** The sidecar behind a hop, by the hop gate's upstream, else by the hop's own host. */
function hopSidecarName(hop: NetService, hopHost: string | null | undefined, token: string): string | null {
  return sidecarName(hop.upstream ?? hop.route?.upstream, token) ?? sidecarName(hopHost, token);
}

/** The hops into a gate: the services whose `next` (`nextServices`) names it. */
function hopsInto(name: string, services: readonly NetService[]): NetService[] {
  return services.filter((s) => nextServices(s, services).some((n) => n.service === name));
}

/**
 * `llm`: glove's llm link (`cloud`, or `lan` for the llm tool), which never rides the
 * tunnel and is expected. A `lan` host of a relay (ssh) is a LAN link: drawn local.
 */
type RouteId = 'local' | 'llm' | 'tunnel' | 'direct';

function routeOf(d: DestinationAggregate, svc: NetService | undefined): RouteId {
  if (d.scope === 'local' || d.flags.hop) return 'local';
  if (isInferenceScope(d.scope, d.tools[0] ?? svc?.tool)) return 'llm';
  if (d.scope === 'lan') return 'local';
  if (d.scope === 'direct') return 'direct';
  if (d.scope === 'tunnelled') return 'tunnel';
  const kind = svc?.route?.kind ?? (svc?.mode === 'tcp' ? 'tcp' : null);
  return kind === 'tcp' ? 'local' : kind === 'direct' ? 'direct' : 'tunnel';
}

/** A service's own route, for the sandbox → service band. */
function serviceRoute(s: NetService): RouteId {
  const kind = s.route?.kind ?? (s.mode === 'tcp' ? 'tcp' : null);
  if (kind === 'tcp' || s.scope === 'local' || s.scope === 'lan') return 'local';
  if (kind === 'direct') return 'direct';
  return 'tunnel';
}

/**
 * glove's netgate client labels for egress consumers (a sidecar that goes out on
 * the harness's behalf, `harness: false`): display name, what it carries, and
 * the tool service whose calls make it go out when the consumer's own `tool`
 * names none (`trigger`, matched on the service's `tool`; a service named
 * `<trigger>-mcp` is preferred, as that is the MCP harnesses' hop). The set is
 * open (glove's client label is any extension's name): an unknown one shows raw.
 * The relays (`github`, `ssh`) have no trigger service: their shims hand a shell
 * command to the sidecar through files, not the network. `llm` is here for its
 * name only: `llm-upstream` is drawn as the model call's second leg, not a consumer.
 */
const EGRESS_CLIENTS: Record<string, { name: string; what: string; why: string; trigger: string | null }> = {
  searxng: { name: 'SearXNG', what: 'search engine fan-out', why: 'triggered by a web search', trigger: 'web_search' },
  webfetch: { name: 'Web fetcher', what: 'page fetch or file download', why: 'triggered by a web fetch or download', trigger: 'web_fetch' },
  playwright: { name: 'Playwright', what: 'browser traffic', why: 'driven by a browser tool', trigger: null },
  github: { name: 'GitHub relay', what: 'GitHub traffic (gh, git push/fetch/clone)', why: 'driven by a gh or git shell command', trigger: 'gh' },
  ssh: { name: 'SSH relay', what: 'SSH to a host on your network', why: 'driven by an ssh shell command', trigger: 'ssh' },
  llm: { name: 'llm-auth', what: 'the model call, with the API key added', why: 'the harness’s own model request', trigger: null },
};

function clientName(client: string | null | undefined): string {
  if (!client) return 'another client';
  return EGRESS_CLIENTS[client]?.name ?? client;
}

/**
 * The harness service whose calls make an egress consumer go out, if glove declared one:
 * by the consumer's own tool first (`webdownload-egress` → `webdownload-mcp`, never the
 * fetch hop), then by its client's usual trigger (SearXNG's fan-out → the search service).
 */
function triggerOf(consumer: NetService, services: readonly NetService[]): NetService | null {
  const client = consumer.client ?? (consumer.tool === 'search-engine-fanout' ? 'searxng' : null);
  for (const tool of [consumer.tool ?? null, client ? EGRESS_CLIENTS[client]?.trigger ?? null : null]) {
    if (!tool) continue;
    const harness = services.filter((s) => s.tool === tool && fromSandbox(s));
    const hit = harness.find((s) => s.service.endsWith('-mcp')) ?? harness.find((s) => s.mode === 'tcp') ?? harness[0];
    if (hit) return hit;
  }
  return null;
}

/** Everything the gate declared, plus any service seen in traffic that it did not. */
export function topologyServices(data: Pick<TopoInput, 'session' | 'destinations'>): NetService[] {
  const out: NetService[] = [...(data.session?.services ?? [])];
  const known = new Set(out.map((s) => s.service));
  for (const d of data.destinations.values()) {
    for (const s of d.services) {
      if (known.has(s)) continue;
      known.add(s);
      out.push({ service: s, listen: null, observed: true, tool: d.tools[0] ?? null, client: d.clients[0] ?? null });
    }
  }
  return out;
}

/** How a destination's path ends. */
export type Outcome = 'refused' | 'broken' | 'reached';
export function outcomeOf(d: Pick<DestinationAggregate, 'state'>): Outcome {
  if (BLOCK_STATES.has(d.state)) return 'refused';
  return d.state === 'broken' ? 'broken' : 'reached';
}

/** One destination's traffic through one service. */
interface Leg {
  d: DestinationAggregate;
  host: string;
  service: string;
  bytes: number;
  outcome: Outcome;
  route: RouteId;
  fanout: boolean;
  live: boolean;
}

function legsOf(dests: Iterable<DestinationAggregate>, flows: Iterable<FlowView>, services: Map<string, NetService>): Leg[] {
  // A destination reached through two services splits its bytes by what the flows still held show.
  const split = new Map<string, Map<string, number>>();
  for (const f of flows) {
    if (!f.destKey) continue;
    const m = split.get(f.destKey) ?? new Map<string, number>();
    m.set(f.service, (m.get(f.service) ?? 0) + f.bytes.up + f.bytes.down);
    split.set(f.destKey, m);
  }
  const legs: Leg[] = [];
  for (const d of dests) {
    if (d.state === 'empty') continue;
    const svcs = d.services.length ? d.services : ['?'];
    const m = split.get(d.key);
    const known = m ? svcs.reduce((a, s) => a + (m.get(s) ?? 0), 0) : 0;
    const total = d.bytesUp + d.bytesDown;
    for (const s of svcs) {
      const share = known > 0 ? (m!.get(s) ?? 0) / known : 1 / svcs.length;
      const svc = services.get(s);
      legs.push({
        d, host: d.host ?? hostLabel(d), service: s, bytes: total * share, outcome: outcomeOf(d),
        route: routeOf(d, svc), fanout: d.flags.fanout || isFanoutService(svc), live: d.state === 'active',
      });
    }
  }
  return legs;
}

function ruleLabel(id: string, rules: readonly Rule[]): string {
  const r = rules.find((x) => x.id === id);
  if (r?.note) return `your rule “${r.note}”`;
  return `your rule ${id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id}`;
}

const nodeH = (lines: number) => 26 + 13 * lines;

/** `13601` → `13.6k`, so a busy service's counts fit its box. */
export function countLabel(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

// ─── The layout ───────────────────────────────────────────────────────────────

export function layoutTopology(data: TopoInput, width: number, height: number, opts: { sort?: DestSort } = {}): Topology {
  const W = Math.max(MIN_WIDTH, width);
  const H = Math.max(MIN_HEIGHT, height);
  const bottom = H - BOTTOM_PAD;
  // Destinations sit against the right edge; the origin and route columns keep their share of the
  // width unless that would leave their bands no room to bend; the wall goes in the gap before the route.
  const destX = W - NODE_W.dests - 6;
  const originX = Math.round(Math.min(W * COLUMN_X.origin, destX - MIN_GAP.originToDests - NODE_W.origin));
  const routeX = Math.round(Math.min(W * COLUMN_X.route, originX - MIN_GAP.routeToOrigin - NODE_W.route));
  const servicesX = Math.round(W * COLUMN_X.services);
  const policyX = Math.round(servicesX + NODE_W.services + (routeX - servicesX - NODE_W.services) * 0.45);
  const X: Record<ColumnId, number> = { sandbox: Math.round(W * COLUMN_X.sandbox), services: servicesX, policy: policyX, route: routeX, origin: originX, dests: destX };
  const colX = (c: ColumnId) => X[c];
  const columns = (Object.keys(COLUMN_LABELS) as ColumnId[]).map((id) => ({ id, label: COLUMN_LABELS[id], x: X[id] }));

  const services = topologyServices(data);
  const byName = new Map(services.map((s) => [s.service, s]));
  const allLegs = legsOf(data.destinations.values(), data.flows.values(), byName);
  // A hop to a sidecar (the `llm` hop to llm-auth, `webfetch-mcp` to the fetcher) is drawn as the link to the service it goes
  // on through, not as a route to a destination; refused, it still ends at the wall.
  const legs = allLegs.filter((l) => !(l.d.flags.hop && l.outcome !== 'refused'));
  const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];

  const nodes: TopoNode[] = [];
  const node = (n: Omit<TopoNode, 'hosts' | 'live' | 'icon' | 'dashed' | 'mono'> & Partial<Pick<TopoNode, 'hosts' | 'live' | 'icon' | 'dashed' | 'mono'>>): TopoNode => {
    const full: TopoNode = { hosts: [], live: false, icon: null, dashed: false, mono: false, ...n };
    nodes.push(full);
    return full;
  };
  const uniq = (xs: string[]) => [...new Set(xs)];

  // Services.
  const svcNodes: TopoNode[] = [];
  const svcItems = services.map((s) => {
    const mine = allLegs.filter((l) => l.service === s.service);
    const flows = new Set<string>();
    let nFlows = 0;
    let refused = 0;
    for (const l of mine) {
      if (flows.has(l.d.key)) continue;
      flows.add(l.d.key);
      nFlows += l.d.flows;
      refused += l.outcome === 'refused' ? Math.max(1, l.d.blocked) : 0;
    }
    const lines: TopoLine[] = [];
    if (!s.observed) {
      lines.push({ text: 'declared · not watched', tone: 'faint' });
    } else if (isFanoutService(s)) {
      lines.push({ text: `${clientName(s.client)} → gate`, tone: 'faint' });
      lines.push({ text: 'not the harness', tone: 'faint' });
    } else if (isLlmUpstream(s)) {
      lines.push({ text: `${clientName(s.client ?? 'llm')} → provider`, tone: 'faint' });
      if (nFlows) lines.push({ text: `${countLabel(nFlows)} flow${nFlows === 1 ? '' : 's'}${refused ? ` · ${countLabel(refused)} refused` : ''}`, tone: 'faint' });
    } else {
      const what = s.tool && s.tool !== s.service ? toolLabel(s.tool) : s.scope ?? null;
      lines.push({ text: [s.mode, what].filter(Boolean).join(' · ') || 'observed', tone: 'faint' });
      if (nFlows) lines.push({ text: `${countLabel(nFlows)} flow${nFlows === 1 ? '' : 's'}${refused ? ` · ${countLabel(refused)} refused` : ''}`, tone: 'faint' });
    }
    return { s, lines, hosts: uniq(mine.map((l) => l.host)), live: mine.some((l) => l.live) };
  });
  const svcTop = TOP + 10;
  const pitch = (bottom - svcTop) / Math.max(1, svcItems.length);
  const svcYs = spread(svcItems.map((it, i) => ({ want: svcTop + pitch * (i + 0.5), h: nodeH(it.lines.length) })), svcTop, bottom, 14);
  svcItems.forEach((it, i) => {
    const fan = isFanoutService(it.s);
    svcNodes.push(node({
      id: `svc:${it.s.service}`, kind: 'service', column: 'services', x: colX('services'), y: svcYs[i], w: NODE_W.services,
      h: nodeH(it.lines.length), title: it.s.service, mono: true, lines: it.lines,
      tone: !it.s.observed ? 'muted' : fan ? 'fanout' : 'plain', dashed: !it.s.observed, icon: it.s.observed ? null : 'eye-off',
      hosts: it.hosts, live: it.live,
    }));
  });
  const svcNode = new Map(svcNodes.map((n) => [n.title, n]));
  const centre = (n: TopoNode) => n.y + n.h / 2;

  // Sandbox: level with the harness's own services.
  const harnessSvc = svcNodes.filter((n) => fromSandbox(byName.get(n.title)));
  const span = harnessSvc.length ? [harnessSvc[0].y, harnessSvc[harnessSvc.length - 1].y + harnessSvc[harnessSvc.length - 1].h] : [TOP, bottom];
  const sbH = Math.max(120, Math.min(260, (span[1] - span[0]) * 0.6));
  const sbY = Math.max(TOP + 10, Math.min(bottom - sbH, (span[0] + span[1]) / 2 - sbH / 2));
  const harness = data.session?.harness;
  const sandbox = node({
    id: 'sandbox', kind: 'sandbox', column: 'sandbox', x: colX('sandbox'), y: sbY, w: NODE_W.sandbox, h: sbH,
    title: data.token, lines: [
      { text: harness ? `sandbox · ${harness}` : 'sandbox', tone: 'faint' },
      { text: 'no route out except', tone: 'faint' },
      { text: 'through the gate', tone: 'faint' },
    ], tone: 'tunnel', hosts: uniq(legs.filter((l) => !l.fanout).map((l) => l.host)), live: legs.some((l) => l.live && !l.fanout),
  });

  // Route column: local, the llm link, the declared tunnel, direct — in that order.
  const routeKind = data.gate.route.kind;
  const tunnelName = routeKind === 'tor' ? 'Tor tunnel' : routeKind === 'vpn' ? 'VPN tunnel' : 'Tunnel';
  const reachedOrBroken = legs.filter((l) => l.outcome !== 'refused');
  const want = (r: RouteId) => {
    const ls = reachedOrBroken.filter((l) => l.route === r);
    const srcs = ls.length ? ls.map((l) => svcNode.get(l.service)).filter((n): n is TopoNode => !!n)
      : svcNodes.filter((n) => { const s = byName.get(n.title); return !!s && s.observed && serviceRoute(s) === r; });
    return srcs.length ? srcs.reduce((a, n) => a + centre(n), 0) / srcs.length : null;
  };
  // Name the upstreams that carried traffic; with none yet, every local service's.
  const localSvcs = services.filter((s) => serviceRoute(s) === 'local');
  const usedLocal = localSvcs.filter((s) => reachedOrBroken.some((l) => l.route === 'local' && l.service === s.service));
  const localUp = uniq((usedLocal.length ? usedLocal : localSvcs).map((s) => upstreamHost(s.upstream ?? s.route?.upstream)).filter((x): x is string => !!x));
  const tunnelSvc = services.find((s) => s.observed && serviceRoute(s) === 'tunnel');
  const tunnelUp = upstreamHost(tunnelSvc?.route?.upstream ?? tunnelSvc?.upstream, true);
  const hasLocal = localUp.length > 0 || reachedOrBroken.some((l) => l.route === 'local');
  const hasTunnel = routeKind === 'vpn' || routeKind === 'tor' || reachedOrBroken.some((l) => l.route === 'tunnel');
  const directLegs = reachedOrBroken.filter((l) => l.route === 'direct');
  const health = data.gate.route.upstreamHealthy;
  type RouteSpec = { id: RouteId; title: string; lines: TopoLine[]; tone: Tone; dashed: boolean; icon: TopoNode['icon']; want: number };
  const specs: RouteSpec[] = [];
  if (hasLocal) {
    const lines: TopoLine[] = [];
    if (localUp.length) lines.push({ text: localUp.length > 1 ? `${localUp[0]} +${localUp.length - 1}` : localUp[0], tone: 'faint' });
    lines.push({ text: 'never mapped', tone: 'faint' });
    specs.push({ id: 'local', title: 'Local', lines, tone: 'local', dashed: false, icon: null, want: want('local') ?? TOP + 60 });
  }
  const llmLegs = reachedOrBroken.filter((l) => l.route === 'llm');
  if (llmLegs.length) {
    const lines: TopoLine[] = [];
    if (llmLegs.some((l) => l.d.scope === 'lan')) lines.push({ text: 'LAN · never mapped', tone: 'faint' });
    if (llmLegs.some((l) => l.d.scope === 'cloud')) lines.push({ text: 'cloud · not the tunnel', tone: 'faint' });
    specs.push({ id: 'llm', title: 'LLM link', lines, tone: 'local', dashed: false, icon: null, want: want('llm') ?? TOP + 60 });
  }
  if (hasTunnel) {
    const lines: TopoLine[] = [{ text: `declared: ${routeKind ?? 'unknown'}`, tone: 'faint' }];
    if (tunnelUp) lines.push({ text: tunnelUp, tone: 'mono' });
    if (data.gate.resolver.mode) lines.push({ text: `resolver ${data.gate.resolver.mode}`, tone: 'faint' });
    lines.push(health === true ? { text: 'upstream healthy', tone: 'ok' }
      : health === false ? { text: 'upstream unhealthy', tone: 'error' } : { text: 'upstream health unknown', tone: 'faint' });
    specs.push({ id: 'tunnel', title: tunnelName, lines, tone: 'tunnel', dashed: false, icon: null, want: want('tunnel') ?? (TOP + bottom) / 2 });
  }
  const directFlows = directLegs.reduce((a, l) => a + l.d.flows, 0);
  specs.push({
    id: 'direct', title: 'Direct',
    lines: directLegs.length ? [{ text: `${countLabel(directFlows)} flow${directFlows === 1 ? '' : 's'} · real IP`, tone: 'error' }] : [{ text: 'no traffic', tone: 'faint' }],
    tone: directLegs.length ? 'direct' : 'muted', dashed: !directLegs.length, icon: directLegs.length ? null : 'check', want: bottom,
  });
  const routeYs = spread(specs.map((s) => ({ want: s.want, h: nodeH(s.lines.length) })), TOP + 10, bottom, 20);
  const routeNode = new Map<RouteId, TopoNode>();
  specs.forEach((s, i) => {
    routeNode.set(s.id, node({
      id: `route:${s.id}`, kind: 'route', column: 'route', x: colX('route'), y: routeYs[i], w: NODE_W.route, h: nodeH(s.lines.length),
      title: s.title, lines: s.lines, tone: s.tone, dashed: s.dashed, icon: s.icon,
      hosts: uniq(reachedOrBroken.filter((l) => l.route === s.id).map((l) => l.host)),
      live: reachedOrBroken.some((l) => l.route === s.id && l.live),
    }));
  });

  // Apparent origin: the exit behind the tunnel, then one broken-path glyph per broken destination.
  const tunnel = routeNode.get('tunnel') ?? null;
  const exitRec = data.exit;
  const placed = !!exitRec?.healthy && !!exitRec.ip;
  const tunnelReached = legs.filter((l) => l.outcome === 'reached' && l.route === 'tunnel');
  const originSpecs: Array<{ id: string; kind: NodeKind; title: string; lines: TopoLine[]; tone: Tone; want: number; hosts: string[]; icon: TopoNode['icon']; mono: boolean; h: number }> = [];
  if (tunnel) {
    const lines: TopoLine[] = [];
    let title = 'Exit';
    if (placed && data.gate.route.verified) {
      title = exitRec!.country ?? exitRec!.city ?? 'Exit';
      lines.push({ text: 'exit verified', tone: 'faint' }, { text: exitRec!.ip!, tone: 'mono' });
      const src = exitSourceHost(exitRec!.source);
      if (src) lines.push({ text: `via ${src}`, tone: 'faint' });
      lines.push({ text: 'not Layman’s lookup', tone: 'faint' });
    } else if (data.gate.route.exitIdentityOff) {
      lines.push({ text: 'not verified', tone: 'warn' }, { text: 'exit identity is off', tone: 'faint' });
    } else {
      lines.push({ text: 'not verified', tone: 'warn' }, { text: exitRec && !exitRec.healthy ? 'the exit check failed' : 'no exit record yet', tone: 'faint' });
    }
    originSpecs.push({ id: 'exit', kind: 'exit', title, lines, tone: placed && data.gate.route.verified ? 'tunnel' : 'warn', want: centre(tunnel) + 40, hosts: uniq(tunnelReached.map((l) => l.host)), icon: null, mono: false, h: nodeH(lines.length) + 4 });
  }
  const broken = legs.filter((l) => l.outcome === 'broken');
  const brokenShown = broken.slice(0, 3);
  for (const l of brokenShown) {
    const from = routeNode.get(l.route);
    originSpecs.push({
      id: `broken:${l.d.key}`, kind: 'broken', title: hostLabel(l.d), lines: [{ text: 'upstream unreachable', tone: 'faint' }],
      tone: 'warn', want: (from ? centre(from) : bottom) + 150, hosts: [l.host], icon: 'broken', mono: true, h: 34,
    });
  }
  const originYs = spread(originSpecs.map((s) => ({ want: s.want, h: s.h })), TOP + 10, bottom, 24);
  const originNode = new Map<string, TopoNode>();
  originSpecs.forEach((s, i) => {
    originNode.set(s.id, node({
      id: `origin:${s.id}`, kind: s.kind, column: 'origin', x: colX('origin'), y: originYs[i], w: NODE_W.origin, h: s.h,
      title: s.title, lines: s.lines, tone: s.tone, hosts: s.hosts, icon: s.icon, mono: s.mono,
      live: s.kind === 'exit' && tunnelReached.some((l) => l.live),
    }));
  });
  const exitNode = originNode.get('exit') ?? null;

  // Destinations: local, then the harness's tunnelled, then the fan-out's, then direct; bytes within each.
  const group = (l: Leg) => (l.route === 'local' || l.route === 'llm' ? 0 : l.route === 'direct' ? 3 : l.fanout ? 2 : 1);
  const reached = new Map<string, { d: DestinationAggregate; legs: Leg[]; group: number; bytes: number }>();
  for (const l of legs) {
    if (l.outcome !== 'reached') continue;
    const e = reached.get(l.d.key) ?? { d: l.d, legs: [], group: group(l), bytes: 0 };
    e.legs.push(l);
    e.bytes += l.bytes;
    reached.set(l.d.key, e);
  }
  // Every destination has a row: the column scrolls (`projectTopology`) rather than fold any away.
  // The stubs' room is taken from the window only when the rows do not all fit in it without.
  const scrolls = reached.size * DEST_MIN_PITCH > bottom - (TOP + 4);
  const viewTop = scrolls ? TOP + STUB_ROOM : TOP + 4;
  const viewBottom = scrolls ? bottom - STUB_ROOM : bottom;
  const view = viewBottom - viewTop;
  const sort = opts.sort ?? 'bytes';
  const within = (a: { d: DestinationAggregate; bytes: number }, b: { d: DestinationAggregate; bytes: number }) =>
    sort === 'name' ? hostLabel(a.d).localeCompare(hostLabel(b.d)) : sort === 'recent' ? b.d.lastSeen - a.d.lastSeen : b.bytes - a.bytes;
  const rows = [...reached.values()].sort((a, b) => a.group - b.group || within(a, b) || a.d.key.localeCompare(b.d.key));
  const destPitch = Math.max(DEST_MIN_PITCH, Math.min(DEST_MAX_PITCH, view / Math.max(1, rows.length)));
  const stack = destPitch * rows.length;
  const destTop = viewTop + Math.max(0, (view - stack) / 2);
  const destNodes: Array<{ n: TopoNode; legs: Leg[] }> = [];
  const destOf = new Map<Leg, TopoNode>();
  rows.forEach((r, i) => {
    const d = r.d;
    const n = node({
      id: `dest:${d.key}`, kind: 'dest', column: 'dests', x: destX, y: destTop + i * destPitch + (destPitch - DEST_H) / 2, w: NODE_W.dests, h: DEST_H,
      title: hostLabel(d), mono: true, lines: [],
      tone: r.group === 0 ? 'local' : r.group === 3 ? 'direct' : r.group === 2 ? 'fanout' : 'tunnel',
      dashed: r.group === 0, hosts: [d.host ?? hostLabel(d)], live: d.state === 'active',
    });
    destNodes.push({ n, legs: r.legs });
    for (const l of r.legs) destOf.set(l, n);
  });
  const dests: DestColumn = {
    x: destX, w: NODE_W.dests, top: viewTop, bottom: viewBottom, maxScroll: Math.max(0, stack - view), pitch: destPitch, rows: destNodes.map((x) => x.n.id),
  };

  // The policy wall, level with the services that refused something, above their pass-through bands.
  const refusedLegs = legs.filter((l) => l.outcome === 'refused');
  const labels: Array<Omit<WallLabel, 'y'> & { key: string; legs: Leg[] }> = [];
  const guardLegs = refusedLegs.filter((l) => l.d.state === 'guard');
  if (guardLegs.length) {
    const reasons = uniq(guardLegs.map((l) => guardReason(l.d)).map((r) => (r === 'cloud metadata' ? 'metadata' : r === 'no destination' ? 'malformed' : r === 'internal name' || r === 'private address' ? 'internal' : r)));
    labels.push({ key: 'guard', kind: 'guard', text: `glove guard · ${countLabel(guardLegs.reduce((a, l) => a + Math.max(1, l.d.blocked), 0))}`, sub: reasons.join(', '), legs: guardLegs });
  }
  const byRule = new Map<string, Leg[]>();
  for (const l of refusedLegs) if (l.d.state === 'user_rule') byRule.set(l.d.rule ?? '?', [...(byRule.get(l.d.rule ?? '?') ?? []), l]);
  for (const [id, ls] of byRule) labels.push({ key: `rule:${id}`, kind: 'refused', text: `${ruleLabel(id, rules)} · ${countLabel(ls.reduce((a, l) => a + Math.max(1, l.d.blocked), 0))}`, sub: null, legs: ls });
  const defLegs = refusedLegs.filter((l) => l.d.state === 'default_block');
  if (defLegs.length) labels.push({ key: 'default', kind: 'refused', text: `default block · ${countLabel(defLegs.reduce((a, l) => a + Math.max(1, l.d.blocked), 0))}`, sub: 'no rule allowed it', legs: defLegs });
  const refusers = uniq(refusedLegs.map((l) => l.service)).map((s) => svcNode.get(s)).filter((n): n is TopoNode => !!n);
  const wallX = colX('policy');
  const LABEL_PITCH = 44;
  const firstRefuser = refusers.length ? Math.min(...refusers.map((n) => n.y)) : TOP + 40;
  const labelsBottom = firstRefuser - 18;
  const labelsTop = Math.max(TOP + 14, labelsBottom - LABEL_PITCH * Math.max(0, labels.length - 1));
  const wallLabels: WallLabel[] = labels.map((l, i) => ({ text: l.text, sub: l.sub, kind: l.kind, y: labelsTop + i * LABEL_PITCH }));
  const def = data.rules.enforced?.default ?? data.rules.file?.default ?? null;
  const wall: TopoWall = {
    x: wallX,
    y1: labels.length ? labelsTop - 12 : TOP + 6,
    y2: labels.length ? wallLabels[wallLabels.length - 1].y + 12 : TOP + 40,
    labels: wallLabels,
    caption: [def ? `default ${def}` : 'rules not read', `${rules.length} rule${rules.length === 1 ? '' : 's'}`].join(' · '),
  };

  // Bands. Widths are relative to the busiest band anywhere in the diagram.
  type Draft = { id: string; kind: BandKind; from: TopoNode; to: TopoNode | { x: number; y: number }; legs: Leg[]; dashed?: boolean; label?: TopoBand['label'] };
  const drafts: Draft[] = [];
  const kindOf = (l: Leg): BandKind => (l.fanout ? 'fanout' : l.route === 'local' || l.route === 'llm' ? 'local' : l.route === 'direct' ? 'direct' : 'tunnel');
  const byDraftId = new Map<string, Draft>();
  const bucket = (id: string, kind: BandKind, from: TopoNode, to: TopoNode, l: Leg) => {
    const found = byDraftId.get(id);
    if (found) found.legs.push(l);
    else {
      const dr = { id, kind, from, to, legs: [l] };
      byDraftId.set(id, dr);
      drafts.push(dr);
    }
  };
  for (const n of svcNodes) {
    const s = byName.get(n.title)!;
    if (!fromSandbox(s)) continue;
    const mine = allLegs.filter((l) => l.service === s.service);
    if (!s.observed) {
      drafts.push({ id: `sandbox>${n.id}`, kind: 'unwatched', from: sandbox, to: n, legs: [], dashed: true });
      continue;
    }
    const r = serviceRoute(s);
    drafts.push({ id: `sandbox>${n.id}`, kind: r === 'local' ? 'local' : r === 'direct' ? 'direct' : 'tunnel', from: sandbox, to: n, legs: mine });
  }
  for (const l of legs) {
    const s = svcNode.get(l.service);
    if (!s) continue;
    if (l.outcome === 'refused') {
      const lab = labels.findIndex((x) => x.legs.includes(l));
      drafts.push({ id: `${s.id}>wall:${l.d.key}`, kind: l.d.state === 'guard' ? 'guard' : 'refused', from: s, to: { x: wallX, y: wallLabels[lab].y }, legs: [l] });
      continue;
    }
    const r = routeNode.get(l.route)!;
    bucket(`${s.id}>${r.id}`, kindOf(l), s, r, l);
    if (l.outcome === 'broken') {
      const b = originNode.get(`broken:${l.d.key}`);
      if (b) drafts.push({ id: `${r.id}>${b.id}`, kind: 'broken', from: r, to: b, legs: [l], dashed: true });
      continue;
    }
    const dn = destOf.get(l);
    if (!dn) continue;
    if (l.route === 'tunnel' && exitNode) {
      bucket(`${r.id}>${exitNode.id}:${kindOf(l)}`, kindOf(l), r, exitNode, l);
      bucket(`${exitNode.id}>${dn.id}`, kindOf(l), exitNode, dn, l);
    } else {
      bucket(`${r.id}>${dn.id}`, kindOf(l), r, dn, l);
    }
  }
  const bytesOf = (dr: Draft) => dr.legs.reduce((a, l) => a + l.bytes, 0);
  const maxBytes = Math.max(0, ...drafts.map(bytesOf));

  // Ports: each box's bands leave its right edge (and enter its left) stacked in the order of the far end.
  const isNode = (t: Draft['to']): t is TopoNode => 'id' in t;
  const endY = (t: Draft['to']) => (isNode(t) ? centre(t) : t.y);
  const outPort = new Map<Draft, number>();
  const inPort = new Map<Draft, number>();
  const stackPorts = (n: TopoNode, ds: Draft[], other: (d: Draft) => number, into: Map<Draft, number>) => {
    const sorted = [...ds].sort((a, b) => other(a) - other(b));
    const ws = sorted.map((d) => bandWidth(bytesOf(d), maxBytes));
    const room = n.h - 8;
    const total = ws.reduce((a, w) => a + w, 0);
    const gap = sorted.length > 1 ? Math.max(0, Math.min(4, (room - total) / (sorted.length - 1))) : 0;
    const used = Math.min(room, total + gap * (sorted.length - 1));
    const scale = total + gap * (sorted.length - 1) > room && total > 0 ? (room - gap * (sorted.length - 1)) / total : 1;
    // Below a fifth of their width bands are hard to tell apart, so they keep that and overlap
    // instead: the stack is squeezed (`fit`) so it never leaves the box.
    const kept = ws.map((w) => w * Math.max(0.2, scale));
    const span = kept.reduce((a, w) => a + w, 0) + gap * (sorted.length - 1);
    const fit = span > room && span > 0 ? room / span : 1;
    let y = centre(n) - Math.min(used, span * fit) / 2;
    sorted.forEach((d, i) => {
      into.set(d, y + (kept[i] * fit) / 2);
      y += (kept[i] + gap) * fit;
    });
  };
  // Grouped once: with hundreds of destinations, filtering every draft per node is quadratic.
  const outOf = new Map<TopoNode, Draft[]>();
  const inTo = new Map<TopoNode, Draft[]>();
  const add = (m: Map<TopoNode, Draft[]>, n: TopoNode, d: Draft) => { const ds = m.get(n); if (ds) ds.push(d); else m.set(n, [d]); };
  for (const d of drafts) {
    add(outOf, d.from, d);
    if (isNode(d.to)) add(inTo, d.to, d);
  }
  for (const n of nodes) {
    const out = outOf.get(n);
    if (out) stackPorts(n, out, (d) => endY(d.to), outPort);
    const inc = inTo.get(n);
    if (inc) stackPorts(n, inc, (d) => centre(d.from), inPort);
  }

  const bands: TopoBand[] = drafts.map((dr) => {
    const bytes = bytesOf(dr);
    const x1 = dr.from.x + dr.from.w;
    const y1 = outPort.get(dr) ?? centre(dr.from);
    const x2 = isNode(dr.to) ? dr.to.x : dr.to.x;
    const y2 = isNode(dr.to) ? inPort.get(dr) ?? centre(dr.to) : dr.to.y;
    const width = dr.kind === 'unwatched' ? 1 : dr.kind === 'guard' || dr.kind === 'refused' ? 1.5 : bandWidth(bytes, maxBytes);
    let label: TopoBand['label'] = null;
    if (dr.from === sandbox && bytes > 0) label = { text: formatBytes(bytes), x: x1 + 8, y: y1 - width / 2 - 4, anchor: 'start' };
    return {
      id: dr.id, kind: dr.kind, from: dr.from.id, to: isNode(dr.to) ? dr.to.id : 'wall', d: bandPath(x1, y1, x2, y2), start: [x1, y1], width, bytes,
      hosts: uniq(dr.legs.map((l) => l.host)), live: dr.legs.some((l) => l.live), dashed: !!dr.dashed, label,
      ...(isNode(dr.to) && dr.to.kind === 'dest' ? { toDest: { x2, y2 } } : {}),
    };
  });

  // A hop that goes on through another gate (glove's `next`: `llm` → llm-auth → `llm-upstream`,
  // `webfetch-mcp` → fetcher → `webfetch-egress`): drawn from the hop's box to the next leg's and
  // named by the sidecar between them.
  for (const n of svcNodes) {
    const s = byName.get(n.title)!;
    const hopLegs = allLegs.filter((l) => l.service === s.service && l.d.flags.hop && l.outcome !== 'refused');
    const bytes = hopLegs.reduce((a, l) => a + l.bytes, 0);
    const via = hopSidecarName(s, hopLegs[0]?.host, data.token);
    for (const next of nextServices(s, services)) {
      const to = svcNode.get(next.service);
      if (!to) continue;
      const down = to.y >= n.y;
      const x = n.x + 50;
      const y1 = down ? n.y + n.h : n.y;
      const y2 = down ? to.y : to.y + to.h;
      const mid = (y1 + y2) / 2;
      bands.push({
        id: `${n.id}>${to.id}:hop`, kind: 'local', from: n.id, to: to.id,
        d: `M${x.toFixed(1)},${y1.toFixed(1)}C${(x + 16).toFixed(1)},${mid.toFixed(1)} ${(x - 16).toFixed(1)},${mid.toFixed(1)} ${x.toFixed(1)},${y2.toFixed(1)}`,
        start: [x, y1], width: bandWidth(bytes, maxBytes), bytes, hosts: uniq(hopLegs.map((l) => l.host)),
        live: hopLegs.some((l) => l.live), dashed: false,
        label: Math.abs(y2 - y1) > 24 ? { text: via ? `via ${via}` : 'via a sidecar', x: x + 10, y: mid + 4, anchor: 'start' } : null,
      });
    }
  }

  const captions: Caption[] = [];
  // Each egress consumer (SearXNG's fan-out, the web fetcher): labelled by what it carried, and
  // linked from the tool service that triggers it.
  for (const fanNode of svcNodes.filter((n) => isFanoutService(byName.get(n.title)))) {
    const fanBytes = legs.filter((l) => l.service === fanNode.title).reduce((a, l) => a + l.bytes, 0);
    // glove's `next` already links the hop to this consumer (drawn above): the label match
    // is only for a gate from before glove listed `next`.
    const linked = hopsInto(fanNode.title, services).some((s) => svcNode.has(s.service));
    const trigger = linked ? null : triggerOf(byName.get(fanNode.title)!, services);
    const search = trigger ? svcNodes.find((n) => n.title === trigger.service) : undefined;
    if (search) {
      const x = search.x + search.w - 50;
      const y1 = search.y + search.h;
      const y2 = fanNode.y;
      bands.push({
        id: `${search.id}>${fanNode.id}:trigger`, kind: 'trigger', from: search.id, to: fanNode.id,
        d: `M${x.toFixed(1)},${y1.toFixed(1)}C${(x + 16).toFixed(1)},${((y1 + y2) / 2).toFixed(1)} ${(x - 16).toFixed(1)},${((y1 + y2) / 2).toFixed(1)} ${x.toFixed(1)},${y2.toFixed(1)}`,
        start: [x, y1],
        width: 1, bytes: 0, hosts: [], live: false, dashed: true,
        // Just under the search box: halfway down, glove's declared order puts `proxy` over the word.
        label: y2 - y1 > 24 ? { text: 'triggers', x: x + 8, y: y1 + 14, anchor: 'start' } : null,
      });
    }
    if (fanBytes > 0) {
      // Above the fan-out's own band as it leaves the box: the sandbox's bands are labelled the same way.
      const out = bands.filter((b) => b.from === fanNode.id && b.kind === 'fanout');
      const top = out.length ? Math.min(...out.map((b) => b.start[1] - b.width / 2)) : fanNode.y;
      captions.push({ text: `${formatBytes(fanBytes)} via ${clientName(byName.get(fanNode.title)?.client)}`, x: fanNode.x + fanNode.w + 8, y: top - 5, anchor: 'start', kind: 'fanout' });
    }
  }

  return { width: W, height: H, columns, nodes, bands, captions, wall, dests };
}

// ─── Scrolling the destination column ─────────────────────────────────────────

/** Destinations scrolled out of the window on one side, as one stub the bands converge on. */
export interface DestStub {
  edge: 'above' | 'below';
  count: number;
  bytes: number;
  /** The sum of the widths of the bands it stands for. */
  width: number;
  /** Where the bands meet it: the window's edge. */
  y: number;
  /** The bar the bands meet, outside the window: as thick as they are, up to the stub's room. */
  bar: { y: number; h: number };
  /** The baseline of its "↓ 40 below · 3.1 MB" text. */
  textY: number;
  hosts: string[];
  /** The scroll that brings its nearest destination into the window: what a click on it does. */
  scrollTo: number;
}

export interface TopoProjection {
  /** The scroll applied, clamped to the column's. */
  scrollTop: number;
  /** Every band, those into a destination redrawn for the scroll. */
  bands: TopoBand[];
  /**
   * Destination row ids whose centre is in the window. A row half out is drawn (the window clips
   * it) but still counted on its stub until its centre is in, as its bands meet the edge until then.
   */
  visible: Set<string>;
  above: DestStub | null;
  below: DestStub | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** What a projection needs that does not depend on the scroll, worked out once per layout. */
interface DestIndex {
  rows: TopoNode[];
  byId: Map<string, TopoNode>;
  bytes: Map<string, number>;
  width: Map<string, number>;
}
const destIndexes = new WeakMap<Topology, DestIndex>();
function destIndex(t: Topology): DestIndex {
  let ix = destIndexes.get(t);
  if (ix) return ix;
  const byId = new Map(t.nodes.filter((n) => n.kind === 'dest').map((n) => [n.id, n]));
  ix = { rows: t.dests.rows.map((id) => byId.get(id)!), byId, bytes: new Map(), width: new Map() };
  for (const b of t.bands) {
    if (!b.toDest) continue;
    ix.bytes.set(b.to, (ix.bytes.get(b.to) ?? 0) + b.bytes);
    ix.width.set(b.to, (ix.width.get(b.to) ?? 0) + b.width);
  }
  destIndexes.set(t, ix);
  return ix;
}

/**
 * The diagram with its destination column scrolled to `scrollTop`. A band into a row in the
 * window ends at the row; one into a row scrolled out converges on the window's top or bottom
 * edge, where a stub stands for them all. The end is the row's centre clamped to the window, plus
 * the band's offset in the row's port stack, which shrinks to nothing over one row's height past
 * the edge. So it slides continuously as the row leaves or enters, never a jump, and a band into
 * a row in the window is never moved. Cheap enough to call every frame of a scroll.
 */
export function projectTopology(t: Topology, scrollTop: number): TopoProjection {
  const { top, bottom, maxScroll } = t.dests;
  const s = clamp(scrollTop, 0, maxScroll);
  const ix = destIndex(t);
  const visible = new Set<string>();
  const above: TopoNode[] = [];
  const below: TopoNode[] = [];
  for (const n of ix.rows) {
    const c = n.y + n.h / 2 - s;
    if (c < top) above.push(n);
    else if (c > bottom) below.push(n);
    else visible.add(n.id);
  }
  const bands = t.bands.map((b) => {
    if (!b.toDest) return b;
    const n = ix.byId.get(b.to)!;
    const c = n.y + n.h / 2 - s;
    const edge = clamp(c, top, bottom);
    const fade = Math.max(0, 1 - Math.abs(c - edge) / n.h);
    const y2 = edge + (b.toDest.y2 - (n.y + n.h / 2)) * fade;
    return y2 === b.toDest.y2 ? b : { ...b, d: bandPath(b.start[0], b.start[1], b.toDest.x2, y2) };
  });
  const stub = (edge: DestStub['edge'], ns: TopoNode[]): DestStub | null => {
    if (!ns.length) return null;
    const up = edge === 'above';
    // The nearest hidden row, brought just inside the window.
    const near = up ? ns[ns.length - 1] : ns[0];
    const scrollTo = clamp(up ? near.y - top - 4 : near.y + near.h - bottom + 4, 0, maxScroll);
    const width = ns.reduce((a, n) => a + (ix.width.get(n.id) ?? 0), 0);
    const y = up ? top : bottom;
    const h = Math.max(2, Math.min(STUB_ROOM - 4, width));
    return {
      edge, count: ns.length, y, scrollTo, width,
      bar: { y: up ? y - h : y, h }, textY: up ? y - 6 : y + 13,
      bytes: ns.reduce((a, n) => a + (ix.bytes.get(n.id) ?? 0), 0),
      hosts: ns.flatMap((n) => n.hosts),
    };
  };
  return { scrollTop: s, bands, visible, above: stub('above', above), below: stub('below', below) };
}

/** The scroll that centres a destination row in the window (clamped), or null for one with no row. */
export function scrollToDest(t: Topology, id: string): number | null {
  const n = destIndex(t).byId.get(id);
  if (!n) return null;
  return clamp(n.y + n.h / 2 - (t.dests.top + t.dests.bottom) / 2, 0, t.dests.maxScroll);
}

/** The scrollbar beside the destination column, for a scroll: null when nothing scrolls. */
export function scrollThumb(t: Topology, scrollTop: number): { x: number; w: number; track: { y: number; h: number }; y: number; h: number } | null {
  const { top, bottom, maxScroll } = t.dests;
  if (maxScroll <= 0) return null;
  const view = bottom - top;
  const h = Math.max(16, (view * view) / (view + maxScroll));
  return { x: t.dests.x + t.dests.w + 2, w: 3, track: { y: top, h: view }, y: top + ((view - h) * clamp(scrollTop, 0, maxScroll)) / maxScroll, h };
}

/** The scroll after dragging the thumb by `dy` (diagram units) from where it was at scroll `from`. */
export function thumbDrag(t: Topology, from: number, dy: number): number {
  const thumb = scrollThumb(t, from);
  if (!thumb) return 0;
  return clamp(from + (dy * t.dests.maxScroll) / Math.max(1, thumb.track.h - thumb.h), 0, t.dests.maxScroll);
}

/** The scroll a key moves the column to from `from`, or null for a key that does not scroll it. */
export function keyScroll(t: Topology, from: number, key: string): number | null {
  const { pitch, maxScroll, top, bottom } = t.dests;
  const page = Math.max(pitch, bottom - top - pitch);
  const to = key === 'ArrowDown' ? from + pitch : key === 'ArrowUp' ? from - pitch : key === 'PageDown' ? from + page : key === 'PageUp' ? from - page
    : key === 'Home' ? 0 : key === 'End' ? maxScroll : null;
  return to === null || maxScroll <= 0 ? null : clamp(to, 0, maxScroll);
}

/**
 * How far a wheel event scrolls, in diagram units: pixels scaled by `unitsPerPx`, lines as rows,
 * pages as the window (`deltaMode` 0, 1 and 2).
 */
export function wheelDelta(t: Topology, deltaY: number, deltaMode: number, unitsPerPx: number): number {
  return deltaY * (deltaMode === 1 ? t.dests.pitch : deltaMode === 2 ? t.dests.bottom - t.dests.top : unitsPerPx);
}

/**
 * One frame of an animated scroll from `from` towards `to`, `ms` after the last: a quarter of the
 * way per 60 Hz frame, whatever the frame rate, landing exactly once within half a unit.
 */
export function easeScroll(from: number, to: number, ms: number): number {
  const next = from + (to - from) * (1 - Math.pow(0.75, Math.max(0, ms) / (1000 / 60)));
  return Math.abs(to - next) < 0.5 ? to : next;
}

// ─── The Selected path panel ──────────────────────────────────────────────────

export type HopEvidence = 'observed' | 'declared' | 'verified' | 'refused' | 'broken' | 'none';

export interface Hop {
  /** `sidecar` and `upstream`: a model call through glove's llm-auth (`llm` → llm-auth → `llm-upstream`). */
  id: 'sandbox' | 'service' | 'sidecar' | 'upstream' | 'policy' | 'route' | 'exit' | 'dest' | 'broken';
  title: string;
  detail: string | null;
  /** Declared or verified, and by what: `declared vpn · upstream healthy`. */
  status: string;
  evidence: HopEvidence;
}

/**
 * Every hop of one destination's path, sandbox to destination, each with
 * whether glove observed it, only declared it, or verified it. Stops where the
 * path stopped: at the policy wall for a refusal, before the exit for a broken
 * path. Null when the host is not a destination of this session.
 */
export function pathHops(data: TopoInput, host: string): { dest: DestinationAggregate; hops: Hop[] } | null {
  const ds = [...data.destinations.values()].filter((d) => d.host === host).sort((a, b) => b.lastSeen - a.lastSeen);
  const d = ds[0];
  if (!d) return null;
  const services = topologyServices(data);
  const svc = services.find((s) => s.service === d.services[0]);
  const hops: Hop[] = [];
  const outcome = outcomeOf(d);
  // The leg a sidecar dials after a hop (glove's `next`): `llm` → llm-auth → `llm-upstream`,
  // `webfetch-mcp` → fetcher → `webfetch-egress`. The path starts at the harness's hop.
  const via = svc ? hopsInto(svc.service, services)[0] : undefined;
  const fan = !via && (d.flags.fanout || isFanoutService(svc));
  const g = data.gate;

  if (fan) {
    const info = EGRESS_CLIENTS[svc?.client ?? (d.flags.fanout ? 'searxng' : '')];
    hops.push({ id: 'sandbox', title: `${clientName(svc?.client)} (not the harness)`, detail: info?.what ?? 'egress on the harness’s behalf', status: info?.why ?? 'not a harness connection', evidence: 'observed' });
  } else {
    hops.push({
      id: 'sandbox', title: `${data.token} sandbox`, detail: data.session?.harness ? `${data.session.harness} harness` : null,
      status: g.freshness === 'running' ? `gate running${g.heartbeatAgeMs !== null ? ` · heartbeat ${Math.max(0, Math.round(g.heartbeatAgeMs / 1000))} s` : ''}` : `gate ${g.freshness}`,
      evidence: g.freshness === 'running' ? 'observed' : 'none',
    });
  }
  const serviceHop = (s: NetService | undefined, name: string): Omit<Hop, 'id'> => {
    const tool = s?.tool ?? d.tools[0];
    return {
      title: `${name} service`, detail: s?.listen ?? null,
      status: [s?.observed === false ? 'declared · not watched' : 'observed', tool ? toolLabel(tool) : null].filter(Boolean).join(' · '),
      evidence: s?.observed === false ? 'declared' : 'observed',
    };
  };
  // The harness reached the hop, and the sidecar behind it dialled out through this leg
  // (llm-auth adding the API key, the fetcher fetching the page).
  if (via) {
    let hopHost: string | null = null;
    for (const x of data.destinations.values()) if (x.flags.hop && x.services.includes(via.service)) { hopHost = x.host; break; }
    hops.push({ id: 'service', ...serviceHop(via, via.service) });
    hops.push({
      id: 'sidecar',
      // Named as Topology names its hop band.
      title: hopSidecarName(via, hopHost, data.token) ?? clientName(svc?.client),
      detail: EGRESS_CLIENTS[svc?.client ?? '']?.what ?? null,
      status: 'glove’s sidecar · not a gate', evidence: 'declared',
    });
  }
  hops.push({ id: via ? 'upstream' : 'service', ...serviceHop(svc, d.services[0] ?? 'unknown') });

  const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
  if (outcome === 'refused') {
    const detail = d.state === 'guard' ? guardReason(d) : d.state === 'user_rule' ? ruleLabel(d.rule ?? '?', rules) : 'no rule allowed it';
    hops.push({
      id: 'policy', title: 'Policy', detail,
      status: d.state === 'guard' ? 'refused by glove’s guard · never left' : d.state === 'user_rule' ? 'blocked by your rule · never left' : 'blocked by the default · never left',
      evidence: 'refused',
    });
    return { dest: d, hops };
  }
  const v = d.policy.enforced;
  hops.push({
    id: 'policy', title: 'Policy',
    detail: v?.rule ? `rule ${v.rule}` : 'no rule matched',
    status: v ? (v.action === 'allow' ? (v.rule ? 'allowed by your rule' : 'allowed by default') : 'now blocked: later flows will be refused') : 'allowed',
    evidence: 'observed',
  });

  const route = routeOf(d, svc);
  if (route === 'local' && d.scope === 'lan') {
    hops.push({ id: 'route', title: 'LAN link', detail: upstreamHost(svc?.upstream ?? svc?.route?.upstream, true), status: 'your local network · never tunnelled · never mapped', evidence: 'declared' });
  } else if (route === 'local') {
    hops.push({ id: 'route', title: 'Local link', detail: upstreamHost(svc?.upstream ?? svc?.route?.upstream, true), status: 'never leaves the machine · never mapped', evidence: 'declared' });
  } else if (route === 'llm') {
    const lan = d.scope === 'lan';
    hops.push({
      id: 'route', title: lan ? 'LAN link (LLM)' : 'LLM link', detail: upstreamHost(svc?.upstream ?? svc?.route?.upstream, true),
      status: lan ? 'glove’s llm link · your local network · never mapped' : 'glove’s llm link · not the tunnel', evidence: 'declared',
    });
  } else if (route === 'direct') {
    hops.push({ id: 'route', title: 'Direct', detail: 'no tunnel', status: 'the operator’s real IP', evidence: 'observed' });
  } else {
    const kind = g.route.kind;
    const health = g.route.upstreamHealthy === true ? 'upstream healthy' : g.route.upstreamHealthy === false ? 'upstream unhealthy' : 'upstream health unknown';
    hops.push({
      id: 'route', title: kind === 'tor' ? 'Tor tunnel' : kind === 'vpn' ? 'VPN tunnel' : 'Tunnel',
      detail: upstreamHost(svc?.route?.upstream ?? svc?.upstream, true), status: `declared ${kind ?? 'route'} · ${health}`, evidence: 'declared',
    });
    if (outcome === 'broken') {
      hops.push({ id: 'broken', title: 'Path broken', detail: 'upstream unreachable', status: 'ended before the exit', evidence: 'broken' });
      return { dest: d, hops };
    }
    const e = data.exit;
    if (e?.healthy && e.ip && g.route.verified) {
      hops.push({ id: 'exit', title: `Exit · ${e.country ?? e.city ?? e.ip}`, detail: e.ip, status: 'verified by exit identity', evidence: 'verified' });
    } else {
      hops.push({ id: 'exit', title: 'Exit', detail: null, status: g.route.exitIdentityOff ? 'not verified · exit identity is off' : 'not verified', evidence: 'declared' });
    }
  }
  if (outcome === 'broken') {
    hops.push({ id: 'broken', title: 'Path broken', detail: 'upstream unreachable', status: 'never reached the destination', evidence: 'broken' });
    return { dest: d, hops };
  }
  const where = d.geo ? [d.geo.city, d.geo.country].filter(Boolean).join(', ') || `${d.geo.lat.toFixed(2)}, ${d.geo.lon.toFixed(2)}` : null;
  hops.push({
    id: 'dest', title: hostLabel(d), detail: [d.ips[0], d.port !== null ? `:${d.port}` : null].filter(Boolean).join(' ') || null,
    status: where ? `${where} · offline lookup` : route === 'local' ? 'local link' : d.scope === 'lan' ? 'LAN link' : 'location unknown',
    evidence: 'observed',
  });
  return { dest: d, hops };
}

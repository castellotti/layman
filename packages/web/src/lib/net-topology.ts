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
import type { DestinationAggregate, FlowView, NetService, Rule } from './netobs-types.js';
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

/** A band's colour, by route; refusals by who refused. */
export type BandKind = 'tunnel' | 'fanout' | 'local' | 'direct' | 'guard' | 'refused' | 'broken' | 'unwatched' | 'trigger';
export type NodeKind = 'sandbox' | 'service' | 'route' | 'exit' | 'broken' | 'dest' | 'more';
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
  /** Destinations folded into "+N more" boxes to fit the height. */
  folded: number;
}

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

const isFanoutService = (s: NetService | undefined) =>
  !!s && (s.harness === false || s.client === 'searxng' || s.tool === 'search-engine-fanout');

/** `llm`: glove's llm link (`lan`/`cloud` scope), which never rides the tunnel and is expected. */
type RouteId = 'local' | 'llm' | 'tunnel' | 'direct';

function routeOf(d: DestinationAggregate, svc: NetService | undefined): RouteId {
  if (d.scope === 'local') return 'local';
  if (d.scope === 'lan' || d.scope === 'cloud') return 'llm';
  if (d.scope === 'direct') return 'direct';
  if (d.scope === 'tunnelled') return 'tunnel';
  const kind = svc?.route?.kind ?? (svc?.mode === 'tcp' ? 'tcp' : null);
  return kind === 'tcp' ? 'local' : kind === 'direct' ? 'direct' : 'tunnel';
}

/** A service's own route, for the sandbox → service band. */
function serviceRoute(s: NetService): RouteId {
  const kind = s.route?.kind ?? (s.mode === 'tcp' ? 'tcp' : null);
  if (kind === 'tcp' || s.scope === 'local') return 'local';
  if (kind === 'direct') return 'direct';
  return 'tunnel';
}

function clientName(client: string | null | undefined): string {
  if (!client) return 'another client';
  return client === 'searxng' ? 'SearXNG' : client;
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

export function layoutTopology(data: TopoInput, width: number, height: number): Topology {
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
  const legs = legsOf(data.destinations.values(), data.flows.values(), byName);
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
    const mine = legs.filter((l) => l.service === s.service);
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
  const harnessSvc = svcNodes.filter((n) => !isFanoutService(byName.get(n.title)));
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
  const avail = bottom - (TOP + 4);
  const cap = Math.max(4, Math.floor(avail / DEST_MIN_PITCH));
  const ordered = [...reached.values()].sort((a, b) => a.group - b.group || b.bytes - a.bytes || a.d.key.localeCompare(b.d.key));
  let shown = ordered;
  const more = new Map<number, typeof ordered>();
  if (ordered.length > cap) {
    // Keep the busiest; each group that loses some gets one "+N more" box, which takes a row too.
    for (let keep = cap - 1; keep >= 1; keep--) {
      const top = new Set([...ordered].sort((a, b) => b.bytes - a.bytes).slice(0, keep).map((e) => e.d.key));
      const groups = new Set(ordered.filter((e) => !top.has(e.d.key)).map((e) => e.group));
      if (keep + groups.size <= cap) {
        shown = ordered.filter((e) => top.has(e.d.key));
        for (const e of ordered) if (!top.has(e.d.key)) more.set(e.group, [...(more.get(e.group) ?? []), e]);
        break;
      }
    }
  }
  type Row = { kind: 'dest'; e: (typeof ordered)[number] } | { kind: 'more'; group: number; es: typeof ordered };
  const rows: Row[] = [];
  for (let g = 0; g <= 3; g++) {
    for (const e of shown) if (e.group === g) rows.push({ kind: 'dest', e });
    const m = more.get(g);
    if (m?.length) rows.push({ kind: 'more', group: g, es: m });
  }
  const destPitch = Math.max(DEST_MIN_PITCH, Math.min(DEST_MAX_PITCH, avail / Math.max(1, rows.length)));
  const stack = destPitch * rows.length;
  const destTop = TOP + 4 + Math.max(0, (avail - stack) / 2);
  const destNodes: Array<{ n: TopoNode; legs: Leg[] }> = [];
  rows.forEach((r, i) => {
    const y = destTop + i * destPitch + (destPitch - DEST_H) / 2;
    if (r.kind === 'dest') {
      const d = r.e.d;
      destNodes.push({
        legs: r.e.legs,
        n: node({
          id: `dest:${d.key}`, kind: 'dest', column: 'dests', x: destX, y, w: NODE_W.dests, h: DEST_H, title: hostLabel(d), mono: true, lines: [],
          tone: r.e.group === 0 ? 'local' : r.e.group === 3 ? 'direct' : r.e.group === 2 ? 'fanout' : 'tunnel',
          dashed: r.e.group === 0, hosts: [d.host ?? hostLabel(d)], live: d.state === 'active',
        }),
      });
    } else {
      destNodes.push({
        legs: r.es.flatMap((e) => e.legs),
        n: node({
          id: `more:${r.group}`, kind: 'more', column: 'dests', x: destX, y, w: NODE_W.dests, h: DEST_H, title: `+${r.es.length} more`, lines: [],
          tone: 'muted', dashed: true, hosts: r.es.map((e) => e.d.host ?? hostLabel(e.d)), live: r.es.some((e) => e.d.state === 'active'),
        }),
      });
    }
  });
  const folded = [...more.values()].reduce((a, es) => a + es.length, 0);

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
  const bucket = (id: string, kind: BandKind, from: TopoNode, to: TopoNode, l: Leg) => {
    const found = drafts.find((x) => x.id === id);
    if (found) found.legs.push(l);
    else drafts.push({ id, kind, from, to, legs: [l] });
  };
  for (const n of svcNodes) {
    const s = byName.get(n.title)!;
    if (isFanoutService(s)) continue;
    const mine = legs.filter((l) => l.service === s.service);
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
    const dn = destNodes.find((x) => x.legs.includes(l))?.n;
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
    let y = centre(n) - used / 2;
    sorted.forEach((d, i) => {
      const w = ws[i] * Math.max(0.2, scale);
      into.set(d, y + w / 2);
      y += w + gap;
    });
  };
  for (const n of nodes) {
    const out = drafts.filter((d) => d.from === n);
    if (out.length) stackPorts(n, out, (d) => endY(d.to), outPort);
    const inc = drafts.filter((d) => d.to === n);
    if (inc.length) stackPorts(n, inc, (d) => centre(d.from), inPort);
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
    };
  });

  const captions: Caption[] = [];
  // The fan-out: labelled by what it carried, and linked from the search service that triggers it.
  const fanNode = svcNodes.find((n) => isFanoutService(byName.get(n.title)));
  if (fanNode) {
    const fanBytes = legs.filter((l) => l.service === fanNode.title).reduce((a, l) => a + l.bytes, 0);
    const search = svcNodes.find((n) => byName.get(n.title)?.tool === 'web_search' || n.title === 'search');
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

  return { width: W, height: H, columns, nodes, bands, captions, wall, folded };
}

// ─── The Selected path panel ──────────────────────────────────────────────────

export type HopEvidence = 'observed' | 'declared' | 'verified' | 'refused' | 'broken' | 'none';

export interface Hop {
  id: 'sandbox' | 'service' | 'policy' | 'route' | 'exit' | 'dest' | 'broken';
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
  const fan = d.flags.fanout || isFanoutService(svc);
  const g = data.gate;

  if (fan) {
    hops.push({ id: 'sandbox', title: `${clientName(svc?.client)} (not the harness)`, detail: 'search engine fan-out', status: 'triggered by a web search', evidence: 'observed' });
  } else {
    hops.push({
      id: 'sandbox', title: `${data.token} sandbox`, detail: data.session?.harness ? `${data.session.harness} harness` : null,
      status: g.freshness === 'running' ? `gate running${g.heartbeatAgeMs !== null ? ` · heartbeat ${Math.max(0, Math.round(g.heartbeatAgeMs / 1000))} s` : ''}` : `gate ${g.freshness}`,
      evidence: g.freshness === 'running' ? 'observed' : 'none',
    });
  }
  hops.push({
    id: 'service', title: `${d.services[0] ?? 'unknown'} service`, detail: svc?.listen ?? null,
    status: [svc?.observed === false ? 'declared · not watched' : 'observed', d.tools[0] ? toolLabel(d.tools[0]) : null].filter(Boolean).join(' · '),
    evidence: svc?.observed === false ? 'declared' : 'observed',
  });

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
  if (route === 'local') {
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

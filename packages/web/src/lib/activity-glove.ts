/**
 * A gloved session's network stations, pure so it is tested in node. For a session behind a glove
 * gate the map does not guess the network from a command's name: its stations are the sandbox's own
 * services as glove declared them (`session.json` `services`), and each spoke wears by the bytes that
 * really went through it (`DestinationAggregate`s from the gate's records).
 *
 * Which services: those the sandbox itself connects to (`fromSandbox`: not an egress consumer such as
 * SearXNG's fan-out or the fetcher's own gate, which go out on its behalf) and that glove watches.
 * The model's link (tool `llm`, or the inference scopes) is the Model station's, never a network
 * station. A service whose tool is the browser wears the Browser station rather than adding one.
 * The bytes of the gates a service goes on through (`nextServices`: `search-mcp` → `searxng-egress`)
 * are that service's; a hop to a sidecar is counted once, at the next leg (its own `flags.hop`
 * destination is left out), as everywhere else in the network views. A sandbox service always owns
 * its own gate, whatever order glove declared them in. A destination several stations reached counts
 * at each (glove's aggregate does not say how much went through which), never split by a guess.
 * Stations of the same name are one; past `MAX_GATES` the quietest fold into one "Other gates", so
 * the ring stays within the sizes its label layout is tested for.
 */
import type { GateCallJoin, GateLooseFlow, GatesView, GateTraffic, NetService } from './netobs-types.js';
import type { Board } from './activity-board.js';
import type { StationId } from './station.js';
import type { TimelineEvent } from './types.js';
import { isInferenceScope, nextServices } from './netobs-types.js';
import { EGRESS_CLIENTS, fromSandbox, serviceRoute, triggerOf, type RouteId } from './net-topology.js';
import { toolLabel } from './net-table.js';
import { isUntunnelled } from './net-vpn.js';
import { plural } from './net-format.js';

/** The most gate stations a map shows (with Layman's ten, the ring's tested sixteen). */
export const MAX_GATES = 6;
/** The station the quietest gates fold into past `MAX_GATES`. */
const OTHER_GATES = 'gate:*';

export interface GateStation {
  /** `gate:<service>`, never a `StationId`. */
  id: string;
  service: string;
  /** What it is, by its tool: `Web fetch`, `SearXNG`, else glove's service name. */
  label: string;
  route: RouteId;
  /** Bytes up and down through it and the gates it goes on through. */
  bytes: number;
  flows: number;
  /** Flows a rule or glove's guard refused. */
  blocked: number;
  /** Flows that left untunnelled (`isUntunnelled`): the only ones that raise the alarm. */
  untunnelled: number;
}

export interface GloveStations {
  /** The network stations, in glove's declared order. */
  gates: GateStation[];
  /** Bytes a service whose tool is the browser carried, for the Browser station's spoke. */
  browserBytes: number;
  /** The map station each service's traffic is drawn on: a gate's id, or `browser`. */
  stationOf: Map<string, string>;
  /** The map station of each tool glove declared on a sandbox service (`web_fetch` → its gate). */
  toolStation: Map<string, string>;
  /** Flows that left untunnelled (`isUntunnelled`), over every destination: the alarm. */
  untunnelled: number;
}

/** What a gate is called on the map, by its tool. */
const GATE_NAME: Record<string, string> = {
  web_search: 'Web search', web_fetch: 'Web fetch', web_download: 'Downloads', gh: 'GitHub', ssh: 'SSH',
};

const isModelLink = (s: NetService): boolean => s.tool === 'llm' || isInferenceScope(s.scope ?? '', s.tool);
const isBrowser = (s: NetService): boolean => s.tool === 'browser' || s.client === 'playwright';

export function gateLabel(s: NetService): string {
  if (s.tool && GATE_NAME[s.tool]) return GATE_NAME[s.tool];
  if (s.client && EGRESS_CLIENTS[s.client]) return EGRESS_CLIENTS[s.client].name;
  return s.tool ? toolLabel(s.tool) : s.service;
}

/** Every gate a service's traffic goes on through, itself included, following `next` transitively. */
function reach(s: NetService, services: readonly NetService[]): Set<string> {
  const out = new Set<string>([s.service]);
  const queue = [s];
  while (queue.length > 0) {
    for (const n of nextServices(queue.pop(), services)) {
      if (!out.has(n.service)) { out.add(n.service); queue.push(n); }
    }
  }
  return out;
}

type Sum = Pick<GateStation, 'bytes' | 'flows' | 'blocked' | 'untunnelled'>;
const zero = (): Sum => ({ bytes: 0, flows: 0, blocked: 0, untunnelled: 0 });
const add = (a: Sum, b: Sum): void => { a.bytes += b.bytes; a.flows += b.flows; a.blocked += b.blocked; a.untunnelled += b.untunnelled; };

/** A gloved session's stations from its declared services and the destinations its gate recorded. */
export function gloveStations(services: readonly NetService[], destinations: Iterable<GateTraffic>): GloveStations {
  const own = services.filter((s) => s.observed !== false && fromSandbox(s) && !isModelLink(s));
  // Each gate's bytes go to the sandbox service that reaches it: itself, then by `next`, else the
  // consumer's trigger (a glove from before `next`), else nobody (a consumer nothing on the map drives).
  const owner = new Map<string, NetService>(own.map((s) => [s.service, s]));
  for (const s of own) for (const name of reach(s, services)) if (!owner.has(name)) owner.set(name, s);
  for (const s of services) {
    if (owner.has(s.service)) continue;
    const trigger = triggerOf(s, services);
    if (trigger && own.includes(trigger)) owner.set(s.service, trigger);
  }

  const sums = new Map<NetService, Sum>();
  let untunnelled = 0;
  for (const d of destinations) {
    if (d.flags.hop) continue;
    const traffic: Sum = {
      bytes: d.bytesUp + d.bytesDown, flows: d.flows, blocked: d.blocked,
      untunnelled: isUntunnelled(d.scope, d.flags) ? d.flows : 0,
    };
    untunnelled += traffic.untunnelled;
    const by = new Set(d.services.flatMap((name) => owner.get(name) ?? []));
    for (const s of by) {
      const sum = sums.get(s) ?? zero();
      add(sum, traffic);
      sums.set(s, sum);
    }
  }

  let browserBytes = 0;
  const byLabel = new Map<string, GateStation>();
  const placed = new Map<NetService, string>();
  for (const s of own) {
    const sum = sums.get(s) ?? zero();
    if (isBrowser(s)) { browserBytes += sum.bytes; placed.set(s, 'browser'); continue; }
    const label = gateLabel(s);
    const same = byLabel.get(label);
    if (same) { add(same, sum); placed.set(s, same.id); continue; }
    // The route its traffic leaves by: a hop to a sidecar is local, the gate it goes on through is not.
    const out = nextServices(s, services)[0] ?? s;
    byLabel.set(label, { id: `gate:${s.service}`, service: s.service, label, route: serviceRoute(out), ...sum });
    placed.set(s, `gate:${s.service}`);
  }
  let gates = [...byLabel.values()];
  if (gates.length > MAX_GATES) {
    // Keep the busiest in glove's order; the rest are one station.
    const kept = new Set([...gates].sort((a, b) => b.bytes - a.bytes || b.flows - a.flows).slice(0, MAX_GATES - 1));
    const rest = gates.filter((g) => !kept.has(g));
    const other: GateStation = { id: OTHER_GATES, service: rest.map((g) => g.service).join(', '), label: 'Other gates', route: worst(rest), ...zero() };
    for (const g of rest) add(other, g);
    const folded = new Set(rest.map((g) => g.id));
    for (const [s, id] of placed) if (folded.has(id)) placed.set(s, OTHER_GATES);
    gates = [...gates.filter((g) => kept.has(g)), other];
  }
  const stationOf = new Map<string, string>();
  for (const [name, s] of owner) { const id = placed.get(s); if (id) stationOf.set(name, id); }
  const toolStation = new Map<string, string>();
  for (const s of own) { const id = placed.get(s); if (s.tool && id && !toolStation.has(s.tool)) toolStation.set(s.tool, id); }
  return { gates, browserBytes, stationOf, toolStation, untunnelled };
}

/** The route a folded station shows: direct if any leaves direct, else tunnel if any, else local. */
function worst(gates: readonly GateStation[]): RouteId {
  for (const r of ['direct', 'tunnel', 'llm'] as const) if (gates.some((g) => g.route === r)) return r;
  return 'local';
}

/** What the map shows of a gloved session: its gate stations, its calls' joins, loose flows and the exit. */
export interface GloveMap {
  stations: GloveStations;
  /** Each call's join, by its event id. */
  calls: Map<string, GateCallJoin>;
  loose: GateLooseFlow[];
  exit: GatesView['exit'];
  route: GatesView['route'];
}

export function gloveMap(view: GatesView): GloveMap {
  return {
    stations: gloveStations(view.services, view.destinations),
    calls: new Map(view.calls.map((c) => [c.eventId, c])),
    loose: view.loose, exit: view.exit, route: view.route,
  };
}

/** A harness's tool name as glove names a service's tool: `WebFetch` → `web_fetch`. */
const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Where a gloved session's network call is drawn (`BoardOptions.place`): on the station of the
 * first gate its flows went through (Trace's join), else on the gate glove declared for its tool
 * (pi's `web_fetch` → the gate whose tool is `web_fetch`), else on Network. Only a network call
 * moves: an install that downloads is still Shell's, whatever its connections.
 */
export function placeCalls(g: GloveMap): (event: TimelineEvent, station: StationId) => string | null {
  return (event, station) => {
    if (station !== 'network') return null;
    for (const service of g.calls.get(event.id)?.services ?? []) {
      const at = g.stations.stationOf.get(service);
      if (at) return at;
    }
    const tool = event.data.toolName;
    return tool ? g.stations.toolStation.get(tool) ?? g.stations.toolStation.get(snake(tool)) ?? null : null;
  };
}

/** A pulse glove's records add, before its lane is chosen (`pulsesOf`'s `extra`). */
export interface GlovePulse {
  key: string;
  station: string;
  hollow: boolean;
  bad: boolean;
  age: number;
}

/**
 * The pulses glove's records add to the board's: Tool egress a call set off (SearXNG's fan-out),
 * hollow, out along the call's gate; and each flow no call claimed, hollow, red when refused.
 * `refused` names the calls with a refused connection, whose own pulses are drawn red.
 */
export function glovePulses(g: GloveMap, board: Board, now: number, pulseMs: number): { extra: GlovePulse[]; refused: Set<string> } {
  const extra: GlovePulse[] = [];
  const refused = new Set<string>();
  for (const e of board.entries) {
    const join = g.calls.get(e.eventId);
    if (!join) continue;
    if (join.refused > 0) refused.add(e.eventId);
    const age = now - e.startedAt;
    if (join.egress > 0 && age >= 0 && age < pulseMs) extra.push({ key: `${e.eventId}:egress`, station: e.on, hollow: true, bad: false, age });
  }
  g.loose.forEach((f, i) => {
    const station = g.stations.stationOf.get(f.service);
    const age = now - f.t;
    if (station && age >= 0 && age < pulseMs) extra.push({ key: `loose:${f.service}:${f.t}:${i}`, station, hollow: true, bad: f.refused, age });
  });
  return { extra, refused };
}

/** How the exit ring is drawn: the alarm, a verified tunnel, a tunnel not verified, a local route, or no word yet. */
export type ExitTone = 'alarm' | 'tunnel' | 'unverified' | 'local' | 'none';

/**
 * Where a gloved session's traffic leaves, for the ring around the map and the header. The alarm
 * is raised only by flows that left untunnelled (`isUntunnelled`, through `untunnelled`), never by
 * the route's kind: a direct or corporate route whose traffic all rode known VPN routes is local.
 */
export function exitRing(g: GloveMap): { tone: ExitTone; words: string; alarm: string | null } {
  const n = g.stations.untunnelled;
  const alarm = n > 0 ? plural(n, 'untunnelled connection') : null;
  const kind = g.route?.kind ?? g.exit?.kind ?? null;
  const place = [g.exit?.city, g.exit?.country].filter(Boolean).join(', ');
  const tunnelled = kind === 'vpn' || kind === 'tor';
  const verified = tunnelled && !!g.route?.verified && g.exit?.healthy !== false;
  const words = !kind ? 'exit unknown'
    : tunnelled ? `exit ${verified && place ? place : 'not verified'} · ${kind}`
    : `exit ${kind}${place ? ` · ${place}` : ''}`;
  const tone: ExitTone = alarm ? 'alarm' : !kind ? 'none' : tunnelled ? (verified ? 'tunnel' : 'unverified') : 'local';
  return { tone, words, alarm };
}

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
import type { DestinationAggregate, FlowFlags, NetService } from './netobs-types.js';
import { isInferenceScope, nextServices } from './netobs-types.js';
import { EGRESS_CLIENTS, fromSandbox, serviceRoute, triggerOf, type RouteId } from './net-topology.js';
import { toolLabel } from './net-table.js';
import { isUntunnelled } from './net-vpn.js';

/** A destination as the gates endpoint gives it: who reached it, and how much. */
export type GateTraffic = Pick<DestinationAggregate, 'services' | 'bytesUp' | 'bytesDown' | 'flows' | 'blocked' | 'scope'>
  & { flags: Pick<FlowFlags, 'hop' | 'vpn'> };

/** `GET /api/net/sessions/:token/gates`. */
export interface GatesResponse {
  services: NetService[];
  destinations: GateTraffic[];
}

/** The most gate stations a map shows (with Layman's ten, the ring's tested sixteen). */
export const MAX_GATES = 6;

export interface GateStation {
  /** `gate:<service>`, never a `StationId`. */
  id: string;
  service: string;
  /** What it is, by its tool: `Web fetch`, `SearXNG`, else glove's service name. */
  label: string;
  tool: string | null;
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
  for (const d of destinations) {
    if (d.flags.hop) continue;
    const traffic: Sum = {
      bytes: d.bytesUp + d.bytesDown, flows: d.flows, blocked: d.blocked,
      untunnelled: isUntunnelled(d.scope, d.flags) ? d.flows : 0,
    };
    const by = new Set(d.services.flatMap((name) => owner.get(name) ?? []));
    for (const s of by) {
      const sum = sums.get(s) ?? zero();
      add(sum, traffic);
      sums.set(s, sum);
    }
  }

  let browserBytes = 0;
  const byLabel = new Map<string, GateStation>();
  for (const s of own) {
    const sum = sums.get(s) ?? zero();
    if (isBrowser(s)) { browserBytes += sum.bytes; continue; }
    const label = gateLabel(s);
    const same = byLabel.get(label);
    if (same) { add(same, sum); continue; }
    // The route its traffic leaves by: a hop to a sidecar is local, the gate it goes on through is not.
    const out = nextServices(s, services)[0] ?? s;
    byLabel.set(label, { id: `gate:${s.service}`, service: s.service, label, tool: s.tool ?? null, route: serviceRoute(out), ...sum });
  }
  let gates = [...byLabel.values()];
  if (gates.length > MAX_GATES) {
    // Keep the busiest in glove's order; the rest are one station.
    const kept = new Set([...gates].sort((a, b) => b.bytes - a.bytes || b.flows - a.flows).slice(0, MAX_GATES - 1));
    const rest = gates.filter((g) => !kept.has(g));
    const other: GateStation = { id: 'gate:*', service: rest.map((g) => g.service).join(', '), label: 'Other gates', tool: null, route: worst(rest), ...zero() };
    for (const g of rest) add(other, g);
    gates = [...gates.filter((g) => kept.has(g)), other];
  }
  return { gates, browserBytes };
}

/** The route a folded station shows: direct if any leaves direct, else tunnel if any, else local. */
function worst(gates: readonly GateStation[]): RouteId {
  for (const r of ['direct', 'tunnel', 'llm'] as const) if (gates.some((g) => g.route === r)) return r;
  return 'local';
}

/**
 * What the Details panel says about one box of the Topology diagram: what the
 * box is for (the explanation the panel can dismiss), the facts glove's files
 * give about it, and the traffic through it (bytes by route, its busiest
 * destinations, the exits it has had). Pure, so it is tested in node; the
 * panel only draws it. Every number comes from the session's destinations, the
 * same aggregates the diagram is drawn from, so a box never disagrees with its
 * bands. Nothing here looks anything up.
 */
import type { NetSessionData } from './net-state.js';
import type { DestinationAggregate, NetService, NetState, RuleMatch } from './netobs-types.js';
import {
  EGRESS_CLIENTS, clientName, exitSourceHost, fromSandbox, hopsInto, isFanoutService, outcomeOf, routeOf, ruleLabel, serviceRoute,
  serviceShares, topologyServices, triggerOf, upstreamHost, type Outcome, type Topology, type TopoInput,
} from './net-topology.js';
import { formatStamp } from './net-range.js';
import { plural } from './net-format.js';
import { guardReason, hostLabel, toolLabel } from './net-table.js';
import { isLlmUpstream, nextServices } from './netobs-types.js';

export type BoxKind = 'sandbox' | 'service' | 'route' | 'exit' | 'policy' | 'dest' | 'broken';

export interface BoxExplanation { heading: string; body: string }

export interface BoxFact {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'warn' | 'error' | 'faint';
}

/** A slice of the bytes through a box, by how they left. */
export type MixKey = 'local' | 'tunnel' | 'fanout' | 'vpn' | 'direct' | 'broken';
export interface MixPart { key: MixKey; label: string; bytes: number; destinations: number }

/** One host's traffic through a box (its ports and endpoints summed). */
export interface TopDest {
  /** What it is called: the host, or `hostLabel` for one with no host (a malformed request). */
  label: string;
  /** The host to follow its path by, or null for one with no host (nothing to follow). */
  host: string | null;
  bytes: number;
  flows: number;
  /** Refused flows (`blocked`, at least one for a refused destination). */
  refused: number;
  state: NetState;
  /** How it left (its band's colour), or `refused` for one the gate stopped. */
  key: MixKey | 'refused';
}

/** One exit glove recorded (exit.ndjson), newest first: the tunnel's history. */
export interface ExitSeen { ip: string | null; where: string | null; t: string; healthy: boolean }

export interface BoxDetails {
  id: string;
  kind: BoxKind;
  title: string;
  mono: boolean;
  explain: BoxExplanation;
  facts: BoxFact[];
  totals: { up: number; down: number; flows: number; refused: number; live: number; destinations: number };
  /** Bytes by route, largest first; empty when nothing moved. */
  mix: MixPart[];
  /** The busiest destinations (most refused, for a policy label), at most `TOP_N`. */
  top: TopDest[];
  /** Hosts not in `top`. */
  more: number;
  /** The exit box only: every exit record, newest first. */
  exits: ExitSeen[];
}

export const TOP_N = 8;

const MIX_LABEL: Readonly<Record<MixKey, string>> = {
  local: 'Local link', tunnel: 'Tunnel', fanout: 'Fan-out', vpn: 'Your VPN', direct: 'Direct (real IP)', broken: 'Broken',
};
const MIX_ORDER: readonly MixKey[] = ['tunnel', 'fanout', 'local', 'vpn', 'direct', 'broken'];

const destHost = (d: DestinationAggregate) => d.host ?? hostLabel(d);

/** How one destination's bytes left, as the diagram colours its band. */
export function mixKey(d: DestinationAggregate, services: readonly NetService[]): MixKey {
  if (outcomeOf(d) === 'broken') return 'broken';
  const svc = services.find((s) => s.service === d.services[0]);
  const route = routeOf(d, svc);
  if (route === 'direct') return d.flags.vpn ? 'vpn' : 'direct';
  if (route === 'local' || route === 'llm') return 'local';
  return d.flags.fanout || isFanoutService(svc) ? 'fanout' : 'tunnel';
}

/**
 * The traffic of the destinations through a box. `share` is the part of a destination's bytes and
 * flows that went through the box (a service's share of a destination it shares, as the bands are
 * split); 1 for any other box. Rows are one per host, its ports and endpoints summed.
 */
function traffic(dests: DestinationAggregate[], services: readonly NetService[], byRefusals: boolean, share: (d: DestinationAggregate) => number = () => 1) {
  const totals = { up: 0, down: 0, flows: 0, refused: 0, live: 0, destinations: 0 };
  const mix = new Map<MixKey, MixPart & { hosts: Set<string> }>();
  const rows = new Map<string, TopDest>();
  for (const d of dests) {
    const k = share(d);
    const up = d.bytesUp * k;
    const down = d.bytesDown * k;
    const flows = Math.round(d.flows * k);
    totals.up += up;
    totals.down += down;
    totals.flows += flows;
    const refused = outcomeOf(d) === 'refused';
    const refusals = refused ? Math.max(1, d.blocked) : d.blocked;
    if (refused) totals.refused += refusals;
    const key = refused ? 'refused' as const : mixKey(d, services);
    const label = destHost(d);
    const row = rows.get(label);
    if (row) {
      row.bytes += up + down;
      row.flows += flows;
      row.refused += refusals;
      if (d.state === 'active') row.state = 'active';
    } else {
      rows.set(label, { label, host: d.host, bytes: up + down, flows, refused: refusals, state: d.state, key });
    }
    if (key === 'refused') continue;
    const part = mix.get(key) ?? { key, label: MIX_LABEL[key], bytes: 0, destinations: 0, hosts: new Set<string>() };
    part.bytes += up + down;
    part.hosts.add(label);
    mix.set(key, part);
  }
  const list = [...rows.values()];
  totals.destinations = list.length;
  totals.live = list.filter((r) => r.state === 'active').length;
  list.sort((a, b) => (byRefusals ? b.refused - a.refused : 0) || b.bytes - a.bytes || a.label.localeCompare(b.label));
  return {
    totals,
    mix: [...mix.values()].filter((p) => p.bytes > 0).map(({ hosts, ...p }) => ({ ...p, destinations: hosts.size }))
      .sort((a, b) => b.bytes - a.bytes || MIX_ORDER.indexOf(a.key) - MIX_ORDER.indexOf(b.key)),
    top: list.slice(0, TOP_N),
    more: Math.max(0, list.length - TOP_N),
  };
}

function matchText(m: RuleMatch): string {
  return Object.entries(m).map(([k, v]) => `${k} ${v}`).join(' · ') || 'everything';
}

const gateText = (data: TopoInput) => {
  const g = data.gate;
  const beat = g.heartbeatAgeMs !== null ? ` · heartbeat ${Math.max(0, Math.round(g.heartbeatAgeMs / 1000))} s ago` : '';
  return `${g.freshness}${g.freshness === 'running' ? beat : ''}`;
};

// ─── Explanations ─────────────────────────────────────────────────────────────

/** What a service box is for, by what glove declared it as. */
function serviceExplanation(s: NetService | undefined, services: readonly NetService[]): BoxExplanation {
  if (!s) return { heading: 'A gate service', body: 'A service seen in the traffic that glove’s session.json does not declare. Every connection out of the sandbox goes through one of glove’s gate services, which records it and applies your rules.' };
  if (s.observed === false) {
    return {
      heading: 'A declared service glove does not watch',
      body: 'glove declared this route out of the sandbox but does not record its traffic, so nothing that goes through it appears here. It is drawn dashed so the blind spot is visible rather than missing.',
    };
  }
  if (isLlmUpstream(s)) {
    return {
      heading: 'The model call’s second leg',
      body: 'glove’s llm-auth sidecar adds your API key to the harness’s model request and sends it on through this gate. The harness never holds the key; this is the leg that actually reaches the provider.',
    };
  }
  if (isFanoutService(s)) {
    const info = EGRESS_CLIENTS[s.client ?? (s.tool === 'search-engine-fanout' ? 'searxng' : '')];
    return {
      heading: `Egress on the harness’s behalf${info ? `: ${info.name}` : ''}`,
      body: `Not the harness: a sidecar going out for it (${info?.what ?? 'egress for a tool'}, ${info?.why ?? 'driven by a tool call'}). The sandbox cannot reach this gate itself; its traffic is drawn in its own colour so it is never mistaken for the agent’s own requests.`,
    };
  }
  const via = nextServices(s, services);
  const how = s.mode === 'tcp' ? 'a TCP relay to one fixed upstream' : s.mode === 'http-proxy' ? 'an HTTP proxy the harness’s tools use for any host' : s.mode ? `a ${s.mode} gate` : 'a gate';
  return {
    heading: `A gate the sandbox connects to${s.tool ? `: ${toolLabel(s.tool)}` : ''}`,
    body: `One of the few ways out of the sandbox: ${how}. glove records every connection through it and applies your rules before anything leaves.${via.length ? ` Its traffic goes on through ${via.map((n) => n.service).join(', ')} by way of a sidecar.` : ''}`,
  };
}

const ROUTE_EXPLANATION: Readonly<Record<string, BoxExplanation>> = {
  local: { heading: 'A local link', body: 'Traffic to a service on this machine (a local model, SearXNG, a docker host). It never leaves the machine, so it is never tunnelled and has no place on the map.' },
  llm: { heading: 'glove’s LLM link', body: 'The harness’s model calls. glove sends them to the provider (or a model on your network) on purpose without the tunnel: that is expected, not a leak.' },
  tunnel: { heading: 'The declared tunnel', body: 'The route glove declared for the sandbox’s internet traffic (a VPN or Tor). Everything here leaves through the tunnel’s exit, so destinations see the exit’s address, not yours. Health is what the gate last reported.' },
  direct: { heading: 'Direct: no tunnel', body: 'Traffic that left without the tunnel, from your real IP address. It should be empty unless a host is a known VPN route (your corporate network), which is shown apart and not as a leak.' },
};

/** What a destination's path is, by how it ended (`outcomeOf`): the note above its hops. */
export const DESTINATION_EXPLANATION: Readonly<Record<Outcome, BoxExplanation>> = {
  broken: { heading: 'A broken path', body: 'The gate allowed this connection, but the route’s upstream could not reach the destination (unreachable or timed out). It never got there; when many paths break at once, suspect the tunnel rather than the hosts.' },
  refused: { heading: 'A refused destination', body: 'The sandbox asked for this host and the gate refused it at the policy wall, by glove’s guard, one of your rules or the default. Nothing left the sandbox, so the path below stops at the policy and the host has no row among the destinations.' },
  reached: { heading: 'A destination', body: 'A host the sandbox reached. Its band’s colour says how it got there and its width how much moved. The hops below say which glove observed or verified, and which are only declared.' },
};

/** The hosts a box (a node, or a label on the policy wall) stands for; null for an id that is neither. */
export function boxHosts(t: Pick<Topology, 'nodes' | 'wall'>, id: string): string[] | null {
  return t.nodes.find((n) => n.id === id)?.hosts ?? t.wall.labels.find((l) => l.id === id)?.hosts ?? null;
}

/** What a box is for: the panel's dismissable note. Null for an id that is no box. */
export function explainBox(data: TopoInput, t: Pick<Topology, 'wall'> | null, id: string): BoxExplanation | null {
  if (id === 'sandbox') {
    return { heading: 'The sandbox', body: `Where the agent${data.session?.harness ? ` (${data.session.harness})` : ''} runs. It has no route out except through glove’s gate services, so every byte it sends or receives passes one of the boxes to its right. The bytes on its bands are what each service carried.` };
  }
  if (id.startsWith('svc:')) {
    const name = id.slice(4);
    const services = topologyServices(data);
    return serviceExplanation(services.find((s) => s.service === name), services);
  }
  if (id.startsWith('route:')) return ROUTE_EXPLANATION[id.slice(6)] ?? null;
  if (id === 'origin:exit') {
    return { heading: 'The apparent origin', body: 'The address destinations see the sandbox’s tunnelled traffic come from: the tunnel’s exit. glove checks it itself (exit identity) and Layman only shows what glove recorded. “Not verified” means the tunnel is declared but its exit has not been confirmed.' };
  }
  if (id.startsWith('origin:broken:')) return DESTINATION_EXPLANATION.broken;
  if (id.startsWith('refused:')) return DESTINATION_EXPLANATION.refused;
  if (id.startsWith('dest:')) return DESTINATION_EXPLANATION.reached;
  const label = t?.wall.labels.find((l) => l.id === id);
  if (label) {
    return label.kind === 'guard'
      ? { heading: 'glove’s guard', body: 'Built-in protection that runs before any rule: it refuses cloud metadata, internal and private addresses, and malformed requests, so the sandbox cannot reach your network or the host through a proxy. Refused connections never leave.' }
      : id === 'wall:default'
        ? { heading: 'The default block', body: 'No rule allowed these connections and the session’s default is to block, so the gate refused them. Nothing left the sandbox.' }
        : { heading: 'Your rule', body: 'A rule in this session’s rules.json that blocked these connections at the gate. Nothing left the sandbox. Remove or change the rule from the Rules panel.' };
  }
  return null;
}

// ─── Details ──────────────────────────────────────────────────────────────────

/**
 * The Details panel's model for a box: any node of the diagram that is not a destination or a
 * broken path (those follow their path with `pathHops`), or a label on the policy wall. Null for
 * an id the topology does not have.
 */
export function boxDetails(data: TopoInput & Pick<NetSessionData, 'exits'>, t: Topology, id: string): BoxDetails | null {
  const explain = explainBox(data, t, id);
  if (!explain) return null;
  const node = t.nodes.find((n) => n.id === id);
  const label = t.wall.labels.find((l) => l.id === id);
  if (!node && !label) return null;
  const services = topologyServices(data);
  const hosts = new Set(node?.hosts ?? label!.hosts);
  const all = [...data.destinations.values()].filter((d) => d.state !== 'empty' && hosts.has(destHost(d)));
  const facts: BoxFact[] = [];
  let kind: BoxKind;
  let dests = all;
  let share: ((d: DestinationAggregate) => number) | undefined;
  const g = data.gate;

  if (label) {
    kind = 'policy';
    const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
    dests = all.filter((d) => outcomeOf(d) === 'refused');
    if (label.kind === 'guard') {
      facts.push({ label: 'Refused by', value: 'glove’s guard, before any rule' });
      facts.push({ label: 'Reasons', value: [...new Set(dests.map((d) => guardReason(d)))].join(', ') || '—' });
    } else if (id === 'wall:default') {
      facts.push({ label: 'Refused by', value: 'the default: no rule allowed it' });
    } else {
      const ruleId = id.slice('wall:rule:'.length);
      const r = rules.find((x) => x.id === ruleId);
      facts.push({ label: 'Refused by', value: ruleLabel(ruleId, rules) });
      facts.push({ label: 'Rule', value: ruleId, mono: true });
      if (r) {
        facts.push({ label: 'Matches', value: matchText(r.match), mono: true });
        facts.push({ label: 'Action', value: `${r.action}${r.terminate ? ' · cuts open connections' : ''}` });
      } else {
        facts.push({ label: 'Matches', value: 'no longer in the rules', tone: 'faint' });
      }
    }
    const def = data.rules.enforced?.default ?? data.rules.file?.default ?? null;
    facts.push({ label: 'Default', value: def ?? 'rules not read', tone: def ? undefined : 'faint' });
    facts.push({ label: 'Rules', value: `${plural(rules.length, 'rule')} · ${data.rules.enforcement}` });
  } else if (node!.kind === 'sandbox') {
    kind = 'sandbox';
    const declared = data.session?.services ?? [];
    facts.push({ label: 'Session', value: data.token, mono: true });
    if (data.session?.harness) facts.push({ label: 'Harness', value: data.session.harness });
    facts.push({ label: 'Gate', value: gateText(data), tone: g.freshness === 'running' ? 'ok' : g.freshness === 'stale' ? 'warn' : 'faint' });
    if (g.gateVersion) facts.push({ label: 'Gate version', value: g.gateVersion, mono: true });
    facts.push({ label: 'Recording', value: g.record });
    facts.push({ label: 'Services', value: `${declared.length} declared · ${declared.filter((s) => s.observed !== false).length} watched` });
    if (g.unwatchedServices.length) facts.push({ label: 'Not watched', value: g.unwatchedServices.join(', '), mono: true, tone: 'warn' });
    if (g.telemetry) facts.push({ label: 'Telemetry', value: `${g.telemetry.written} written · ${g.telemetry.dropped} dropped`, tone: g.telemetry.dropped ? 'warn' : undefined });
  } else if (node!.kind === 'service') {
    kind = 'service';
    const s = services.find((x) => x.service === node!.title);
    dests = all.filter((d) => d.services.includes(node!.title));
    // Its share of a destination it shares with another service, as the bands split it.
    const shareOf = serviceShares(data.flows.values());
    share = (d) => shareOf(d, node!.title);
    if (s?.listen) facts.push({ label: 'Listens on', value: s.listen, mono: true });
    if (s?.mode) facts.push({ label: 'Mode', value: s.mode });
    if (s?.tool) facts.push({ label: 'Tool', value: toolLabel(s.tool) });
    if (s?.client) facts.push({ label: 'Client', value: clientName(s.client) });
    facts.push({ label: 'Reached by', value: s && fromSandbox(s) ? 'the harness' : 'a sidecar, not the harness' });
    const up = upstreamHost(s?.upstream ?? s?.route?.upstream, true);
    if (up) facts.push({ label: 'Upstream', value: up, mono: true });
    if (s) facts.push({ label: 'Route', value: s.route?.kind ?? serviceRoute(s) });
    facts.push({ label: 'Watched', value: s?.observed === false ? 'no: declared only' : 'yes', tone: s?.observed === false ? 'warn' : undefined });
    if (s) {
      const next = nextServices(s, services).map((n) => n.service);
      if (next.length) facts.push({ label: 'Goes on through', value: next.join(', '), mono: true });
      const into = hopsInto(s.service, services).map((n) => n.service);
      if (into.length) facts.push({ label: 'Reached from', value: into.join(', '), mono: true });
      const trigger = isFanoutService(s) ? triggerOf(s, services) : null;
      if (trigger) facts.push({ label: 'Triggered by', value: trigger.service, mono: true });
    }
  } else if (node!.kind === 'route') {
    kind = 'route';
    const route = id.slice('route:'.length);
    if (route === 'tunnel') {
      const tunnelSvc = services.find((s) => s.observed && serviceRoute(s) === 'tunnel');
      facts.push({ label: 'Declared', value: g.route.kind ?? 'unknown' });
      const up = upstreamHost(tunnelSvc?.route?.upstream ?? tunnelSvc?.upstream, true);
      if (up) facts.push({ label: 'Upstream', value: up, mono: true });
      facts.push({
        label: 'Upstream health',
        value: g.route.upstreamHealthy === true ? 'healthy' : g.route.upstreamHealthy === false ? 'unhealthy' : 'unknown',
        tone: g.route.upstreamHealthy === true ? 'ok' : g.route.upstreamHealthy === false ? 'error' : 'faint',
      });
      if (g.resolver.mode) {
        facts.push({ label: 'Resolver', value: [g.resolver.mode, g.resolver.name, g.resolver.healthy === false ? 'unhealthy' : null].filter(Boolean).join(' · '), tone: g.resolver.healthy === false ? 'error' : undefined });
      }
      facts.push({ label: 'Exit', value: g.route.verified ? 'verified' : g.route.exitIdentityOff ? 'not verified · exit identity is off' : 'not verified', tone: g.route.verified ? 'ok' : 'warn' });
    } else if (route === 'local' || route === 'llm') {
      // The upstreams of the services whose traffic took this route, not every local service's.
      const used = new Set(all.flatMap((d) => d.services));
      const ups = [...new Set(services.filter((s) => used.has(s.service)).map((s) => upstreamHost(s.upstream ?? s.route?.upstream, true)).filter((x): x is string => !!x))];
      if (ups.length) facts.push({ label: 'Upstreams', value: ups.join(', '), mono: true });
      if (route === 'local') {
        facts.push({ label: 'Mapped', value: 'never: it does not leave the machine or your network' });
      } else {
        const lan = all.some((d) => d.scope === 'lan');
        const cloud = all.some((d) => d.scope === 'cloud');
        facts.push({ label: 'Reaches', value: [cloud ? 'the provider, over the internet' : null, lan ? 'a model on your network' : null].filter(Boolean).join(' · ') || 'nothing yet' });
        facts.push({ label: 'Tunnel', value: 'no: glove’s llm link goes without it, by design' });
        facts.push({ label: 'Mapped', value: cloud ? 'no: the provider is expected, not a leak' : 'never: it stays on your network' });
      }
    } else {
      const leak = all.filter((d) => !d.flags.vpn);
      facts.push({ label: 'Real IP', value: leak.length ? plural(leak.reduce((a, d) => a + d.flows, 0), 'flow') : 'none', tone: leak.length ? 'error' : 'ok' });
      facts.push({ label: 'Your VPN', value: plural(all.filter((d) => d.flags.vpn).reduce((a, d) => a + d.flows, 0), 'flow') });
    }
  } else if (node!.kind === 'exit') {
    kind = 'exit';
    const e = data.exit;
    facts.push({ label: 'Address', value: e?.ip ?? 'unknown', mono: !!e?.ip, tone: e?.ip ? undefined : 'faint' });
    const where = e ? [e.city, e.country].filter(Boolean).join(', ') : '';
    if (where) facts.push({ label: 'Location', value: where });
    facts.push({ label: 'Verified', value: g.route.verified && e?.healthy ? 'yes, by glove’s exit identity' : g.route.exitIdentityOff ? 'no: exit identity is off' : 'no', tone: g.route.verified && e?.healthy ? 'ok' : 'warn' });
    const src = exitSourceHost(e?.source ?? null);
    if (src) facts.push({ label: 'Checked via', value: src, mono: true });
    const at = e?.t ? Date.parse(e.t) : NaN;
    if (!Number.isNaN(at)) facts.push({ label: 'Last check', value: formatStamp(at) });
  } else {
    kind = node!.kind === 'dest' ? 'dest' : 'broken';
  }

  const { totals, mix, top, more } = traffic(dests, services, kind === 'policy', share);
  const exits: ExitSeen[] = kind === 'exit'
    ? [...data.exits].sort((a, b) => b.t.localeCompare(a.t)).map((e) => ({ ip: e.ip, where: [e.city, e.country].filter(Boolean).join(', ') || null, t: e.t, healthy: e.healthy }))
    : [];
  return {
    id, kind, title: label ? label.text : node!.title, mono: !!node?.mono, explain, facts, totals, mix, top, more, exits,
  };
}


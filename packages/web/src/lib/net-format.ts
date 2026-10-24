/**
 * Formatting for the network views: bytes, ages, the gate strip's chips, and
 * the state legend every view draws from. Pure, so it is tested in node.
 */
import type { NetSessionData } from './net-state.js';
import type { NetState, SinceAt } from './netobs-types.js';
import { formatStamp } from './net-range.js';
import type { BandKind } from './net-topology.js';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '')} ${units[i]}`;
}

export function formatAge(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type ChipTone = 'ok' | 'tunnel' | 'warn' | 'error' | 'violet' | 'neutral' | 'muted';
export type ChipIcon = 'pulse' | 'tunnel' | 'check' | 'shield' | 'file' | 'alert' | 'clock' | 'direct';

/** A tooltip (`NetTipHost`): a sentence, or a heading, a sentence and a few facts. */
export interface NetTip {
  heading?: string;
  body: string;
  facts?: string[];
}

export interface GateChip {
  key: string;
  label: string;
  tone: ChipTone;
  icon: ChipIcon;
  /** What the chip means in plain words, and its particulars: heartbeat, versions, exit and its source. */
  tip: NetTip;
}

/**
 * Whether a chip may shrink to its icon when the strip makes room for a range. Only the routine
 * ones do: a chip in a warning or error tone is an alarm (traffic cut, untunnelled flows, rules
 * rejected, a stale gate, a direct route) and is never collapsed, nor is History only, which
 * says what every figure is.
 */
export function chipCollapses(c: GateChip): boolean {
  return c.tone !== 'error' && c.tone !== 'warn' && c.key !== 'history';
}

const ROUTE_LABEL: Record<string, string> = { vpn: 'VPN', tor: 'Tor' };

/** "Since Oct 21 00:27:03 (5 h ago)", or "at least since" when Layman did not see it change; nothing when nothing says. */
function sinceFact(what: string, since: SinceAt | null, now: number): string[] {
  if (!since) return [];
  return [`${what} ${since.exact ? 'since' : 'at least since'} ${formatStamp(since.t)} (${formatAge(Math.max(0, now - since.t))} ago)`];
}

/**
 * The gate strip, left to right :
 * gate state; the untunnelled alarm when there is one, straight after it so it
 * cannot be missed; route and exit; resolver; rules; record mode; and "view
 * incomplete" when the data itself has holes. Each chip's tip says what it means
 * to someone who has never read glove's docs, then the facts behind it.
 */
export function gateChips(data: NetSessionData, now = Date.now()): GateChip[] {
  const { gate, exit, totals, counters } = data;
  const chips: GateChip[] = [];
  const version = gate.gateVersion ? [`gate ${gate.gateVersion}`] : [];
  // Nothing is being read: its gate, route and rules are as they were, not as they are.
  if (data.historyOnly) {
    return [{ key: 'history', label: 'History only', tone: 'muted', icon: 'file', tip: {
      heading: 'History only',
      body: 'glove’s files for this session are gone. Layman kept its totals and destinations while session recording was on; flows, the map and the trace are not kept.',
    } }];
  }

  const heartbeat = `Heartbeat ${formatAge(gate.heartbeatAgeMs)} ago`;
  const gateSince = sinceFact(gate.freshness === 'running' ? 'Running' : gate.freshness === 'stale' ? 'Quiet' : 'Stopped', gate.since.gate, now);
  switch (gate.freshness) {
    case 'running':
      chips.push({ key: 'gate', label: 'Gate running', tone: 'ok', icon: 'pulse', tip: {
        heading: 'The gate is running',
        body: 'glove’s gate is the sandbox’s only way out to the network: it records every connection and enforces your rules. It reports a heartbeat every few seconds, and this one is current.',
        facts: [...gateSince, heartbeat, ...version],
      } });
      break;
    case 'stale':
      chips.push({ key: 'gate', label: 'Gate stale · data stopped updating', tone: 'warn', icon: 'clock', tip: {
        heading: 'The gate has gone quiet',
        body: 'Its heartbeat stopped, so the data has stopped updating. That is not the same as the traffic stopping.',
        facts: [...gateSince, heartbeat, ...version],
      } });
      break;
    case 'stopped':
      chips.push({ key: 'gate', label: 'Gate stopped', tone: 'muted', icon: 'clock', tip: {
        heading: 'The gate is not running',
        body: 'Its last status says it is not running: shut down, starting, or failed (glove’s own word is below). What is shown is the record up to then.',
        facts: [...gateSince, `glove reported “${gate.state}”`, ...version],
      } });
      break;
    default:
      chips.push({ key: 'gate', label: 'Gate status unknown', tone: 'muted', icon: 'clock', tip: {
        heading: 'Gate status unknown',
        body: 'No status.json has been read for this session, so Layman cannot tell whether its gate is running.',
      } });
  }

  // The kill switch is on: said straight after the gate state, like the alarms, until restored.
  if (data.rules.file?.rules.some((r) => r.id.startsWith('r_layman_cut_'))) {
    const keep = data.rules.file.rules.some((r) => r.id.startsWith('r_layman_cut_') && r.action === 'allow');
    chips.push({ key: 'cut', label: 'ALL TRAFFIC CUT', tone: 'error', icon: 'alert', tip: {
      heading: 'All traffic is cut',
      body: `Every connection is blocked by “Cut all traffic”${keep ? ', except the agent’s model (LLM) link' : ''}. Restore puts back the rules from before.`,
    } });
  }

  if (totals.directFlows > 0) {
    chips.push({ key: 'direct', label: `${plural(totals.directFlows, 'untunnelled flow').toUpperCase()}`, tone: 'error', icon: 'alert', tip: {
      heading: 'Traffic went out untunnelled',
      body: 'Some connections left the sandbox on a direct route, without the tunnel, so they carried your real IP address.',
      facts: [plural(totals.directFlows, 'connection')],
    } });
  }

  const kind = gate.route.kind;
  if (kind === 'direct') {
    chips.push({ key: 'route', label: 'Direct route · no tunnel', tone: 'error', icon: 'direct', tip: {
      heading: 'No tunnel',
      body: 'This session’s web traffic is set to go out directly, not through a VPN or Tor, so sites see your real IP address.',
    } });
  } else if (kind === 'vpn' || kind === 'tor') {
    const name = ROUTE_LABEL[kind];
    const unhealthy = gate.route.upstreamHealthy === false ? ' · upstream failing' : '';
    const exitFacts = exit
      ? [`Exit ${exit.ip ?? 'unknown IP'}${exit.city ? `, ${exit.city}` : ''}${exit.country ? `, ${exit.country}` : ''}`,
        `Reported by ${exit.source ?? 'an unnamed source'}, not looked up by Layman`]
      : ['No exit has been observed'];
    const exitSince = exit ? sinceFact('This exit', gate.since.exit, now) : [];
    const failing = unhealthy ? ` The ${name} reports it is failing, so connections may not get through.` : '';
    if (gate.route.verified && exit) {
      chips.push({ key: 'route', label: `${name} · exit verified${exit.country ? ` · ${exit.country}` : ''}${unhealthy}`,
        tone: unhealthy ? 'warn' : 'tunnel', icon: 'tunnel', tip: {
          heading: `${name}: exit verified`,
          body: `Web traffic leaves through the ${name}. glove checked where it comes out (the exit), so this is observed, not just declared.${failing}`,
          facts: [...sinceFact('Verified', gate.since.route, now), ...exitFacts, ...exitSince],
        } });
    } else if (gate.route.exitIdentityOff) {
      chips.push({ key: 'route', label: `${name} · declared${unhealthy}`, tone: unhealthy ? 'warn' : 'neutral', icon: 'tunnel', tip: {
        heading: `${name}: declared`,
        body: `Web traffic is set to leave through the ${name}. Exit identity is off for this session, so nothing has checked where it comes out.${failing}`,
      } });
    } else {
      chips.push({ key: 'route', label: `${name} · declared, not verified${unhealthy}`, tone: 'warn', icon: 'tunnel', tip: {
        heading: `${name}: not verified`,
        body: `Web traffic is set to leave through the ${name}, but glove has not confirmed where it comes out. Trust the label less than an observed exit.${failing}`,
        facts: [...sinceFact('As now', gate.since.route, now), ...exitFacts, ...exitSince],
      } });
    }
  } else if (kind === 'corporate') {
    const unhealthy = gate.route.upstreamHealthy === false ? ' · upstream failing' : '';
    chips.push({ key: 'route', label: `Corporate route · allowlist only${unhealthy}`, tone: unhealthy ? 'warn' : 'neutral', icon: 'shield', tip: {
      heading: 'Corporate route',
      body: `${LEGEND_BY_KEY.route_corporate.explanation} Its exit is your corporate network, so there is no exit to verify.`,
    } });
  } else if (kind === 'tcp') {
    chips.push({ key: 'route', label: 'Local services only', tone: 'neutral', icon: 'tunnel', tip: {
      heading: 'Local services only',
      body: 'This session has no web proxy: only direct links to the services it was configured with.',
    } });
  }

  const r = gate.resolver;
  if (r.mode === 'in-tunnel') {
    const name = r.name ? [`Resolver ${r.name}`] : [];
    if (r.healthy === false) {
      chips.push({ key: 'resolver', label: 'Resolver down', tone: 'warn', icon: 'alert', tip: {
        heading: 'The resolver is failing',
        body: 'The service that looks up hostnames inside the tunnel is failing, so new destinations go to “Unknown location” on the Map. Traffic itself is not affected.',
        facts: [...sinceFact('Failing', gate.since.resolver, now), ...name],
      } });
    } else {
      chips.push({ key: 'resolver', label: 'Resolver in-tunnel', tone: r.healthy ? 'ok' : 'neutral', icon: 'check', tip: {
        heading: 'Hostnames looked up in the tunnel',
        body: 'Names like example.com are turned into addresses inside the tunnel, so your own DNS provider never sees what the sandbox visits.',
        facts: [...sinceFact('As now', gate.since.resolver, now), ...name, ...(r.healthy === null ? ['Not used yet this session'] : [])],
      } });
    }
  }

  const rules = gate.rules;
  if (rules) {
    if (!rules.ok) {
      chips.push({ key: 'rules', label: 'Rules rejected', tone: 'error', icon: 'alert', tip: {
        heading: 'glove rejected your rules',
        body: `The gate could not use rules.json, so it is still enforcing the previous ${plural(rules.active_count, 'rule')}.`,
        facts: [rules.error ?? 'No reason given'],
      } });
    } else {
      // What the gate enforces, never what Layman wrote or a guess: without it, the default goes unsaid.
      const def = data.rules.enforced?.default;
      const otherwise = def === 'block' ? '; everything else is blocked (the session’s default)'
        : def === 'allow' ? '; everything else is allowed (the session’s default)' : '';
      chips.push({ key: 'rules', label: rules.active_count ? `${plural(rules.active_count, 'rule')} enforced` : 'No rules',
        tone: 'neutral', icon: 'shield', tip: rules.active_count
          ? {
            heading: `${plural(rules.active_count, 'rule')} in force`,
            body: `Your rules decide which destinations the sandbox may reach. glove’s built-in guard still refuses private addresses and cloud metadata first${otherwise}.`,
            facts: [rules.loaded_at ? `Loaded ${rules.loaded_at}` : 'Never loaded'],
          }
          : {
            heading: 'No rules',
            body: `You haven’t added any rules. glove’s built-in guard still refuses private addresses and cloud metadata${otherwise}.`,
          } });
    }
  }

  chips.push(gate.record === 'full'
    ? { key: 'record', label: 'Record: full', tone: 'violet', icon: 'file', tip: {
      heading: 'Recording: full',
      body: 'glove records request URLs (and headers, if enabled) as well as who connected where. More visible, less private.',
    } }
    : { key: 'record', label: `Record: ${gate.record}`, tone: 'neutral', icon: 'file', tip: gate.record === 'metadata'
      ? {
        heading: 'Recording: metadata only',
        body: 'glove records who connected to what, when, and how many bytes: not URLs or what was sent. A session set to “full” would also record request URLs.',
      }
      // A mode this Layman does not know: say what glove reports, not what metadata mode records.
      : { heading: `Recording: ${gate.record}`, body: `glove reports its record mode as “${gate.record}”, which this version of Layman does not describe.` } });

  const reasons: string[] = [];
  if (gate.telemetry && gate.telemetry.dropped > 0) reasons.push(`The gate dropped ${plural(gate.telemetry.dropped, 'record')}`);
  if (counters.gaps > 0) reasons.push(`${plural(counters.gaps, 'rotated file')} disappeared before Layman read ${counters.gaps === 1 ? 'it' : 'them'}`);
  if (data.historyTruncated) reasons.push('Older history was beyond the read budget');
  if (reasons.length) {
    chips.push({ key: 'incomplete', label: 'View incomplete', tone: 'warn', icon: 'alert', tip: {
      heading: 'Some records are missing',
      body: 'What is shown leaves some connections out. Traffic itself was not affected.',
      facts: reasons,
    } });
  }
  return chips;
}

// ─── The state legend ─────────────────────

/**
 * How a row's allow/block toggle is drawn: `allow` filled teal; `block` filled
 * red (the operator's own rule); `default` outlined red (blocked because nothing
 * allowed it); `locked` dashed amber (glove's guard: no rule can change it);
 * `pending` striped amber (a write the gate has not confirmed); `none` no toggle.
 */
export type ToggleKind = 'allow' | 'block' | 'default' | 'locked' | 'pending' | 'none';

export type StateIcon =
  | 'pulse' | 'check' | 'lock' | 'blocked' | 'alert' | 'broken' | 'cut' | 'home' | 'tunnel' | 'eye-off'
  | 'pin' | 'fold' | 'direct' | 'clock' | 'file' | 'globe' | 'shield';

export interface StateInfo {
  key: string;
  /** Handoff §6.1's name for the state. */
  label: string;
  /** How it appears in glove's data. */
  dataRule: string;
  icon: StateIcon;
  colourVar: string;
  /** Short badge text beside a host, or null. */
  badge: string | null;
  toggleKind: ToggleKind;
  /** How the Map tab draws it. */
  mapTreatment: string;
  /** What the operator needs to understand. */
  explanation: string;
  /** Per flow (a `NetState`), an attribute of a flow (`FlowFlags`), or of the whole session. */
  level: 'flow' | 'flag' | 'session';
  /** Must be unmissable: tinted row, red. */
  loud?: boolean;
}

/**
 * Every state the network views tell apart: glove's state table in its order, plus
 * cleartext HTTP. Every view reads its label, colour, icon, badge and toggle
 * from here, so the legend and the views cannot disagree.
 */
export const NET_LEGEND: readonly StateInfo[] = [
  { key: 'active', level: 'flow', label: 'Active flow', dataRule: 'open / update, no close yet', icon: 'pulse', colourVar: 'var(--net-tunnel)',
    badge: 'LIVE', toggleKind: 'allow', mapTreatment: 'bright arc, moving dash', explanation: 'Talking right now; bytes are live.' },
  { key: 'finished', level: 'flow', label: 'Finished normally', dataRule: 'close_reason: eof', icon: 'check', colourVar: 'var(--text-muted)',
    badge: null, toggleKind: 'allow', mapTreatment: 'dim arc', explanation: 'Done.' },
  { key: 'guard', level: 'flow', label: 'Refused by glove guard', dataRule: 'verdict block, rule builtin:*', icon: 'lock', colourVar: 'var(--warn)',
    badge: 'GUARD', toggleKind: 'locked', mapTreatment: 'not on the map',
    explanation: 'Tried to reach something internal or unsafe. Not unblockable.' },
  { key: 'user_rule', level: 'flow', label: 'Blocked by your rule', dataRule: 'verdict block, rule r_*', icon: 'blocked', colourVar: 'var(--error)',
    badge: 'YOUR RULE', toggleKind: 'block', mapTreatment: 'not on the map', explanation: 'Your own rule did this. Unblock from the same row.' },
  { key: 'default_block', level: 'flow', label: 'Blocked by the default', dataRule: 'verdict block, rule null', icon: 'blocked', colourVar: 'var(--error)',
    badge: 'DEFAULT', toggleKind: 'default', mapTreatment: 'not on the map', explanation: 'Nothing allowed it. An allow rule would.' },
  { key: 'rules_rejected', level: 'session', loud: true, label: 'Rules rejected', dataRule: 'status.json rules.ok false + error', icon: 'alert',
    colourVar: 'var(--error)', badge: 'BANNER', toggleKind: 'none', mapTreatment: 'red banner, every layout',
    explanation: 'Your last change did not take effect.' },
  { key: 'broken', level: 'flow', label: 'Tunnel / upstream failure', dataRule: 'allow + upstream_unreachable / timeout', icon: 'broken',
    colourVar: 'var(--warn)', badge: 'UNREACHABLE', toggleKind: 'allow', mapTreatment: 'arc stops short, broken end',
    explanation: 'Not a policy decision: the path is broken.' },
  { key: 'gate_shutdown', level: 'flow', label: 'Cut by gate shutdown', dataRule: 'close_reason: gate_shutdown', icon: 'cut', colourVar: 'var(--text-muted)',
    badge: 'CUT', toggleKind: 'allow', mapTreatment: 'arc ends in a slash', explanation: 'The session ended mid-transfer.' },
  { key: 'local', level: 'flag', label: 'Local link', dataRule: 'scope: local', icon: 'home', colourVar: 'var(--text-body)',
    badge: null, toggleKind: 'allow', mapTreatment: 'in the sandbox card only', explanation: 'Your machine or an internal service. Never on the map.' },
  { key: 'tunnelled', level: 'flag', label: 'Tunnelled', dataRule: 'scope: tunnelled', icon: 'tunnel', colourVar: 'var(--net-tunnel)',
    badge: null, toggleKind: 'allow', mapTreatment: 'teal, via the exit', explanation: 'Left through the declared VPN or Tor route.' },
  { key: 'direct', level: 'flag', loud: true, label: 'Untunnelled', dataRule: 'scope: direct', icon: 'alert', colourVar: 'var(--error)',
    badge: 'DIRECT', toggleKind: 'allow', mapTreatment: 'red dashed, skips the exit',
    explanation: 'The anonymity failure. Red banner, red strip chip, red tab dot.' },
  { key: 'lan', level: 'flag', label: 'LAN link', dataRule: 'scope: lan', icon: 'home', colourVar: 'var(--text-body)',
    badge: null, toggleKind: 'allow', mapTreatment: 'in the sandbox card only',
    explanation: 'A host on your local network, never tunnelled: the inference server (glove’s llm extension, “LAN · LLM”) or an ssh relay host (“LAN · SSH”). Expected, not an alert. Never on the map.' },
  { key: 'hop', level: 'flag', label: 'Hop to a sidecar', dataRule: 'glove’s next names an observed gate (llm → llm-upstream, webfetch-mcp → webfetch-egress)', icon: 'home',
    colourVar: 'var(--text-body)', badge: null, toggleKind: 'allow', mapTreatment: 'in the sandbox card only',
    explanation: 'The harness’s hop to a glove sidecar that goes out for it through another gate: llm-auth (adds the key, calls the provider through llm-upstream), the web fetcher, SearXNG, the browser. Shown as a local link; its bytes count once, at the egress leg.' },
  { key: 'cloud', level: 'flag', label: 'Cloud LLM', dataRule: 'scope: cloud', icon: 'globe', colourVar: 'var(--text-body)',
    badge: null, toggleKind: 'allow', mapTreatment: 'placed when glove has its IP',
    explanation: 'The LLM provider on the internet, reached by glove’s llm link rather than the tunnel. Expected, not an alert.' },
  { key: 'route_corporate', level: 'session', label: 'Corporate route', dataRule: 'route.kind: corporate', icon: 'shield',
    colourVar: 'var(--text-body)', badge: null, toggleKind: 'none', mapTreatment: 'no exit pin',
    explanation: 'Web traffic goes only to what the session’s corporate allowlist names (glove-session.yml). Your rules can block more; they cannot allow more.' },
  { key: 'route_declared', level: 'session', label: 'Route declared, not verified', dataRule: 'route.kind, no healthy exit record', icon: 'tunnel',
    colourVar: 'var(--warn)', badge: 'UNVERIFIED', toggleKind: 'none', mapTreatment: 'dashed trunk, no exit pin',
    explanation: 'Trust the label less than an observed exit.' },
  { key: 'exit_observed', level: 'session', label: 'Exit observed', dataRule: 'latest exit.ndjson healthy: true', icon: 'pin',
    colourVar: 'var(--net-tunnel)', badge: 'VERIFIED', toggleKind: 'none', mapTreatment: 'solid trunk to the exit pin',
    explanation: 'The apparent origin. The map starts here, not at you.' },
  { key: 'resolver_down', level: 'session', label: 'Resolver down', dataRule: 'resolver.healthy false', icon: 'alert', colourVar: 'var(--warn)',
    badge: 'STRIP', toggleKind: 'none', mapTreatment: 'new flows go to Unknown', explanation: 'The map loses precision; traffic is fine.' },
  { key: 'unresolved', level: 'flag', label: 'Unresolved destination', dataRule: 'dest.ip null', icon: 'pin', colourVar: 'var(--text-muted)',
    badge: 'UNKNOWN LOC.', toggleKind: 'allow', mapTreatment: '“Unknown location” bucket', explanation: 'Never looked up by Layman.' },
  { key: 'no_host', level: 'flag', label: 'Unknown destination', dataRule: 'dest.host null', icon: 'lock', colourVar: 'var(--text-muted)',
    badge: 'NO HOST', toggleKind: 'locked', mapTreatment: 'not on the map', explanation: 'Shown as the service endpoint.' },
  { key: 'not_watched', level: 'session', label: 'Service not watched', dataRule: 'session.json observed: false', icon: 'eye-off',
    colourVar: 'var(--text-faint)', badge: 'NOT WATCHED', toggleKind: 'none', mapTreatment: 'grey chip in the sandbox card',
    explanation: 'A way out of the sandbox that nobody can see.' },
  { key: 'telemetry', level: 'session', label: 'Telemetry degraded', dataRule: 'telemetry.dropped > 0', icon: 'alert', colourVar: 'var(--warn)',
    badge: 'STRIP', toggleKind: 'none', mapTreatment: 'strip chip appears', explanation: 'The view is incomplete; traffic was not affected.' },
  { key: 'gate_stale', level: 'session', label: 'Gate stale or stopped', dataRule: 'state ≠ running, or t older than 20 s', icon: 'clock',
    colourVar: 'var(--warn)', badge: 'STRIP', toggleKind: 'none', mapTreatment: 'arcs stop animating',
    explanation: 'The data has stopped updating, not the traffic.' },
  { key: 'record_full', level: 'session', label: 'Full record mode', dataRule: 'record: full', icon: 'file', colourVar: 'var(--net-up)',
    badge: 'STRIP', toggleKind: 'none', mapTreatment: 'strip chip, always',
    explanation: 'You traded privacy for visibility: request URLs are recorded.' },
  { key: 'pooled', level: 'flow', label: 'Pooled (idle)', dataRule: 'open, no record for over 3 s', icon: 'pulse', colourVar: 'var(--net-tunnel)',
    badge: 'POOLED', toggleKind: 'allow', mapTreatment: 'steady arc, no dash', explanation: 'A kept-alive connection, not a live transfer.' },
  { key: 'gate_lost', level: 'flow', label: 'Cut by a gate that went away (inferred)', dataRule: 'no close, and the flow’s run has ended',
    icon: 'cut', colourVar: 'var(--warn)', badge: 'CUT · INFERRED', toggleKind: 'allow', mapTreatment: 'arc ends in a slash',
    explanation: 'The forwarder died mid-flow; its close was never written.' },
  { key: 'empty', level: 'flow', label: 'Empty connection', dataRule: 'allow, dest.host null, eof / timeout', icon: 'fold',
    colourVar: 'var(--text-faint)', badge: null, toggleKind: 'none', mapTreatment: 'not on the map', explanation: 'Proxy noise: folded away.' },
  { key: 'cleartext', level: 'flag', label: 'Cleartext HTTP', dataRule: 'proto: http, or port 80', icon: 'alert', colourVar: 'var(--warn)',
    badge: 'CLEARTEXT', toggleKind: 'allow', mapTreatment: 'amber arc',
    explanation: 'Unencrypted: the exit, and anyone past it, can read it.' },
];

/** States that are a block of some kind: the Blocked KPI, filter chip and toggle. */
export const BLOCK_STATES: ReadonlySet<NetState> = new Set(['guard', 'user_rule', 'default_block']);

export const LEGEND_BY_KEY: Readonly<Record<string, StateInfo>> = Object.fromEntries(NET_LEGEND.map((s) => [s.key, s]));

/**
 * The Topology diagram's legend: the band kinds (`BandKind`) each entry stands for, its words and
 * its tip. Its colour is the diagram's own for its first kind (`BAND` in `TopologyView.tsx`), so the
 * legend cannot drift from what is drawn.
 */
export const TOPOLOGY_LEGEND: ReadonlyArray<{ bands: readonly BandKind[]; label: string; tip: string }> = [
  { bands: ['tunnel'], label: 'Tunnelled',
    tip: 'Traffic that left through the tunnel (a VPN, Tor, or your corporate proxy), so sites saw its address, not yours.' },
  { bands: ['fanout'], label: 'SearXNG fan-out',
    tip: 'One web search becomes many: glove’s search service (SearXNG) asks several search engines at once on the agent’s behalf.' },
  { bands: ['local', 'unwatched'], label: 'Not tunnelled',
    tip: 'Links that do not go through the tunnel: glove’s own services, a host on your network, and the agent’s model, which can still reach a cloud provider.' },
  { bands: ['direct'], label: 'Direct',
    tip: 'Traffic that left without the tunnel, carrying your real IP address.' },
  { bands: ['refused'], label: 'Refused',
    tip: 'Stopped at the policy wall by one of your rules, or by the default when no rule allowed it.' },
  { bands: ['guard', 'broken'], label: 'Guard / broken',
    tip: 'Refused by glove’s built-in guard (private addresses, cloud metadata), or a path that failed upstream: not a policy decision.' },
];

/** What a Topology band's width means. */
export const TOPOLOGY_BAND_WIDTH_TIP = 'A band is as wide as the square root of the bytes it carried, so a busy path stands out without hiding the quiet ones.';

/** The legend entry for each primary flow state. */
export const NET_STATE_INFO: Readonly<Record<NetState, StateInfo>> = {
  active: LEGEND_BY_KEY.active,
  pooled: LEGEND_BY_KEY.pooled,
  finished: LEGEND_BY_KEY.finished,
  guard: LEGEND_BY_KEY.guard,
  user_rule: LEGEND_BY_KEY.user_rule,
  default_block: LEGEND_BY_KEY.default_block,
  broken: LEGEND_BY_KEY.broken,
  gate_shutdown: LEGEND_BY_KEY.gate_shutdown,
  gate_lost: LEGEND_BY_KEY.gate_lost,
  empty: LEGEND_BY_KEY.empty,
};

/**
 * Formatting for the network views: bytes, ages, the gate strip's chips, and
 * the state legend every view draws from. Pure, so it is tested in node.
 */
import type { NetSessionData } from './net-state.js';
import type { NetState } from './netobs-types.js';

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

export interface GateChip {
  key: string;
  label: string;
  tone: ChipTone;
  icon: ChipIcon;
  /** Detail for the tooltip: heartbeat age, versions, exit IP and its source. */
  title: string;
}

const ROUTE_LABEL: Record<string, string> = { vpn: 'VPN', tor: 'Tor' };

/**
 * The gate strip, left to right (plan §6.1, ordered as the mockups draw it):
 * gate state; the untunnelled alarm when there is one, straight after it so it
 * cannot be missed; route and exit; resolver; rules; record mode; and "view
 * incomplete" when the data itself has holes.
 */
export function gateChips(data: NetSessionData): GateChip[] {
  const { gate, exit, totals, counters } = data;
  const chips: GateChip[] = [];
  const version = gate.gateVersion ? ` · gate ${gate.gateVersion}` : '';

  switch (gate.freshness) {
    case 'running':
      chips.push({ key: 'gate', label: 'Gate running', tone: 'ok', icon: 'pulse',
        title: `Heartbeat ${formatAge(gate.heartbeatAgeMs)} ago${version}` });
      break;
    case 'stale':
      chips.push({ key: 'gate', label: 'Gate stale · data stopped updating', tone: 'warn', icon: 'clock',
        title: `No heartbeat for ${formatAge(gate.heartbeatAgeMs)}. The data has stopped updating — that is not the same as the traffic stopping.${version}` });
      break;
    case 'stopped':
      chips.push({ key: 'gate', label: 'Gate stopped', tone: 'muted', icon: 'clock',
        title: `The gate reported "${gate.state}". What is shown is the record up to then.${version}` });
      break;
    default:
      chips.push({ key: 'gate', label: 'Gate status unknown', tone: 'muted', icon: 'clock',
        title: 'No status.json has been read for this session.' });
  }

  // The kill switch is on: said straight after the gate state, like the alarms, until restored.
  if (data.rules.file?.rules.some((r) => r.id.startsWith('r_layman_cut_'))) {
    const keep = data.rules.file.rules.some((r) => r.id.startsWith('r_layman_cut_') && r.action === 'allow');
    chips.push({ key: 'cut', label: 'ALL TRAFFIC CUT', tone: 'error', icon: 'alert',
      title: `Every connection is blocked by “Cut all traffic”${keep ? ', except the LLM link' : ''}. Restore puts back the previous rules.` });
  }

  if (totals.directFlows > 0) {
    chips.push({ key: 'direct', label: `${plural(totals.directFlows, 'untunnelled flow').toUpperCase()}`, tone: 'error', icon: 'alert',
      title: 'Traffic left the sandbox on a direct route, without the tunnel, and carried the operator’s real IP.' });
  }

  const kind = gate.route.kind;
  if (kind === 'direct') {
    chips.push({ key: 'route', label: 'Direct route · no tunnel', tone: 'error', icon: 'direct',
      title: 'The operator declared this session’s proxy route as direct: web traffic does not go through a VPN or Tor.' });
  } else if (kind === 'vpn' || kind === 'tor') {
    const name = ROUTE_LABEL[kind];
    const unhealthy = gate.route.upstreamHealthy === false ? ' · upstream failing' : '';
    const exitDetail = exit
      ? `Exit ${exit.ip ?? 'unknown IP'}${exit.city ? `, ${exit.city}` : ''}${exit.country ? `, ${exit.country}` : ''}. Reported by ${exit.source ?? 'an unnamed source'}, not looked up by Layman.`
      : 'No exit has been observed.';
    if (gate.route.verified && exit) {
      chips.push({ key: 'route', label: `${name} · exit verified${exit.country ? ` · ${exit.country}` : ''}${unhealthy}`,
        tone: unhealthy ? 'warn' : 'tunnel', icon: 'tunnel', title: exitDetail });
    } else if (gate.route.exitIdentityOff) {
      chips.push({ key: 'route', label: `${name} · declared${unhealthy}`, tone: unhealthy ? 'warn' : 'neutral', icon: 'tunnel',
        title: 'Exit identity is off for this session, so the route is as the operator declared it; nothing has verified it.' });
    } else {
      chips.push({ key: 'route', label: `${name} · declared, not verified${unhealthy}`, tone: 'warn', icon: 'tunnel',
        title: `${exitDetail} Trust the label less than an observed exit.` });
    }
  } else if (kind === 'tcp') {
    chips.push({ key: 'route', label: 'Local services only', tone: 'neutral', icon: 'tunnel',
      title: 'This session has no proxy service: only point-to-point links to configured endpoints.' });
  }

  const r = gate.resolver;
  if (r.mode === 'in-tunnel') {
    const name = r.name ? ` (${r.name})` : '';
    if (r.healthy === false) {
      chips.push({ key: 'resolver', label: 'Resolver down', tone: 'warn', icon: 'alert',
        title: `The in-tunnel resolver${name} is failing: new destinations go to "Unknown location". Traffic is not affected.` });
    } else {
      chips.push({ key: 'resolver', label: 'Resolver in-tunnel', tone: r.healthy ? 'ok' : 'neutral', icon: 'check',
        title: r.healthy === null
          ? `Hostnames are resolved inside the tunnel${name}; not used yet this session.`
          : `Hostnames are resolved inside the tunnel${name}, never by the operator’s resolver.` });
    }
  }

  const rules = gate.rules;
  if (rules) {
    if (!rules.ok) {
      chips.push({ key: 'rules', label: 'Rules rejected', tone: 'error', icon: 'alert',
        title: `glove rejected rules.json: ${rules.error ?? 'no reason given'}. It is still enforcing the previous ${plural(rules.active_count, 'rule')}.` });
    } else {
      const def = data.rules.file?.default;
      chips.push({ key: 'rules', label: rules.active_count ? `${plural(rules.active_count, 'rule')} enforced` : 'No rules',
        tone: 'neutral', icon: 'shield',
        title: `${rules.loaded_at ? `Loaded ${rules.loaded_at}` : 'Never loaded'}${def ? ` · when nothing matches: ${def}` : ''}` });
    }
  }

  chips.push(gate.record === 'full'
    ? { key: 'record', label: 'Record: full', tone: 'violet', icon: 'file',
      title: 'Full record mode: request URLs (and headers, if enabled) are recorded. The operator traded privacy for visibility.' }
    : { key: 'record', label: `Record: ${gate.record}`, tone: 'neutral', icon: 'file',
      title: 'Metadata only: destinations, timing and byte counts; no request content.' });

  const reasons: string[] = [];
  if (gate.telemetry && gate.telemetry.dropped > 0) reasons.push(`the gate dropped ${plural(gate.telemetry.dropped, 'record')}`);
  if (counters.gaps > 0) reasons.push(`${plural(counters.gaps, 'rotated file')} disappeared before Layman read ${counters.gaps === 1 ? 'it' : 'them'}`);
  if (data.historyTruncated) reasons.push('older history was beyond the read budget');
  if (reasons.length) {
    chips.push({ key: 'incomplete', label: 'View incomplete', tone: 'warn', icon: 'alert',
      title: `Some records are missing: ${reasons.join('; ')}. Traffic was not affected.` });
  }
  return chips;
}

// ─── The state legend (plan §6.3, state-legend.dc.html) ─────────────────────

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
 * Every state the network views tell apart: handoff §6.1 in its order, plus
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

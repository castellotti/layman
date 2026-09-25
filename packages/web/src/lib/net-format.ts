/**
 * Formatting for the network views: bytes, ages, and the gate strip's chips.
 * Pure, so it is tested in node. The per-flow state table (label, colour, icon
 * and toggle kind for every NetState) joins this file with the Network tab.
 */
import type { NetSessionData } from './net-state.js';

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

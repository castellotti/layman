/**
 * Known VPN routes, and what "untunnelled" means once they are known.
 *
 * glove calls a flow `direct` whenever it left without a vpn/tor tunnel glove set up
 * itself. On a corporate session that is the design: the corporate egress, and anything
 * else bound for the corporate network, rides the host's own VPN. The server marks such
 * flows and destinations `flags.vpn` (through glove's corporate egress, or a host the
 * user listed in `glove.network.vpnDomains`), and every view asks `isUntunnelled`, never
 * `scope === 'direct'`, before it raises the alarm.
 *
 * The matcher mirrors `packages/server/src/netobs/vpn.ts`; keep the two identical
 * (both have a test of the same cases). The browser needs it only to say which entry
 * covers a host, so Unmark removes the right one.
 */
import type { FlowFlags, NetTotals } from './netobs-types.js';

/** Glove's `direct`, unless it is a known VPN route: the traffic that carried the operator's real IP somewhere unexpected. */
export function isUntunnelled(scope: string, flags: Pick<FlowFlags, 'vpn'> | undefined): boolean {
  return scope === 'direct' && !flags?.vpn;
}

/** A `direct` that is a known VPN route. */
export function isVpnRoute(scope: string, flags: Pick<FlowFlags, 'vpn'> | undefined): boolean {
  return scope === 'direct' && !!flags?.vpn;
}

/** The untunnelled flows of a session's totals: glove's `direct` less the known VPN routes. */
export function untunnelledFlows(t: Pick<NetTotals, 'directFlows' | 'vpnFlows'>): number {
  return Math.max(0, t.directFlows - (t.vpnFlows ?? 0));
}

/** An entry as it is matched: lower case, no `*.`/`.` prefix, no trailing dot. Empty when unusable. */
export function normaliseVpnDomain(entry: string): string {
  let e = entry.trim().toLowerCase();
  if (e.startsWith('*.')) e = e.slice(2);
  else if (e.startsWith('.')) e = e.slice(1);
  if (e.endsWith('.')) e = e.slice(0, -1);
  return /^[a-z0-9.:_-]+$/.test(e) && !e.includes('..') ? e : '';
}

/** The entry of `list` that covers `host`, or null. */
export function vpnEntryFor(host: string | null, list: readonly string[]): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase();
  if (h.endsWith('.')) h = h.slice(0, -1);
  for (const raw of list) {
    const e = normaliseVpnDomain(raw);
    if (e && (h === e || h.endsWith(`.${e}`))) return raw;
  }
  return null;
}

/** Every entry of `list` that covers `host` (Unmark removes them all, or the host stays covered). */
export function vpnEntriesFor(host: string | null, list: readonly string[]): string[] {
  return list.filter((e) => vpnEntryFor(host, [e]) !== null);
}

/** `list` with `entry` added once (compared as matched), normalised for display. */
export function withVpnEntry(list: readonly string[], entry: string): string[] {
  const e = normaliseVpnDomain(entry);
  if (!e || list.some((x) => normaliseVpnDomain(x) === e)) return [...list];
  return [...list, e];
}

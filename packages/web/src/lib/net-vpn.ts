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
  if (!/^[a-z0-9.:_-]+$/.test(e) || e.includes('..')) return '';
  // Digits and dots only is an IPv4 address or nothing: `10.0.0` is not a subnet, and as a
  // suffix it would cover unrelated addresses (`5.10.0.0`).
  if (/^[0-9.]+$/.test(e) && !IPV4.test(e)) return '';
  return e;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** An IP literal is matched only exactly, never as a suffix. */
const isIpLiteral = (s: string): boolean => IPV4.test(s) || s.includes(':');

/** A host as it is matched: lower case, no trailing dot. */
const normaliseHost = (host: string): string => {
  const h = host.trim().toLowerCase();
  return h.endsWith('.') ? h.slice(0, -1) : h;
};

/** Whether the normalised entry `e` covers the normalised host `h`. */
const covers = (h: string, e: string): boolean =>
  h === e || (!isIpLiteral(e) && !isIpLiteral(h) && h.endsWith(`.${e}`));

/** The entry of `list` that covers `host`, or null. */
export function vpnEntryFor(host: string | null, list: readonly string[]): string | null {
  if (!host) return null;
  const h = normaliseHost(host);
  for (const raw of list) {
    const e = normaliseVpnDomain(raw);
    if (e && covers(h, e)) return raw;
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

/**
 * The domain "All of …" offers for a host: its parent (`jira.corp.example.com` →
 * `corp.example.com`, `git.corp.internal` → `corp.internal`). Not the registrable domain,
 * which is the whole public `example.com` for the first and the host itself for an
 * internal name. Null for an IP or a name with fewer than three labels.
 */
export function vpnParentDomain(host: string | null): string | null {
  const h = normaliseVpnDomain(host ?? '');
  if (!h || isIpLiteral(h)) return null;
  const labels = h.split('.');
  return labels.length >= 3 ? labels.slice(1).join('.') : null;
}

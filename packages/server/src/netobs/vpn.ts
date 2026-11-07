/**
 * Known VPN routes: hosts the user says reach their corporate network directly.
 *
 * glove calls a flow `direct` whenever it left without a vpn/tor tunnel glove set up
 * itself (`ForwardSpec.flow_scope`). On a corporate session that is the design, not a
 * leak: the corporate egress, and anything else bound for the corporate network, rides
 * the host's own VPN. The user names those hosts in Settings → Glove (`glove.network.
 * vpnDomains`) or from a destination's details; this matches them.
 *
 * An entry is a domain suffix: `corp.example` (or `*.corp.example`, `.corp.example`)
 * covers `corp.example` and every subdomain; an entry may also be a whole host or an
 * IP literal, matched exactly. Mirrored in `packages/web/src/lib/net-vpn.ts`; keep the
 * two identical (both have a test of the same cases).
 */

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

/**
 * A matcher for one list. `signature()` re-reads the list (the poll calls it once per tick
 * and re-sends every view when it changed); `matches()`, which runs for every destination
 * a view builds, only reads the entries normalised then.
 */
export function vpnMatcher(getList: () => readonly string[]): { matches: (host: string | null) => boolean; signature: () => string } {
  let sig = '';
  let entries: string[] = [];
  const refresh = () => {
    const list = getList();
    const next = list.join('\n');
    if (next !== sig) {
      sig = next;
      entries = list.map(normaliseVpnDomain).filter(Boolean);
    }
  };
  refresh();
  return {
    matches: (host) => {
      if (!host || entries.length === 0) return false;
      const h = normaliseHost(host);
      return entries.some((e) => covers(h, e));
    },
    signature: () => {
      refresh();
      return sig;
    },
  };
}

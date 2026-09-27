/**
 * Registrable-domain grouping: `en.wikipedia.org` groups under `wikipedia.org`.
 *
 * Runs on the server only, and the client receives the group key, so there is
 * one implementation. Entirely offline: `tldts` bundles the Public Suffix List,
 * so grouping is a string operation and must never become a lookup (see the
 * "never resolve gloved data" rule in docs/extensions/glove.md).
 */
import { parse } from 'tldts';

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Written out rather than taken from `node:net`'s `isIP`: the no-network guard
 * test fails any `netobs/` file importing `net`, deliberately crudely, and a
 * literal check does not justify an exemption. No hostname contains a colon, so
 * one is enough to call it IPv6.
 */
export function isIpLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return IPV4.test(h) || (h.includes(':') && /^[0-9a-f:.%a-z]+$/i.test(h));
}

/**
 * The registrable domain for `host`, or the host itself for an IP literal, a
 * single-label name, a name under a TLD that is not on the Public Suffix List
 * (`llm.operator.lan`, `ads.tracker.example` — an operator's own names, where
 * grouping one level up would suggest an organisation boundary that is not
 * there), or a bare suffix. The PSL's private section is honoured, so
 * `a.github.io` and `b.github.io` are separate owners. Null for a null host
 * (the caller groups those by service endpoint).
 */
export function registrableDomain(host: string | null): string | null {
  if (host === null) return null;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || isIpLiteral(h)) return h;
  const r = parse(h, { allowPrivateDomains: true });
  if (r.isIp || !(r.isIcann || r.isPrivate)) return h;
  return r.domain ?? h;
}

/**
 * The key a destination is grouped under. A null host (raw TCP with no SNI, a
 * malformed request) is its own group per service endpoint, never merged with
 * real destinations.
 */
export function groupKeyFor(host: string | null, service: string): string {
  return registrableDomain(host) ?? `@${service}`;
}

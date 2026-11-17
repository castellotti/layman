/**
 * The Styx Gibson feeds as the Gibson tabs ask for them (docs/extensions/styx.md → "The Gibson feed"). Pure.
 * The row types mirror `packages/server/src/styx/gibson.ts` (field names are the wire's); keep the two in
 * step by hand.
 */
import { feedQuery, type MatrixWindow } from './matrix-feed.js';

/** One tower. */
export interface HostRow {
  host: string;
  /** The block it stands in: a registrable domain, an IPv4's /16. */
  block: string;
  ports: number[];
  sent: number;
  received: number;
  count: number;
  /** Connections still open. */
  open: number;
  /** How many of `count` glove refused. */
  blocked: number;
  untunnelled: boolean;
  /** glove's scope (`direct`, `cloud`, `lan`, `local`…); '' when not known (a standard session). */
  scope: string;
  first_seen_ago: number;
  last_seen_ago: number;
  clients: string[];
  tools: string[];
  services: string[];
}

/** Who talks to whom: one row per (source, via, target). */
export interface LinkRow {
  source: string;
  source_kind: 'client' | 'agent' | 'device';
  via: string;
  target: string;
  sent: number;
  received: number;
  count: number;
  open: number;
  blocked: number;
  last_seen_ago: number;
}

/** One connection (gloved) or tool call (standard): a line of a tower's log. */
export interface LogRow {
  host: string;
  /** Epoch seconds. */
  time: number;
  ago: number;
  source: string;
  via: string;
  tool: string | null;
  port: number | null;
  proto: string | null;
  sent: number;
  received: number;
  state: string;
  blocked: boolean;
  rule: string | null;
  method: string | null;
  url: string | null;
  label: string | null;
}

export const GIBSON_LOG_LIMIT = 100;

/** Hosts and links, for one session (none: every live one) over a window; same query rule as the Matrix. */
export function gibsonUrls(opts: { sessionId: string | null; window: MatrixWindow }): { hosts: string; links: string } {
  const q = feedQuery(opts);
  return { hosts: `/api/styx/v1/hosts${q}`, links: `/api/styx/v1/links${q}` };
}

/** One tower's log. `host` rides in the query only; the path is fixed. */
export function gibsonLogUrl(opts: { sessionId: string | null; window: MatrixWindow; host: string; limit?: number }): string {
  const q = feedQuery(opts);
  const params = new URLSearchParams(q.replace(/^\?/, ''));
  params.set('host', opts.host);
  params.set('limit', String(opts.limit ?? GIBSON_LOG_LIMIT));
  return `/api/styx/v1/flows?${params.toString()}`;
}

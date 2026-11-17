/**
 * The Styx matrix feed's pure core: Layman's own records as the rows styx-godot's
 * `GET /v1/matrix` answers with. No I/O and no fastify, so every rule is tested alone
 * (docs/extensions/styx.md).
 */
import { REFUSED } from '../netobs/trace.js';
import type { DestinationAggregate, FlowView, TraceCall } from '../netobs/types.js';

/** One destination. Mirrored in `packages/web/src/lib/matrix-feed.ts`. */
export interface MatrixRow {
  address: string;
  sent: number;
  received: number;
  count: number;
  blocked: number;
  untunnelled: boolean;
}

export const MATRIX_MAX_ROWS = 256;

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `60s`, `15m`, `1h`, `2d` → ms. null when malformed (also `0s`, negatives, `1y`). */
export function parseRelative(raw: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(raw);
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  return ms > 0 && Number.isSafeInteger(ms) ? ms : null;
}

const withPort = (host: string, port: number | null | undefined): string =>
  (typeof port === 'number' ? `${host}:${port}` : host).toLowerCase();

/** Rows by address, summed. A row is untunnelled when any part of it is. */
function add(rows: Map<string, MatrixRow>, address: string, part: Omit<MatrixRow, 'address'>): void {
  const row = rows.get(address);
  if (!row) {
    rows.set(address, { address, ...part });
    return;
  }
  row.sent += part.sent;
  row.received += part.received;
  row.count += part.count;
  row.blocked += part.blocked;
  row.untunnelled ||= part.untunnelled;
}

/** Highest count first, ties by address; cut after sorting. */
function finish(rows: Iterable<MatrixRow>): MatrixRow[] {
  return [...rows]
    .sort((a, b) => b.count - a.count || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
    .slice(0, MATRIX_MAX_ROWS);
}

/** Glove's `direct`, unless a known VPN route: the web's `isUntunnelled` (`lib/net-vpn.ts`). */
export const untunnelled = (scope: string, flags: { vpn?: unknown }): boolean => scope === 'direct' && !flags.vpn;

/** The port a tool call's target used: its URL's, or its scheme's (null for ssh, which has neither). */
export const targetPort = (t: TraceCall['targets'][number]): number | null =>
  t.port ?? (t.scheme === 'https' ? 443 : t.scheme === 'http' ? 80 : null);

/**
 * Gloved, with a window: one row per destination among these flows. A hop (the sandbox's
 * local link to a sidecar) is not a destination: its bytes are counted at the next leg.
 */
export function rowsFromFlows(flows: readonly FlowView[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const f of flows) {
    if (f.flags.hop) continue;
    const host = f.dest.host ?? f.dest.ip;
    if (!host) continue;
    add(rows, withPort(host, f.dest.port), {
      sent: f.bytes.up,
      received: f.bytes.down,
      count: 1,
      blocked: REFUSED.has(f.state) ? 1 : 0,
      untunnelled: untunnelled(f.scope, f.flags),
    });
  }
  return finish(rows.values());
}

/** Gloved, whole record: glove's running totals per destination. */
export function rowsFromDestinations(dests: readonly DestinationAggregate[]): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const d of dests) {
    // A null host is a service endpoint, not a destination.
    if (d.flags.hop || !d.host) continue;
    add(rows, withPort(d.host, d.port), {
      sent: d.bytesUp,
      received: d.bytesDown,
      count: d.flows,
      blocked: d.blocked,
      untunnelled: untunnelled(d.scope, d.flags),
    });
  }
  return finish(rows.values());
}

/**
 * Standard session: the hosts its tool calls named, for calls that started in [from, to].
 * A call naming two hosts counts once for each. `callsFrom` already drops URLs the PII
 * filter redacted, so no host is re-derived from raw text here.
 */
export function rowsFromCalls(calls: readonly TraceCall[], from: number, to: number): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const c of calls) {
    if (c.start < from || c.start > to) continue;
    // `https://x/` and `https://x:443/` are one address: a call counts once for each address.
    const seen = new Set<string>();
    for (const t of c.targets) {
      const address = withPort(t.host, targetPort(t));
      if (seen.has(address)) continue;
      seen.add(address);
      add(rows, address, { sent: 0, received: 0, count: 1, blocked: 0, untunnelled: false });
    }
  }
  return finish(rows.values());
}

/** Several sources as one answer: the same address summed, sorted, capped. */
export function mergeRows(parts: ReadonlyArray<readonly MatrixRow[]>): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  for (const part of parts) {
    for (const r of part) add(rows, r.address, r);
  }
  return finish(rows.values());
}

/**
 * The single source of state logic for network views: which of glove's state table's
 * states a flow, a destination, or a gate is in. Pure, and the web client
 * receives the results rather than recomputing them.
 */
import type {
  ExitRecord,
  FlowFlags,
  FlowRecord,
  FlowScope,
  NetGateView,
  NetSessionFile,
  NetState,
  StatusRecord,
} from './types.js';
import { FLOW_SCOPES, neverMapped } from './types.js';

/** An open flow with no byte change for longer than this is "pooled, idle", not live. */
export const IDLE_MS = 3_000;

/** A `running` gate whose heartbeat is older than this has stopped reporting (glove's record contract). */
export const STALE_MS = 20_000;

/** A flow's latest record plus the one fact the store tracks across records. */
export type ClassifiableFlow = Pick<
  FlowRecord,
  'phase' | 'verdict' | 'rule' | 'close_reason' | 'dest' | 'scope' | 'proto' | 'client' | 'tool'
> & {
  lastActivityAt: number;
  /** The flow's `run` has ended (glove's record contract). Only an unclosed flow cares. */
  runEnded?: boolean;
};

export const BLOCK_STATES: ReadonlySet<NetState> = new Set(['guard', 'user_rule', 'default_block']);

/**
 * A flow's primary state.
 *
 * Blocks are checked first, and by `close_reason: "blocked"` as well as by
 * verdict: a `terminate: true` rule cuts an *established* flow, which closes
 * with `close_reason: "blocked"` and the rule's id (glove's record contract), and that is the
 * user's rule acting whatever verdict the flow was opened with.
 */
export function classifyFlow(f: ClassifiableFlow, now: number): NetState {
  if (f.verdict === 'block' || f.close_reason === 'blocked') {
    if (f.rule?.startsWith('builtin:')) return 'guard';
    if (f.rule) return 'user_rule';
    return 'default_block';
  }
  if (f.phase !== 'close') {
    // The forwarder that carried it is gone, so no close will ever come: glove
    // shows this as "cut by gate shutdown, inferred".
    if (f.runEnded) return 'gate_lost';
    return now - f.lastActivityAt > IDLE_MS ? 'pooled' : 'active';
  }
  switch (f.close_reason) {
    case 'gate_shutdown':
      return 'gate_shutdown';
    case 'upstream_unreachable':
      // Only eof/timeout are "empty"; an upstream failure is never folded away.
      return 'broken';
    case 'timeout':
      // An idle proxy connection that never named a destination is noise; a
      // timeout with a real destination is a broken path.
      return f.dest.host === null ? 'empty' : 'broken';
    case 'eof':
      return f.dest.host === null ? 'empty' : 'finished';
    default:
      return 'finished';
  }
}

export function flowFlags(f: Pick<FlowRecord, 'dest' | 'scope' | 'proto' | 'client' | 'tool'>): FlowFlags {
  const scope = (FLOW_SCOPES as readonly string[]).includes(f.scope) ? (f.scope as FlowScope) : 'unknown';
  return {
    scope,
    // Local links are never mapped (rule 11), so "unresolved" only means
    // something for traffic that would otherwise be placed on the map.
    unresolved:
      !neverMapped(scope) && f.dest.host !== null && (f.dest.ip === null || f.dest.resolution === 'unavailable'),
    noHost: f.dest.host === null,
    cleartext: f.proto === 'http' || f.dest.port === 80,
    fanout: f.client === 'searxng' || f.tool === 'search-engine-fanout',
  };
}

/**
 * A destination row's state from its flows' states, oldest first: live if any
 * flow is live, else pooled if any is pooled, else the most recent flow's.
 * Folded empty connections never reach a destination.
 */
export function aggregateState(statesOldestFirst: readonly NetState[]): NetState {
  if (statesOldestFirst.includes('active')) return 'active';
  if (statesOldestFirst.includes('pooled')) return 'pooled';
  return statesOldestFirst[statesOldestFirst.length - 1] ?? 'finished';
}

export interface SessionInputs {
  status: StatusRecord | null;
  /** status.json's mtime: the heartbeat of a gate too old to write `t`. */
  statusMtimeMs: number | null;
  exit: ExitRecord | null;
  session: NetSessionFile | null;
}

/** Session-wide states: gate freshness, route trust, resolver, rules, telemetry. */
export function classifySession(inp: SessionInputs, now: number): NetGateView {
  const { status, exit, session } = inp;
  const beat = status?.t ? Date.parse(status.t) : inp.statusMtimeMs;
  const heartbeatAgeMs = beat !== null && beat !== undefined && Number.isFinite(beat) ? Math.max(0, now - beat) : null;

  let freshness: NetGateView['freshness'] = 'unknown';
  if (status) {
    if (status.state !== 'running') freshness = 'stopped';
    else if (heartbeatAgeMs !== null && heartbeatAgeMs > STALE_MS) freshness = 'stale';
    else freshness = 'running';
  }

  return {
    freshness,
    state: status?.state ?? null,
    gateVersion: status?.gate ?? session?.gate ?? null,
    heartbeatAgeMs,
    record: status?.record ?? session?.record ?? 'metadata',
    route: {
      kind: session?.upstream_kind ?? status?.upstream?.kind ?? null,
      // Declared until an exit is observed healthy (rule 13).
      verified: exit?.healthy === true,
      exitIdentityOff: session?.exit_identity === 'none',
      upstreamHealthy: status?.upstream?.healthy ?? null,
    },
    resolver: {
      mode: status?.resolver?.mode ?? session?.resolve ?? null,
      healthy: status?.resolver?.healthy ?? null,
      name: session?.resolver ?? null,
    },
    rules: status?.rules ?? null,
    telemetry: status?.telemetry ?? null,
    unwatchedServices: (session?.services ?? []).filter((s) => !s.observed).map((s) => s.service),
  };
}

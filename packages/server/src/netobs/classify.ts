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
  GateSince,
  NetGateView,
  NetSessionFile,
  NetState,
  SinceAt,
  StatusRecord,
} from './types.js';
import { FLOW_SCOPES, isLanOnlyRule, neverMapped } from './types.js';

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
    if (f.rule?.startsWith('builtin:') || isLanOnlyRule(f.rule)) return 'guard';
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

/**
 * `hop`: the flow's service goes on through another gate (`isHopService`), so it
 * is a local link to a sidecar whatever its scope says (the `llm` hop to llm-auth
 * carries the provider's `cloud`).
 */
export function flowFlags(f: Pick<FlowRecord, 'dest' | 'scope' | 'proto' | 'client' | 'tool'>, hop = false): FlowFlags {
  const scope = (FLOW_SCOPES as readonly string[]).includes(f.scope) ? (f.scope as FlowScope) : 'unknown';
  return {
    scope,
    // Local links are never mapped (rule 11), so "unresolved" only means
    // something for traffic that would otherwise be placed on the map.
    unresolved:
      !hop && !neverMapped(scope) && f.dest.host !== null && (f.dest.ip === null || f.dest.resolution === 'unavailable'),
    noHost: f.dest.host === null,
    cleartext: f.proto === 'http' || f.dest.port === 80,
    fanout: f.client === 'searxng' || f.tool === 'search-engine-fanout',
    hop,
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
    since: { gate: null, route: null, exit: null, resolver: null },
  };
}

/** What the records say, for a part Layman did not see change. */
export interface SinceRecords {
  /** Exit records, oldest first. */
  exits: readonly ExitRecord[];
  /** The latest collector run's start and stop (`HistoryRun`), if any. */
  run: { started: number; ended: number | null } | null;
}

/** The earliest record of the unbroken streak at the end of `exits` that `same` holds for, or null. */
function streakStart(exits: readonly ExitRecord[], same: (e: ExitRecord) => boolean): number | null {
  let t: number | null = null;
  for (let i = exits.length - 1; i >= 0 && same(exits[i]); i--) t = Date.parse(exits[i].t);
  return t !== null && Number.isFinite(t) ? t : null;
}

/**
 * When each part of the gate view became what it is (`GateSince`). A part Layman saw change
 * (between two reads, a second apart) changed `now`. One it did not see change (the first read
 * after a start, or a restart) is taken from the records: a running gate since its run's start, a
 * stopped one since its stop, a stale one since its last heartbeat (`beat`), a verified exit since
 * the first record of its unbroken healthy streak, an exit IP since its first record in a row.
 * Where nothing says, null: a tooltip then leaves "since" out rather than guess.
 */
export function gateSince(
  prev: NetGateView, next: NetGateView, rec: SinceRecords & { prevExitIp: string | null }, beat: number | null, now: number,
): GateSince {
  // A status had been read before: a difference now is a change seen happening.
  const seen = prev.state !== null;
  const keep = (part: keyof GateSince, before: string, after: string, backfill: () => SinceAt | null): SinceAt | null => {
    if (seen && before === after) return prev.since[part];
    if (seen) return { t: now, exact: true };
    return backfill();
  };
  const at = (t: number | null | undefined, exact = true): SinceAt | null => (t === null || t === undefined || !Number.isFinite(t) ? null : { t, exact });

  const routeKey = (v: NetGateView) => `${v.route.kind}|${v.route.verified}|${v.route.exitIdentityOff}|${v.route.upstreamHealthy}`;
  const exitIp = rec.exits.at(-1)?.ip ?? null;
  return {
    gate: keep('gate', prev.freshness, next.freshness, () => {
      switch (next.freshness) {
        case 'running': return at(rec.run && rec.run.ended === null ? rec.run.started : null);
        case 'stale': return at(beat);
        case 'stopped': return at(rec.run?.ended ?? beat);
        default: return null;
      }
    }),
    route: keep('route', routeKey(prev), routeKey(next), () =>
      next.route.verified ? at(streakStart(rec.exits, (e) => e.healthy)) : null),
    exit: keep('exit', String(rec.prevExitIp), String(exitIp), () =>
      exitIp === null ? null : at(streakStart(rec.exits, (e) => e.ip === exitIp))),
    resolver: keep('resolver', `${prev.resolver.mode}|${prev.resolver.healthy}`, `${next.resolver.mode}|${next.resolver.healthy}`, () => null),
  };
}

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
  /** Exit records, oldest first: as many as Layman holds, which may not reach back to the first. */
  exits: readonly ExitRecord[];
  /** The latest collector run (`HistoryRun`), if any: its id, start and stop. */
  run: { id: string; started: number; ended: number | null } | null;
}

/**
 * When the unbroken streak at the end of `exits` that `same` holds for began, or null. Exact when
 * the record before it is held and breaks it; a lower bound when the streak runs back to the
 * oldest record held (older ones expired, or only the last was kept), since it may be longer.
 */
function streakStart(exits: readonly ExitRecord[], same: (e: ExitRecord) => boolean): SinceAt | null {
  let i = exits.length - 1;
  if (i < 0 || !same(exits[i])) return null;
  while (i > 0 && same(exits[i - 1])) i--;
  const t = Date.parse(exits[i].t);
  return Number.isFinite(t) ? { t, exact: i > 0 } : null;
}

const recordTime = (e: ExitRecord | undefined) => {
  const t = e ? Date.parse(e.t) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * When each part of the gate view became what it is (`GateSince`). Each part is dated by the
 * record that says so when there is one, seen live or read back after a restart, so the two agree:
 * a running gate since its run's start, a stale one since its last heartbeat (`beat`), a stopped
 * one since its run's stop, a verified exit since its healthy streak began, an exit IP since its
 * first record in a row. A change no record dates (the resolver's health) is dated when Layman saw
 * it, between two reads a second apart, and is null after a restart. Where nothing says, null: a
 * tooltip then leaves "since" out rather than guess.
 */
export function gateSince(
  prev: NetGateView, next: NetGateView, rec: SinceRecords & { prevExitIp: string | null; prevRunId: string | null }, beat: number | null, now: number,
): GateSince {
  // A status had been read before: a difference now is a change seen happening.
  const seen = prev.state !== null;
  const at = (t: number | null | undefined): SinceAt | null => (t === null || t === undefined || !Number.isFinite(t) ? null : { t, exact: true });
  /** The part as it was if unchanged; if changed (or first seen), what the records say, else `now` if seen. */
  const part = (name: keyof GateSince, before: string, after: string, dated: () => SinceAt | null): SinceAt | null => {
    if (seen && before === after) return prev.since[name];
    return dated() ?? (seen ? { t: now, exact: true } : null);
  };

  // The gate is the same while its state and its run are: a new `glove up` is a new run, running again.
  const runId = rec.run?.id ?? '';
  const exitIp = rec.exits.at(-1)?.ip ?? null;
  return {
    gate: part('gate', `${prev.freshness}|${rec.prevRunId ?? ''}`, `${next.freshness}|${runId}`, () => {
      switch (next.freshness) {
        case 'running': return at(rec.run && rec.run.ended === null ? rec.run.started : null);
        // The clock, not a record, turns a gate stale: it went quiet at its last heartbeat.
        case 'stale': return at(beat);
        case 'stopped': return at(rec.run?.ended ?? beat);
        default: return null;
      }
    }),
    // "Verified since": the route's kind and whether its exit is verified, not its upstream's
    // health, which glove reports with no time and which a blip would otherwise re-date.
    route: part('route', `${prev.route.kind}|${prev.route.verified}|${prev.route.exitIdentityOff}`,
      `${next.route.kind}|${next.route.verified}|${next.route.exitIdentityOff}`,
      () => (next.route.verified ? streakStart(rec.exits, (e) => e.healthy) : null)),
    exit: part('exit', String(rec.prevExitIp), String(exitIp), () =>
      exitIp === null ? null : seen && rec.prevExitIp !== exitIp ? at(recordTime(rec.exits.at(-1))) : streakStart(rec.exits, (e) => e.ip === exitIp)),
    resolver: part('resolver', `${prev.resolver.mode}|${prev.resolver.healthy}`, `${next.resolver.mode}|${next.resolver.healthy}`, () => null),
  };
}

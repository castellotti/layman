/**
 * What Layman keeps of a glove session between restarts: one row
 * per session and one per destination, written by `persist.ts` and read back
 * into `NetStore` before the files are backfilled.
 *
 * The rows are running totals as the views showed them, plus a watermark: the
 * latest record time they include. On restart the store counts, for every flow
 * it re-reads, how much came from records before the watermark, plus what the
 * carried flows (`CarryFlow`) held at it — exactly the part the rows already
 * hold — and shows rows − that + everything read.
 * So re-reading a file never counts twice, and totals from files glove has
 * since deleted (rotation keeps 8) or that a truncated backfill skipped are
 * kept. A session whose files are all gone is the limiting case: history only.
 */
import type { ExitRecord, NetSessionFile, NetState, StatusRecord } from './types.js';

export interface HistoryDest {
  /** The destination key (`host:port`, or `@service` when glove saw no host). */
  key: string;
  host: string | null;
  port: number | null;
  groupKey: string;
  lastIp: string | null;
  scope: string | null;
  resolution: string | null;
  tool: string | null;
  firstSeen: number;
  lastSeen: number;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  blocked: number;
  lastState: NetState | null;
  /**
   * Its flows go on through another gate (the llm hop to llm-auth): a local link, kept so a
   * history-only hop stays off the Map. Absent in rows kept before migration 5.
   */
  hop?: boolean;
}

/**
 * A flow the rollup holds that the files could still extend or only partly
 * contain on restart: open when it was written, or with a record in the
 * watermark's own millisecond (glove writes many records per millisecond, and
 * that millisecond may have been only partly read). Its bytes and key are what
 * the rollup counts for it; everything else it gets is new.
 */
export interface CarryFlow {
  key: string | null;
  up: number;
  down: number;
  blocked: NetState | null;
  direct: boolean;
}

export interface HistorySession {
  /** glove's session id. */
  token: string;
  /**
   * The last `grants.filter.since` Layman saw while the session had the filter
   * grant. glove drops it on revocation and leaves no other trace, so this is
   * how a revoked session still reads as revoked after a restart.
   */
  filterSince: string | null;
  /** Whether `control/<id>/` was seen under that grant: only a directory that went away under it is a revocation. */
  filterSawDir: boolean;
  firstSeen: number;
  lastSeen: number;
  /** The latest record time these totals include: every record before it was read. */
  watermark: number;
  /** Flows open at the watermark or with a record at it, by id (see `CarryFlow`). */
  carry: Record<string, CarryFlow>;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  blockedGuard: number;
  blockedRule: number;
  blockedDefault: number;
  directFlows: number;
  lastExit: ExitRecord | null;
  lastStatus: StatusRecord | null;
  sessionFile: NetSessionFile | null;
  destinations: HistoryDest[];
  /**
   * The time axis (`HistoryHour`, `HistoryRun`). Unlike the rows above these are upserts: a
   * rollup may carry only those that changed since the last one (`NetStore.rollup(…, true)`),
   * and a store merges them by key. Absent in rows kept before migration 6, which the store
   * tells apart from "no traffic": without them it counts the hours of everything it reads.
   */
  hours?: HistoryHour[];
  runs?: HistoryRun[];
}

/**
 * One destination's traffic, for one tool, in one hour of one collector run: what moved in it
 * (by record time, as a time range's clip counts it, `range.ts`), the flows first seen and the
 * refusals recorded in it, and the first and last record in it that moved bytes, opened a flow
 * or was refused (a refused connection is the agent trying something; a heartbeat is not activity).
 * Keyed by run, so an hour in which one `glove up` ends and the next starts is two rows and each
 * run's bursts (`segments.ts`) have exact edges; and by tool, so a model call is never hidden by
 * another tool using the same host in the same hour.
 */
export interface HistoryHour {
  /** The hour's start, epoch ms. */
  hour: number;
  /** The collector run it was recorded in (`HistoryRun.run`), or null outside any (an older gate, or between runs). */
  run: string | null;
  /** The destination key (`destKey`). */
  key: string;
  /** The flows' tool (`llm` marks model calls: when the agent was working). */
  tool: string | null;
  /**
   * A hop's bytes are the next leg's too: the session's hours leave them out. Which services are
   * hops follows session.json, so the store re-flags a destination's rows when that changes.
   */
  hop: boolean;
  bytesUp: number;
  bytesDown: number;
  flows: number;
  blocked: number;
  /**
   * Of `blocked`, those glove's guard refused and those a user's rule did (the rest, the default):
   * kept per hour, since a destination's kind of refusal can change (`hourlyHistory` reads them).
   */
  blockedGuard: number;
  blockedRule: number;
  /** Of `flows`, those that went out directly, not through the tunnel. */
  direct: number;
  first: number;
  last: number;
}

/**
 * One run of the gate's collector (`type: gate`, `role: collect`): one `glove up` to its
 * `glove down`, or the collector's own inferred stop when it died. What moved during it is
 * not kept here but summed from its hours (`segments.ts`), so the two can never disagree.
 */
export interface HistoryRun {
  run: string;
  started: number;
  /** Null while it runs, or when no stop was ever recorded. */
  ended: number | null;
  inferred: boolean;
}

/**
 * Where history is kept. `persist.ts` is the SQLite one; tests use a map. `save` replaces a
 * session's row and destinations, and upserts its hours and runs (never deleting one).
 */
export interface NetHistory {
  /** Recording is on: Layman records nothing when it is off, network rollups included. */
  enabled(): boolean;
  load(): HistorySession[];
  save(sessions: HistorySession[]): void;
}

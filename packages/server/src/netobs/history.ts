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
}

/** Where history is kept. `persist.ts` is the SQLite one; tests use a map. */
export interface NetHistory {
  /** Recording is on: Layman records nothing when it is off, network rollups included. */
  enabled(): boolean;
  load(): HistorySession[];
  save(sessions: HistorySession[]): void;
}

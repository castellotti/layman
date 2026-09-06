/**
 * Wire protocol for multi-host sync (docs/planning/multi-host-sync.md §3.7, §3.12).
 *
 * These are the only sync types the web client mirrors (Phase 2). Bumping
 * `SYNC_PROTOCOL_VERSION` is a breaking change: `hello` checks it on both sides
 * and a mismatch returns HTTP 426.
 */
export const SYNC_PROTOCOL_VERSION = 1;

export type SyncKind =
  | 'session'
  | 'event'
  | 'qa'
  | 'bookmark_folder'
  | 'bookmark'
  | 'highlight_folder'
  | 'highlight';

/** Order entities are applied in, so a referenced session lands before its children. */
export const SYNC_KIND_ORDER: SyncKind[] = [
  'session',
  'event',
  'qa',
  'bookmark_folder',
  'bookmark',
  'highlight_folder',
  'highlight',
];

/** A row as it travels the wire: DB column names, JSON blobs left as strings. */
export type WireRow = Record<string, unknown>;

export type PushEntry =
  | { op: 'upsert'; kind: SyncKind; id: string; row: WireRow }
  | { op: 'delete'; kind: SyncKind; id: string };

export interface PresenceSession {
  sessionId: string;
  cwd: string;
  agentType: string;
  sessionName?: string;
  lastSeen: number;
}

export interface PresencePayload {
  activeSessionIds: string[];
  sessions: PresenceSession[];
}

export interface PushBatch {
  hostId: string;
  entries: PushEntry[];
  /**
   * Highest `sync_log.seq` this batch covers, for an incremental push. Central
   * echoes it back as `ackSeq`; the remote advances its cursor only then.
   * Omitted during backfill (entries carry no seq), when `ackSeq` is null.
   */
  upToSeq?: number;
  live?: PresencePayload;
}

export interface PushResponse {
  ackSeq: number | null;
  applied: number;
  conflicts: number;
  headSeq: number;
}

export interface HelloRequest {
  hostId: string;
  hostName: string;
  platform?: string;
  laymanVersion?: string;
  protocolVersion: number;
}

export interface HelloResponse {
  centralHostId: string;
  centralHostName: string;
  protocolVersion: number;
  /** What central last acked from this peer's pushes (its `last_push_seq`). */
  lastAckedSeq: number | null;
  /** Central's current journal head, so the remote can gauge mirror backlog. */
  headSeq: number;
}

/** One page of a mirror bootstrap snapshot (docs/planning/multi-host-sync.md §3.10). */
export interface SnapshotPage {
  kind: SyncKind;
  entries: PushEntry[];
  /** Id to resume after, or null when this kind is exhausted. */
  nextCursor: string | null;
  /** Central's journal head at the time of the call, for pull_snapshot_head. */
  headSeq: number;
  /** Host rows so a mirror can label chips for hosts it has never met. */
  hosts: HostStats[];
}

/** Incremental mirror changes since a seq, or a resync signal. */
export interface ChangesResponse {
  resync?: boolean;
  entries: PushEntry[];
  /** The highest seq covered; the puller advances pull_acked_seq to it. */
  headSeq: number;
  /**
   * True when central scanned a full page of the log and more may remain past
   * `headSeq`. The puller must key its "keep pulling" decision on this, not on
   * `entries.length`: dedup can collapse a full page below the request limit,
   * which would otherwise look "caught up" while a backlog sits unscanned.
   * Optional for wire-compat with a central that predates it.
   */
  more?: boolean;
  hosts: HostStats[];
}

export interface HostStats {
  hostId: string;
  name: string;
  kind: string; // 'local' | 'remote' | 'central'
  platform: string | null;
  laymanVersion: string | null;
  firstSeen: number;
  lastSeen: number;
  sessionCount: number;
  eventCount: number;
  contentBytes: number;
  firstActivity: number | null;
  lastActivity: number | null;
}

export interface PeerDTO {
  tokenHash: string;
  name: string;
  hostId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastPushSeq: number | null;
  lastPullSeq: number | null;
  intervalSeconds: number | null;
  revokedAt: number | null;
  lastError: string | null;
}

export type SyncRunState = 'idle' | 'syncing' | 'backfill' | 'backoff' | 'error' | 'paused';
export type PullRunState = 'idle' | 'snapshot' | 'incremental' | 'backoff' | 'error' | 'paused';

export interface PullStatus {
  enabled: boolean;
  state: PullRunState;
  pullAckedSeq: number | null;
  snapshotKind: SyncKind | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

export interface SyncStatus {
  role: 'standalone' | 'central' | 'remote';
  hostId: string;
  hostName: string;
  state: SyncRunState;
  /** headSeq - pushAckedSeq: own-origin entries not yet confirmed by central. */
  backlog: number;
  pushAckedSeq: number | null;
  /** During backfill: how far the current kind has paged, for a progress label. */
  backfillKind: SyncKind | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  /** Mirror pull status when role === 'remote' && mirror; absent otherwise. */
  pull?: PullStatus;
}

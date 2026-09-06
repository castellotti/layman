import type { Database } from '../db/database.js';
import type { SyncKind } from './protocol.js';

export interface LogEntry {
  seq: number;
  kind: SyncKind;
  entityId: string;
  originHostId: string;
  op: 'upsert' | 'delete';
  sessionId: string | null;
}

interface RawLog {
  seq: number;
  kind: string;
  entity_id: string;
  origin_host_id: string;
  op: string;
  session_id: string | null;
}

function toEntry(r: RawLog): LogEntry {
  return {
    seq: r.seq,
    kind: r.kind as SyncKind,
    entityId: r.entity_id,
    originHostId: r.origin_host_id,
    op: r.op as 'upsert' | 'delete',
    sessionId: r.session_id,
  };
}

/**
 * Reads over `sync_log` (docs/planning/multi-host-sync.md §3.4). The log is
 * written entirely by triggers; this is the read/maintenance side. Deduping a
 * page down to one entry per `(kind, entity_id)` and loading current state is
 * the pusher's job — the journal just returns ordered slices.
 */
export class SyncJournal {
  constructor(private db: Database) {}

  /** Highest seq in the log, or 0 when empty. */
  headSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_log').get() as { s: number };
    return row.s;
  }

  /** Own-origin entries newer than `afterSeq`, ascending, capped at `limit`. */
  readSince(originHostId: string, afterSeq: number, limit: number): LogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT seq, kind, entity_id, origin_host_id, op, session_id
         FROM sync_log WHERE origin_host_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(originHostId, afterSeq, limit) as RawLog[];
    return rows.map(toEntry);
  }

  /** Non-own-origin entries newer than `afterSeq` (mirror pull; used in Phase 4). */
  readChangesSince(excludeHostId: string, afterSeq: number, limit: number): LogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT seq, kind, entity_id, origin_host_id, op, session_id
         FROM sync_log WHERE origin_host_id != ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(excludeHostId, afterSeq, limit) as RawLog[];
    return rows.map(toEntry);
  }

  suppress(kind: SyncKind, entityId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sync_suppressions (kind, entity_id, created_at) VALUES (?, ?, ?)`,
      )
      .run(kind, entityId, Date.now());
  }

  isSuppressed(kind: SyncKind, entityId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM sync_suppressions WHERE kind = ? AND entity_id = ?')
      .get(kind, entityId) as { x: number } | undefined;
    return !!row;
  }

  clearSuppressions(): number {
    return this.db.prepare('DELETE FROM sync_suppressions').run().changes;
  }

  /** Lowest seq still in the log, or null when empty. */
  oldestSeq(): number | null {
    const row = this.db.prepare('SELECT MIN(seq) AS s FROM sync_log').get() as { s: number | null };
    return row.s;
  }

  /**
   * Compaction (§3.10). Never touches entity tables, only the journal:
   *  - collapse duplicate entries for the same (kind, entity_id) to the newest;
   *  - on a remote, drop own-origin entries already acked by central;
   *  - on a central, drop entries older than the retention window.
   * A remote's unacked own-origin entries are always kept (ackedSeq gates them),
   * so nothing pending is ever lost.
   */
  compact(opts: {
    localHostId: string;
    pushAckedSeq?: number | null;
    retentionMs?: number;
  }): number {
    let removed = 0;
    const tx = this.db.transaction(() => {
      // 1. Keep only the newest entry per (kind, entity_id).
      removed += this.db
        .prepare(
          `DELETE FROM sync_log WHERE seq NOT IN (
             SELECT MAX(seq) FROM sync_log GROUP BY kind, entity_id
           )`,
        )
        .run().changes;

      // 2. Remote: own-origin entries already confirmed by central.
      if (opts.pushAckedSeq != null) {
        removed += this.db
          .prepare('DELETE FROM sync_log WHERE origin_host_id = ? AND seq <= ?')
          .run(opts.localHostId, opts.pushAckedSeq).changes;
      }

      // 3. Central: entries older than the retention window.
      if (opts.retentionMs != null) {
        removed += this.db
          .prepare('DELETE FROM sync_log WHERE created_at < ?')
          .run(Date.now() - opts.retentionMs).changes;
      }
    });
    tx();
    return removed;
  }
}

import type { Database } from '../db/database.js';

/**
 * Typed key/value access over the `sync_state` table.
 *
 * `sync_state` holds the local host id (read by the journal triggers, so it must
 * live in SQLite rather than only in config) plus the push/pull cursors used by
 * later phases. Keys are a closed set; see docs/planning/multi-host-sync.md §4.
 */
export type SyncStateKey =
  | 'hostId'
  | 'push_acked_seq'
  | 'push_backfill_head'
  | 'push_backfill_cursor'
  | 'pull_acked_seq'
  | 'pull_snapshot_head'
  | 'pull_snapshot_cursor';

export class SyncState {
  constructor(private db: Database) {}

  get(key: SyncStateKey): string | null {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row ? row.value : null;
  }

  set(key: SyncStateKey, value: string | null): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  delete(key: SyncStateKey): void {
    this.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key);
  }
}

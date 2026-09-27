import { EventEmitter } from 'events';
import type { Database } from '../db/database.js';
import { filterPii, redactString } from '../pii/filter.js';
import type { EventData } from '../events/types.js';
import { CURATION_KINDS, SYNC_ENTITIES } from './entities.js';
import { SyncJournal } from './journal.js';
import { updateHostStats } from './stats.js';
import type { PushEntry, WireRow } from './protocol.js';

export interface ApplyResult {
  applied: number;
  conflicts: number;
}

export interface ApplierOptions {
  /** When true, event payloads are re-redacted on ingest (defence in depth). */
  piiFilter?: boolean;
  /**
   * When true, each row keeps the origin carried in its own `host_id` rather
   * than being forced to `originHostId`. Push sets this false (a peer may only
   * push its own data, so the authenticated origin wins); mirror pull sets it
   * true (central relays many hosts' rows, each with its true origin).
   */
  trustRowOrigin?: boolean;
  /**
   * Skip the per-batch `sync_hosts` counter refresh. During a mirror **snapshot**
   * that recompute is a full `COUNT`/`SUM` over `recorded_events` on *every* page
   * — hundreds of heavy scans interleaved with the bulk writes, which over a
   * FUSE-backed bind-mounted DB is a documented corruption trigger (see
   * `db/database.ts`). The puller sets this and calls `recomputeHostStats` once
   * when the snapshot completes instead.
   */
  deferStats?: boolean;
}

const KIND_ORDER: Record<string, number> = {
  session: 0, event: 1, qa: 2, bookmark_folder: 3, bookmark: 4, highlight_folder: 5, highlight: 6,
};

/**
 * Applies a peer's push batch on central.
 *
 * Everything runs in one transaction, entries in registry order regardless of
 * arrival order, so a bookmark that references a not-yet-seen session still
 * lands. Writes go straight through the entity tables — never through
 * `EventStore` — so the journal triggers re-record them with the peer's true
 * origin, which is exactly what mirror pull needs. A peer may only push its own
 * data: session/curation rows are stamped with the authenticated `originHostId`,
 * and a session id already owned by a different host is rejected as a conflict.
 */
export class SyncApplier extends EventEmitter {
  private journal: SyncJournal;

  constructor(private db: Database) {
    super();
    this.journal = new SyncJournal(db);
  }

  apply(originHostId: string, entries: PushEntry[], opts: ApplierOptions = {}): ApplyResult {
    let applied = 0;
    let conflicts = 0;

    const ordered = [...entries].sort(
      (a, b) => (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99),
    );

    const touchedOrigins = new Set<string>();

    const tx = this.db.transaction(() => {
      for (const entry of ordered) {
        const entity = SYNC_ENTITIES[entry.kind];
        if (!entity) continue; // unknown kind — ignore (JSON passthrough, §3.12)

        if (entry.op === 'delete') {
          entity.remove(this.db, entry.id);
          applied++;
          continue;
        }

        if (this.journal.isSuppressed(entry.kind, entry.id)) continue;

        const row: WireRow = { ...entry.row };
        // On pull, honour the row's own origin; on push, force the pusher's.
        const rowOrigin = opts.trustRowOrigin && typeof row.host_id === 'string' && row.host_id
          ? row.host_id
          : originHostId;

        if (entry.kind === 'session') {
          const existing = entity.load(this.db, [entry.id])[0] as { host_id?: string } | undefined;
          if (existing && existing.host_id && existing.host_id !== rowOrigin) {
            conflicts++;
            continue; // collision: never overwrite another host's session
          }
          row.host_id = rowOrigin;
          touchedOrigins.add(rowOrigin);
        } else if (CURATION_KINDS.has(entry.kind)) {
          row.host_id = rowOrigin; // curation is owned by whoever created it
          touchedOrigins.add(rowOrigin);
        } else if (entry.kind === 'event' && opts.piiFilter) {
          redactEventRow(row);
        }

        entity.upsert(this.db, row);
        applied++;
      }
    });
    tx();

    // Refresh counters for the pusher and every distinct origin the batch touched
    // (a mirror pull relays rows from many hosts). Skipped during a bulk snapshot
    // — the caller recomputes once at the end (see ApplierOptions.deferStats).
    if (!opts.deferStats) {
      touchedOrigins.add(originHostId);
      for (const origin of touchedOrigins) updateHostStats(this.db, origin);
    }
    if (applied > 0) this.emit('applied', { originHostId, entries: ordered });
    return { applied, conflicts };
  }
}

/**
 * Prepare a row for another host. With the PII filter on, an event row is redacted in full,
 * which removes the IP addresses `glove.showIpAddresses` keeps in gloved sessions: that setting
 * is host-local, and where one host's sandboxes connected never crosses hosts (the same reason
 * the network rollups are not synced). Everything else is already redacted, so it is unchanged.
 * Used by every outbound path: push, the mirror snapshot and the mirror changes feed.
 */
export function outboundRow(kind: string, row: WireRow, piiFilter: boolean): WireRow {
  if (piiFilter && kind === 'event') redactEventRow(row);
  return row;
}

/** Re-redact an event wire row's JSON blobs in place (central-side defence in depth). */
function redactEventRow(row: WireRow): void {
  if (typeof row.data_json === 'string') {
    try {
      row.data_json = JSON.stringify(filterPii(JSON.parse(row.data_json) as EventData));
    } catch {
      // leave as-is on malformed JSON
    }
  }
  if (typeof row.laymans_json === 'string') {
    row.laymans_json = redactString(row.laymans_json);
  }
}

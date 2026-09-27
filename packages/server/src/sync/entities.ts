import type { Database } from '../db/database.js';
import type { EventData } from '../events/types.js';
import { filterPii, redactString } from '../pii/filter.js';
import { type SyncKind, SYNC_KIND_ORDER, type WireRow } from './protocol.js';

/**
 * The entity registry: one `SyncEntity`
 * per kind, pure SQL over a `Database`. Adding a kind later means adding one
 * entry here and one trigger — the transport never changes. Wire rows use the
 * DB column names and pass `*_json` columns through as strings without parsing.
 */
export interface SyncEntity {
  kind: SyncKind;
  table: string;
  /** Column whose value equals the journal `entity_id` (portable id for qa). */
  idColumn: string;
  /** Load current state for the given ids (skips missing rows), as stored: for local use only. */
  load(db: Database, ids: string[]): WireRow[];
  /**
   * The readers below produce rows for another host. With `piiFilter` on, an event row is
   * redacted in full, which removes the IP addresses `glove.showIpAddresses` keeps in gloved
   * sessions: that setting is host-local, and where one host's sandboxes connected never
   * crosses hosts (the same reason the network rollups are not synced). Everything else is
   * already redacted, so it is unchanged. Redacting here, in the only readers an outbound
   * path has, is what keeps a new path from forgetting it.
   */
  /** `load`, for another host. */
  loadOutbound(db: Database, ids: string[], piiFilter: boolean): WireRow[];
  /** Page own-origin rows for backfill, keyset-ordered by `idColumn`. */
  page(db: Database, opts: { afterId?: string; limit: number; originHostId: string; piiFilter: boolean }): WireRow[];
  /** Page rows *not* owned by a host (mirror snapshot), keyset-ordered. */
  pageExcludingOrigin(db: Database, opts: { afterId?: string; limit: number; excludeHostId: string; piiFilter: boolean }): WireRow[];
  /** Idempotent upsert of a whole wire row (INSERT … ON CONFLICT DO UPDATE). */
  upsert(db: Database, row: WireRow): void;
  /** Remove by id (session cascades to its events and qa). */
  remove(db: Database, id: string): void;
  approxBytes(row: WireRow): number;
}

/** Own-origin predicate: host-column tables match directly; children join the session. */
function originPredicate(entity: { table: string }, hasHostColumn: boolean): string {
  return hasHostColumn
    ? 'host_id = ?'
    : 'session_id IN (SELECT session_id FROM recorded_sessions WHERE host_id = ?)';
}

/** The inverse: everything a host does *not* own (mirror snapshot). */
function excludeOriginPredicate(hasHostColumn: boolean): string {
  return hasHostColumn
    ? '(host_id IS NULL OR host_id != ?)'
    : 'session_id IN (SELECT session_id FROM recorded_sessions WHERE host_id IS NULL OR host_id != ?)';
}

/** Re-redact an event wire row's JSON blobs in place: outbound, and on arrival as defence in depth. */
export function redactEventRow(row: WireRow): void {
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

function makeEntity(spec: {
  kind: SyncKind;
  table: string;
  idColumn: string;
  columns: string[];
  hasHostColumn: boolean;
  cascadeSession?: boolean;
}): SyncEntity {
  const { kind, table, idColumn, columns, hasHostColumn } = spec;
  const colList = columns.join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns
    .filter((c) => c !== idColumn)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const upsertSql = updates
    ? `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
       ON CONFLICT(${idColumn}) DO UPDATE SET ${updates}`
    : `INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`;

  const outbound = (rows: WireRow[], piiFilter: boolean): WireRow[] => {
    if (piiFilter && kind === 'event') for (const row of rows) redactEventRow(row);
    return rows;
  };
  const load = (db: Database, ids: string[]): WireRow[] => {
    if (ids.length === 0) return [];
    const qs = ids.map(() => '?').join(', ');
    return db
      .prepare(`SELECT ${colList} FROM ${table} WHERE ${idColumn} IN (${qs})`)
      .all(...ids) as WireRow[];
  };

  return {
    kind,
    table,
    idColumn,
    load,
    loadOutbound(db, ids, piiFilter) {
      return outbound(load(db, ids), piiFilter);
    },
    page(db, { afterId = '', limit, originHostId, piiFilter }) {
      const pred = originPredicate({ table }, hasHostColumn);
      const rows = db
        .prepare(
          `SELECT ${colList} FROM ${table}
           WHERE ${pred} AND ${idColumn} > ?
           ORDER BY ${idColumn} ASC LIMIT ?`,
        )
        .all(originHostId, afterId, limit) as WireRow[];
      return outbound(rows, piiFilter);
    },
    pageExcludingOrigin(db, { afterId = '', limit, excludeHostId, piiFilter }) {
      const pred = excludeOriginPredicate(hasHostColumn);
      const rows = db
        .prepare(
          `SELECT ${colList} FROM ${table}
           WHERE ${pred} AND ${idColumn} > ?
           ORDER BY ${idColumn} ASC LIMIT ?`,
        )
        .all(excludeHostId, afterId, limit) as WireRow[];
      return outbound(rows, piiFilter);
    },
    upsert(db, row) {
      const values = columns.map((c) => (row[c] === undefined ? null : row[c]));
      db.prepare(upsertSql).run(...(values as unknown[]));
    },
    remove(db, id) {
      if (spec.cascadeSession) {
        const tx = db.transaction(() => {
          db.prepare('DELETE FROM recorded_qa WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM recorded_events WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM recorded_sessions WHERE session_id = ?').run(id);
        });
        tx();
      } else {
        db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).run(id);
      }
    },
    approxBytes(row) {
      return JSON.stringify(row).length;
    },
  };
}

const SESSION_COLUMNS = [
  'session_id', 'cwd', 'agent_type', 'started_at', 'last_seen',
  'session_model', 'session_model_display_name', 'session_name', 'source',
  'host_id', 'updated_at',
];
const EVENT_COLUMNS = [
  'id', 'session_id', 'type', 'timestamp', 'agent_type',
  'data_json', 'analysis_json', 'laymans_json', 'risk_level',
];
// Q&A travels keyed by its portable sync_id; the local autoincrement id is dropped.
const QA_COLUMNS = [
  'sync_id', 'event_id', 'session_id', 'question', 'answer',
  'model', 'tokens_in', 'tokens_out', 'latency_ms', 'created_at',
];
const FOLDER_COLUMNS = ['id', 'name', 'sort_order', 'created_at', 'host_id', 'updated_at'];
const BOOKMARK_COLUMNS = ['id', 'folder_id', 'session_id', 'name', 'sort_order', 'created_at', 'host_id', 'updated_at'];
const HIGHLIGHT_COLUMNS = [
  'id', 'folder_id', 'session_id', 'prompt_event_id', 'response_event_id',
  'name', 'sort_order', 'created_at', 'host_id', 'updated_at',
];

export const SYNC_ENTITIES: Record<SyncKind, SyncEntity> = {
  session: makeEntity({ kind: 'session', table: 'recorded_sessions', idColumn: 'session_id', columns: SESSION_COLUMNS, hasHostColumn: true, cascadeSession: true }),
  event: makeEntity({ kind: 'event', table: 'recorded_events', idColumn: 'id', columns: EVENT_COLUMNS, hasHostColumn: false }),
  qa: makeEntity({ kind: 'qa', table: 'recorded_qa', idColumn: 'sync_id', columns: QA_COLUMNS, hasHostColumn: false }),
  bookmark_folder: makeEntity({ kind: 'bookmark_folder', table: 'bookmark_folders', idColumn: 'id', columns: FOLDER_COLUMNS, hasHostColumn: true }),
  bookmark: makeEntity({ kind: 'bookmark', table: 'bookmarks', idColumn: 'id', columns: BOOKMARK_COLUMNS, hasHostColumn: true }),
  highlight_folder: makeEntity({ kind: 'highlight_folder', table: 'highlight_folders', idColumn: 'id', columns: FOLDER_COLUMNS, hasHostColumn: true }),
  highlight: makeEntity({ kind: 'highlight', table: 'highlights', idColumn: 'id', columns: HIGHLIGHT_COLUMNS, hasHostColumn: true }),
};

/** Entities in apply/backfill order. */
export const SYNC_ENTITIES_ORDERED: SyncEntity[] = SYNC_KIND_ORDER.map((k) => SYNC_ENTITIES[k]);

/** Curation kinds are owned by their creator and force `host_id` = pusher on ingest. */
export const CURATION_KINDS = new Set<SyncKind>(['bookmark_folder', 'bookmark', 'highlight_folder', 'highlight']);

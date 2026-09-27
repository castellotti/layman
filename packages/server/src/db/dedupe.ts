import type { Database } from './database.js';

/**
 * A one-off, opt-in cleanup for pi events recorded twice (or more) before the pi watcher learnt to
 * skip what a restart's replay had already recorded (`data.transcriptEventId`, see
 * `docs/harnesses/pi.md`). Each replay re-read a young session's transcript and recorded it again
 * under fresh random ids, so the copies differ only in `id` and the read-time `timestamp`.
 *
 * A copy is the same session, type and data (which carries the transcript's own `transcriptAt`),
 * ignoring what the watcher adds when it *reads* the event (`READ_TIME`) and `transcriptEventId`,
 * which only newer rows have. A genuine re-send of the same prompt has a different `transcriptAt`
 * and is never a copy. Rows without `transcriptAt` (pi before phase 7)
 * cannot be told from a re-send and are left alone.
 *
 * The earliest copy is kept. So is any copy a highlight or a Q&A answer points at.
 * Deletes are not journalled per event (only a session delete is), so a sync central keeps its copies.
 */

export interface DedupeRow {
  id: string;
  session_id: string;
  type: string;
  timestamp: number;
  data_json: string;
}

export interface DedupePlan {
  /** Ids to delete. */
  ids: string[];
  /** Sessions with at least one copy removed. */
  sessions: number;
}

/**
 * Set by the pi watcher at read time, so they differ between copies: a tool call's `completedAt`
 * (the transcript's own is `transcriptCompletedAt`) and the access records derived from the call
 * with that time and the event's random id.
 */
const READ_TIME = ['transcriptEventId', 'completedAt', 'fileAccess', 'urlAccess'];

function copyKey(r: DedupeRow): string | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(r.data_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof data.transcriptAt !== 'number') return null;
  for (const k of READ_TIME) delete data[k];
  return `${r.session_id}\u0000${r.type}\u0000${JSON.stringify(data)}`;
}

/** Which rows are later copies of an earlier one. Pure; `referenced` ids are never chosen. */
export function planReplayDedupe(rows: DedupeRow[], referenced: ReadonlySet<string> = new Set()): DedupePlan {
  const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const ids: string[] = [];
  const sessions = new Set<string>();
  for (const r of sorted) {
    const key = copyKey(r);
    if (key === null) continue;
    if (!seen.has(key)) {
      seen.add(key);
      continue;
    }
    if (referenced.has(r.id)) continue;
    ids.push(r.id);
    sessions.add(r.session_id);
  }
  return { ids, sessions: sessions.size };
}

export function findPiReplayDuplicates(db: Database): DedupePlan {
  const rows = db.prepare(
    `SELECT id, session_id, type, timestamp, data_json FROM recorded_events
      WHERE agent_type = 'pi' AND json_extract(data_json, '$.transcriptAt') IS NOT NULL`,
  ).all() as DedupeRow[];
  const refs = db.prepare(
    `SELECT prompt_event_id AS id FROM highlights UNION SELECT response_event_id FROM highlights
     UNION SELECT event_id FROM recorded_qa`,
  ).all() as Array<{ id: string }>;
  return planReplayDedupe(rows, new Set(refs.map((r) => r.id)));
}

export function deleteEvents(db: Database, ids: string[]): number {
  const del = db.prepare('DELETE FROM recorded_events WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    for (const id of ids) n += del.run(id).changes;
  })();
  return n;
}

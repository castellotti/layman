import type { Database } from '../db/database.js';
import type { HostStats } from './protocol.js';

/**
 * Per-host statistics maintained in `sync_hosts` (docs/planning/multi-host-sync.md
 * §3.11). Counters are cheap to keep incrementally in later phases; here we only
 * need the full recompute, used once when the local host row is created and by
 * the `POST /api/sync/hosts/recompute` route.
 *
 * `content_bytes` is content length, not on-disk pages — the UI labels it
 * "content". Events and Q&A inherit their host through the owning session.
 */
export interface HostStatsCounters {
  sessionCount: number;
  eventCount: number;
  contentBytes: number;
  firstActivity: number | null;
  lastActivity: number | null;
}

/** Recompute counters for one host from the entity tables. */
export function computeHostStats(db: Database, hostId: string): HostStatsCounters {
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS n, MIN(started_at) AS first_at, MAX(last_seen) AS last_at
       FROM recorded_sessions WHERE host_id = ?`,
    )
    .get(hostId) as { n: number; first_at: number | null; last_at: number | null };

  const events = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(
                length(re.data_json)
                + length(COALESCE(re.analysis_json, ''))
                + length(COALESCE(re.laymans_json, ''))
              ), 0) AS bytes
       FROM recorded_events re
       JOIN recorded_sessions rs ON rs.session_id = re.session_id
       WHERE rs.host_id = ?`,
    )
    .get(hostId) as { n: number; bytes: number };

  return {
    sessionCount: sessions.n,
    eventCount: events.n,
    contentBytes: events.bytes,
    firstActivity: sessions.first_at ?? null,
    lastActivity: sessions.last_at ?? null,
  };
}

/** Rebuild counters for every row in `sync_hosts` from the tables. */
export function recomputeHostStats(db: Database): void {
  const hosts = db.prepare('SELECT host_id FROM sync_hosts').all() as Array<{ host_id: string }>;
  const update = db.prepare(
    `UPDATE sync_hosts
       SET session_count = ?, event_count = ?, content_bytes = ?,
           first_activity = ?, last_activity = ?
     WHERE host_id = ?`,
  );
  const tx = db.transaction(() => {
    for (const { host_id } of hosts) {
      const c = computeHostStats(db, host_id);
      update.run(c.sessionCount, c.eventCount, c.contentBytes, c.firstActivity, c.lastActivity, host_id);
    }
  });
  tx();
}

/** Recompute and write counters for a single host (used per applied push batch). */
export function updateHostStats(db: Database, hostId: string): void {
  const c = computeHostStats(db, hostId);
  db.prepare(
    `UPDATE sync_hosts SET session_count = ?, event_count = ?, content_bytes = ?,
       first_activity = ?, last_activity = ? WHERE host_id = ?`,
  ).run(c.sessionCount, c.eventCount, c.contentBytes, c.firstActivity, c.lastActivity, hostId);
}

/**
 * Ensure a `sync_hosts` row exists for a remote peer, refreshing its descriptive
 * fields (never downgrading a 'local' row's kind). Counters are updated
 * separately by {@link updateHostStats} after a batch applies.
 */
export function upsertRemoteHost(
  db: Database,
  info: { hostId: string; name: string; platform?: string | null; laymanVersion?: string | null },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sync_hosts (host_id, name, kind, platform, layman_version, first_seen, last_seen)
     VALUES (?, ?, 'remote', ?, ?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET
       name = excluded.name,
       platform = COALESCE(excluded.platform, sync_hosts.platform),
       layman_version = COALESCE(excluded.layman_version, sync_hosts.layman_version),
       last_seen = excluded.last_seen`,
  ).run(info.hostId, info.name, info.platform ?? null, info.laymanVersion ?? null, now, now);
}

interface RawHostStats {
  host_id: string;
  name: string;
  kind: string;
  platform: string | null;
  layman_version: string | null;
  first_seen: number;
  last_seen: number;
  session_count: number;
  event_count: number;
  content_bytes: number;
  first_activity: number | null;
  last_activity: number | null;
}

/** All known hosts with their statistics, local first then by name. */
export function hostsWithStats(db: Database): HostStats[] {
  const rows = db
    .prepare(`SELECT * FROM sync_hosts ORDER BY (kind = 'local') DESC, name ASC`)
    .all() as RawHostStats[];
  return rows.map((r) => ({
    hostId: r.host_id,
    name: r.name,
    kind: r.kind,
    platform: r.platform,
    laymanVersion: r.layman_version,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    sessionCount: r.session_count,
    eventCount: r.event_count,
    contentBytes: r.content_bytes,
    firstActivity: r.first_activity,
    lastActivity: r.last_activity,
  }));
}

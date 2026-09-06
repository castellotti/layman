import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { hostname, platform } from 'os';
import type { Database } from '../db/database.js';
import type { LaymanConfig } from '../config/schema.js';
import { saveConfig } from '../config/config.js';
import { SyncState } from './state.js';
import { recomputeHostStats } from './stats.js';

export interface HostIdentity {
  hostId: string;
  hostName: string;
}

/**
 * Are we running inside a container? Docker creates `/.dockerenv`; Podman
 * creates `/run/.containerenv`. Matches the same dual check used elsewhere for
 * host-rewrite detection, so a Podman deployment behaves like a Docker one.
 */
export function detectContainer(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * Resolve this host's display name (docs/planning/multi-host-sync.md §3.2):
 *   sync.hostName if set
 *   → LAYMAN_HOST_NAME env (compose passes it; `make docker-run` sets $(hostname))
 *   → in a container, `layman-<first 8 of hostId>` (a nag-to-name placeholder)
 *   → os.hostname()
 *
 * Inside a container `os.hostname()` is the container id, so the env var and the
 * placeholder exist precisely to avoid surfacing that as the machine's name.
 */
export function defaultHostName(config: LaymanConfig, hostId: string): string {
  if (config.sync.hostName) return config.sync.hostName;
  const env = process.env.LAYMAN_HOST_NAME?.trim();
  if (env) return env;
  if (detectContainer()) return `layman-${hostId.slice(0, 8)}`;
  return hostname();
}

/** Back-fill origin/portable-id columns for rows that predate the sync migration. */
export function backfillHostColumns(db: Database, hostId: string): void {
  const tx = db.transaction(() => {
    for (const table of ['recorded_sessions', 'bookmark_folders', 'bookmarks', 'highlight_folders', 'highlights']) {
      db.prepare(`UPDATE ${table} SET host_id = ? WHERE host_id IS NULL`).run(hostId);
    }
    db.prepare(
      `UPDATE recorded_sessions SET updated_at = last_seen WHERE updated_at IS NULL`,
    ).run();
    for (const table of ['bookmark_folders', 'bookmarks', 'highlight_folders', 'highlights']) {
      db.prepare(`UPDATE ${table} SET updated_at = created_at WHERE updated_at IS NULL`).run();
    }
    // randomblob is evaluated per row, so each Q&A gets a distinct portable id.
    db.prepare(
      `UPDATE recorded_qa SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL`,
    ).run();
  });
  tx();
}

/**
 * Establish this instance's stable identity and record it in both config and the
 * database. Idempotent: a second call keeps the persisted `hostId` (which is why
 * the config deep-merge in config.ts must protect `sync.hostId`) and only
 * refreshes the derived name and the local `sync_hosts` row.
 *
 * Must run after the sync migration (so `sync_state` and the host columns exist)
 * and before any recorded-data write, so the journal triggers can read
 * `sync_state.hostId`.
 */
export function ensureHostIdentity(
  config: LaymanConfig,
  db: Database,
  laymanVersion?: string,
): HostIdentity {
  const hostId = config.sync.hostId || randomUUID();
  const hostName = defaultHostName(config, hostId);

  if (config.sync.hostId !== hostId || config.sync.hostName !== hostName) {
    config.sync.hostId = hostId;
    config.sync.hostName = hostName;
    saveConfig(config);
  }

  const state = new SyncState(db);
  state.set('hostId', hostId);

  backfillHostColumns(db, hostId);

  const now = Date.now();
  db.prepare(
    `INSERT INTO sync_hosts (host_id, name, kind, platform, layman_version, first_seen, last_seen)
     VALUES (?, ?, 'local', ?, ?, ?, ?)
     ON CONFLICT(host_id) DO UPDATE SET
       name = excluded.name, kind = 'local',
       platform = excluded.platform, layman_version = excluded.layman_version,
       last_seen = excluded.last_seen`,
  ).run(hostId, hostName, platform(), laymanVersion ?? null, now, now);

  recomputeHostStats(db);

  return { hostId, hostName };
}

/**
 * The glove network rollups in SQLite (migration 3 in
 * `db/database.ts`): `NetHistory` for `NetObs`. Per-flow rows would dwarf the
 * event tables, so only sessions and destinations are kept (`history.ts`
 * explains how the totals survive a restart without double counting).
 *
 * Written only while session recording is on, like everything Layman records,
 * and never synced to other hosts (no triggers, no SYNC_ENTITIES entry).
 */
import type { Database } from '../db/database.js';
import type { HistoryDest, HistorySession, NetHistory } from './history.js';
import type { NetState } from './types.js';
import { destKey } from './store.js';

interface SessionRow {
  token: string; env: string; session_name: string; first_seen: number; last_seen: number; watermark: number;
  bytes_up: number; bytes_down: number; flows: number; blocked_guard: number; blocked_rule: number; blocked_default: number;
  direct_flows: number; last_exit_json: string | null; last_status_json: string | null; session_json: string | null;
  carry_json: string | null; filter_since: string | null; filter_saw_dir: number;
}
interface DestRow {
  token: string; host: string; port: number; group_key: string; last_ip: string | null; scope: string | null; resolution: string | null;
  tool: string | null; first_seen: number; last_seen: number; bytes_up: number; bytes_down: number; flows: number; blocked: number;
  last_state: string | null;
}

const json = <T>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export class SqliteNetHistory implements NetHistory {
  constructor(private readonly db: Database, private readonly recording: () => boolean) {}

  enabled(): boolean {
    return this.recording();
  }

  load(): HistorySession[] {
    const sessions = this.db.prepare('SELECT * FROM net_sessions').all() as SessionRow[];
    const dests = this.db.prepare('SELECT * FROM net_destinations').all() as DestRow[];
    const byToken = new Map<string, HistoryDest[]>();
    for (const d of dests) {
      const list = byToken.get(d.token) ?? [];
      // `@service` keys (no host) are stored with the key as the host and port 0.
      const host = d.host.startsWith('@') ? null : d.host;
      list.push({
        key: destKey(host, d.port, d.host.slice(1)), host, port: host === null ? null : d.port,
        groupKey: d.group_key, lastIp: d.last_ip, scope: d.scope, resolution: d.resolution, tool: d.tool,
        firstSeen: d.first_seen, lastSeen: d.last_seen, bytesUp: d.bytes_up, bytesDown: d.bytes_down, flows: d.flows, blocked: d.blocked,
        lastState: d.last_state as NetState | null,
      });
      byToken.set(d.token, list);
    }
    return sessions.map((s) => ({
      token: s.token, filterSince: s.filter_since, filterSawDir: s.filter_saw_dir === 1, firstSeen: s.first_seen, lastSeen: s.last_seen, watermark: s.watermark,
      carry: json(s.carry_json) ?? {},
      bytesUp: s.bytes_up, bytesDown: s.bytes_down, flows: s.flows,
      blockedGuard: s.blocked_guard, blockedRule: s.blocked_rule, blockedDefault: s.blocked_default, directFlows: s.direct_flows,
      lastExit: json(s.last_exit_json), lastStatus: json(s.last_status_json), sessionFile: json(s.session_json),
      destinations: byToken.get(s.token) ?? [],
    }));
  }

  /** Replace each session's rows with its rollup, in one transaction: writing the same rollup twice changes nothing. */
  save(sessions: HistorySession[]): void {
    if (!sessions.length) return;
    const upsert = this.db.prepare(`
      INSERT INTO net_sessions (token, env, session_name, first_seen, last_seen, watermark, bytes_up, bytes_down, flows, blocked,
        blocked_guard, blocked_rule, blocked_default, direct_flows, last_exit_json, last_status_json, session_json, carry_json, filter_since, filter_saw_dir)
      VALUES (@token, @env, @name, @firstSeen, @lastSeen, @watermark, @bytesUp, @bytesDown, @flows, @blocked,
        @blockedGuard, @blockedRule, @blockedDefault, @directFlows, @lastExit, @lastStatus, @sessionFile, @carry, @filterSince, @filterSawDir)
      ON CONFLICT(token) DO UPDATE SET env = excluded.env, session_name = excluded.session_name, first_seen = excluded.first_seen,
        last_seen = excluded.last_seen, watermark = excluded.watermark, bytes_up = excluded.bytes_up, bytes_down = excluded.bytes_down,
        flows = excluded.flows, blocked = excluded.blocked, blocked_guard = excluded.blocked_guard, blocked_rule = excluded.blocked_rule,
        blocked_default = excluded.blocked_default, direct_flows = excluded.direct_flows, last_exit_json = excluded.last_exit_json,
        last_status_json = excluded.last_status_json, session_json = excluded.session_json, carry_json = excluded.carry_json,
        filter_since = excluded.filter_since, filter_saw_dir = excluded.filter_saw_dir`);
    const clear = this.db.prepare('DELETE FROM net_destinations WHERE token = ?');
    const insert = this.db.prepare(`
      INSERT INTO net_destinations (token, host, port, group_key, last_ip, scope, resolution, tool, first_seen, last_seen,
        bytes_up, bytes_down, flows, blocked, last_state)
      VALUES (@token, @host, @port, @groupKey, @lastIp, @scope, @resolution, @tool, @firstSeen, @lastSeen,
        @bytesUp, @bytesDown, @flows, @blocked, @lastState)`);
    this.db.transaction(() => {
      for (const s of sessions) {
        upsert.run({
          // `env` and `session_name` predate glove v3, where both are the session id.
          token: s.token, env: s.token, name: s.token, firstSeen: Math.round(s.firstSeen), lastSeen: Math.round(s.lastSeen),
          watermark: Math.round(s.watermark), bytesUp: s.bytesUp, bytesDown: s.bytesDown, flows: s.flows,
          blocked: s.blockedGuard + s.blockedRule + s.blockedDefault, blockedGuard: s.blockedGuard, blockedRule: s.blockedRule,
          blockedDefault: s.blockedDefault, directFlows: s.directFlows,
          lastExit: s.lastExit ? JSON.stringify(s.lastExit) : null, lastStatus: s.lastStatus ? JSON.stringify(s.lastStatus) : null,
          sessionFile: s.sessionFile ? JSON.stringify(s.sessionFile) : null,
          carry: JSON.stringify(s.carry), filterSince: s.filterSince, filterSawDir: s.filterSawDir ? 1 : 0,
        });
        clear.run(s.token);
        for (const d of s.destinations) {
          const noHost = d.host === null;
          insert.run({
            token: s.token, host: noHost ? d.key : d.host, port: noHost ? 0 : d.port ?? 0, groupKey: d.groupKey, lastIp: d.lastIp,
            scope: d.scope, resolution: d.resolution, tool: d.tool, firstSeen: Math.round(d.firstSeen), lastSeen: Math.round(d.lastSeen),
            bytesUp: d.bytesUp, bytesDown: d.bytesDown, flows: d.flows, blocked: d.blocked, lastState: d.lastState,
          });
        }
      }
    })();
  }
}

import { describe, expect, it } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { applyMigrations } from '../db/database.js';
import type { HistorySession } from './history.js';
import { SqliteNetHistory } from './persist.js';

function db() {
  const d = new BetterSqlite3(':memory:');
  applyMigrations(d);
  return d;
}

const session = (over: Partial<HistorySession> = {}): HistorySession => ({
  token: 'pi-search-0f1a2b', filterSince: '2026-10-01T12:00:00Z', filterSawDir: true, firstSeen: 1000, lastSeen: 9000, watermark: 9000,
  carry: { f1: { key: 'arxiv.org:443', up: 10, down: 200, blocked: null, direct: false } },
  bytesUp: 100, bytesDown: 5000, flows: 3, blockedGuard: 1, blockedRule: 1, blockedDefault: 0, directFlows: 0,
  lastExit: null, lastStatus: null, sessionFile: null,
  destinations: [
    { key: 'arxiv.org:443', host: 'arxiv.org', port: 443, groupKey: 'arxiv.org', lastIp: '151.101.3.42', scope: 'tunnelled', resolution: 'in-tunnel',
      tool: 'web_fetch', firstSeen: 1000, lastSeen: 9000, bytesUp: 90, bytesDown: 4800, flows: 2, blocked: 0, lastState: 'finished', hop: false },
    { key: '@proxy', host: null, port: null, groupKey: '@proxy', lastIp: null, scope: 'local', resolution: 'disabled',
      tool: 'web_fetch', firstSeen: 2000, lastSeen: 2000, bytesUp: 10, bytesDown: 200, flows: 1, blocked: 1, lastState: 'guard', hop: true },
  ],
  ...over,
});

describe('SqliteNetHistory', () => {
  it('round-trips a session and its destinations, including one with no host', () => {
    const h = new SqliteNetHistory(db(), () => true);
    h.save([session()]);
    expect(h.load()).toEqual([session()]);
  });

  it('writing the same rollup twice changes nothing, and a later one replaces the destinations', () => {
    const d = db();
    const h = new SqliteNetHistory(d, () => true);
    h.save([session()]);
    h.save([session()]);
    expect((d.prepare('SELECT COUNT(*) AS n FROM net_destinations').get() as { n: number }).n).toBe(2);
    h.save([session({ bytesDown: 6000, destinations: [session().destinations[0]] })]);
    const [back] = h.load();
    expect([back.bytesDown, back.destinations.map((x) => x.key)]).toEqual([6000, ['arxiv.org:443']]);
  });

  it('reloads a host with capitals under the same lower-cased key the live store uses', () => {
    const h = new SqliteNetHistory(db(), () => true);
    const dest = { ...session().destinations[0], key: 'api.example.com:443', host: 'API.Example.com', groupKey: 'example.com' };
    h.save([session({ destinations: [dest] })]);
    expect(h.load()[0].destinations[0].key).toBe('api.example.com:443');
  });

  it('says whether it may write from the recording setting', () => {
    let on = false;
    const h = new SqliteNetHistory(db(), () => on);
    expect(h.enabled()).toBe(false);
    on = true;
    expect(h.enabled()).toBe(true);
  });

  it('keeps hours and runs as upserts, and tells a row kept before them apart from one with no traffic', () => {
    const d = db();
    const h = new SqliteNetHistory(d, () => true);
    const hour = { hour: 3_600_000, run: 'g_1' as string | null, key: 'arxiv.org:443', tool: 'web_fetch' as string | null, hop: false, bytesUp: 5, bytesDown: 50, flows: 1, blocked: 0, blockedGuard: 0, blockedRule: 0, direct: 0, first: 3_600_100, last: 3_600_900 };
    const run = { run: 'g_1', started: 1000, ended: null as number | null, inferred: false };
    h.save([session({ hours: [hour], runs: [run] })]);
    // A later save with only the hour that changed leaves the others, and updates the run.
    const next = { ...hour, hour: 7_200_000, first: 7_200_100, last: 7_200_100 };
    // Before any collector run (an older gate): kept as run '' in its key, read back as null.
    const older = { ...hour, run: null, tool: null, hour: 0, first: 100, last: 100 };
    // The same host in the same hour of the same run, another tool: its own row.
    const otherTool = { ...hour, tool: 'llm' };
    h.save([session({ hours: [next, older, otherTool], runs: [{ ...run, ended: 9000, inferred: true }] })]);
    const [back] = h.load();
    expect(back.hours).toEqual([older, otherTool, hour, next]);
    expect(back.runs).toEqual([{ ...run, ended: 9000, inferred: true }]);

    // A row from before migration 6 (written without hours) loads with none, so the store counts them afresh.
    const old = new SqliteNetHistory(db(), () => true);
    old.save([session()]);
    expect(old.load()[0].hours).toBeUndefined();
  });

  it('is migrations 3 to 6, and never synced: no journal triggers on its tables', () => {
    const d = db();
    expect(d.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([1, 2, 3, 4, 5, 6].map((version) => ({ version })));
    const triggers = d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'net_%'").all();
    expect(triggers).toEqual([]);
  });
});

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
  token: 'pi-search', env: 'pi-search', name: 'pi-search', firstSeen: 1000, lastSeen: 9000, watermark: 9000,
  carry: { f1: { key: 'arxiv.org:443', up: 10, down: 200, blocked: null, direct: false } },
  bytesUp: 100, bytesDown: 5000, flows: 3, blockedGuard: 1, blockedRule: 1, blockedDefault: 0, directFlows: 0,
  lastExit: null, lastStatus: null, sessionFile: null,
  destinations: [
    { key: 'arxiv.org:443', host: 'arxiv.org', port: 443, groupKey: 'arxiv.org', lastIp: '151.101.3.42', scope: 'tunnelled', resolution: 'in-tunnel',
      tool: 'web_fetch', firstSeen: 1000, lastSeen: 9000, bytesUp: 90, bytesDown: 4800, flows: 2, blocked: 0, lastState: 'finished' },
    { key: '@proxy', host: null, port: null, groupKey: '@proxy', lastIp: null, scope: 'local', resolution: 'disabled',
      tool: 'web_fetch', firstSeen: 2000, lastSeen: 2000, bytesUp: 10, bytesDown: 200, flows: 1, blocked: 1, lastState: 'guard' },
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

  it('says whether it may write from the recording setting', () => {
    let on = false;
    const h = new SqliteNetHistory(db(), () => on);
    expect(h.enabled()).toBe(false);
    on = true;
    expect(h.enabled()).toBe(true);
  });

  it('is migration 3, and never synced: no journal triggers on its tables', () => {
    const d = db();
    expect(d.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    const triggers = d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'net_%'").all();
    expect(triggers).toEqual([]);
  });
});

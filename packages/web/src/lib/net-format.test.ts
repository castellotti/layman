import { describe, expect, it } from 'vitest';
import { formatAge, formatBytes, gateChips } from './net-format.js';
import type { NetSessionData } from './net-state.js';
import type { NetGateView } from './netobs-types.js';
import { gate } from './net-test-fixtures.js';

const data = (g: Partial<NetGateView> = {}, over: Partial<NetSessionData> = {}): NetSessionData => ({
  token: 'pi-search', env: 'pi-search', name: 'pi-search', session: null, gate: gate(g),
  exit: { v: 1, type: 'exit', t: 't', env: 'e', session: 'e', kind: 'vpn', ip: '195.177.93.17', country: 'Switzerland', city: null, lat: 47.36, lon: 8.54, source: 'via-proxy:am.i.mullvad.net', healthy: true },
  exits: [],
  rules: { path: '/r', displayPath: '/r', exists: true, file: { v: 1, env: 'e', session: 'e', default: 'allow', rules: [] }, readError: null, mtimeMs: 1 },
  destinations: new Map(), flows: new Map(), buckets: new Map(),
  totals: { bytesUp: 0, bytesDown: 0, flows: 0, openFlows: 0, destinations: 0, blocked: { guard: 0, userRule: 0, default: 0 }, directFlows: 0, broken: 0 },
  counters: { records: 0, invalid: 0, skipped: 0, gaps: 0 }, emptyFolded: 0, historyTruncated: false,
  ...over,
});
const labels = (d: NetSessionData) => gateChips(d).map((c) => c.label);
const chip = (d: NetSessionData, key: string) => gateChips(d).find((c) => c.key === key);

describe('formatBytes / formatAge', () => {
  it.each([[0, '0 B'], [999, '999 B'], [14_357, '14.4 KB'], [1_475_671, '1.48 MB'], [229_454, '229 KB'], [2_000_000_000, '2 GB']])(
    '%d → %s', (n, s) => expect(formatBytes(n)).toBe(s));
  it('ages', () => {
    expect(formatAge(2_000)).toBe('2 s');
    expect(formatAge(90_000)).toBe('2 min');
    expect(formatAge(null)).toBe('unknown');
  });
});

describe('gateChips', () => {
  it('matches the mockup for the fixture session', () => {
    expect(labels(data())).toEqual([
      'Gate running', 'VPN · exit verified · Switzerland', 'Resolver in-tunnel', '1 rule enforced', 'Record: metadata',
    ]);
    expect(chip(data(), 'route')!.title).toContain('via-proxy:am.i.mullvad.net');
    expect(chip(data(), 'route')!.title).toContain('not looked up by Layman');
  });

  it('puts the untunnelled alarm straight after the gate chip', () => {
    const l = labels(data({}, { totals: { ...data().totals, directFlows: 1 } }));
    expect(l[1]).toBe('1 UNTUNNELLED FLOW');
    expect(chip(data({}, { totals: { ...data().totals, directFlows: 2 } }), 'direct')!.tone).toBe('error');
  });

  it('says the data stopped, not the traffic, when the gate is stale', () => {
    const c = chip(data({ freshness: 'stale', heartbeatAgeMs: 45_000 }), 'gate')!;
    expect(c.label).toBe('Gate stale · data stopped updating');
    expect(c.title).toContain('not the same as the traffic stopping');
  });

  it('declared vs verified vs exit identity off', () => {
    expect(chip(data({ route: { kind: 'vpn', verified: false, exitIdentityOff: false, upstreamHealthy: true } }, { exit: null }), 'route')!)
      .toMatchObject({ label: 'VPN · declared, not verified', tone: 'warn' });
    expect(chip(data({ route: { kind: 'tor', verified: false, exitIdentityOff: true, upstreamHealthy: null } }, { exit: null }), 'route')!)
      .toMatchObject({ label: 'Tor · declared', tone: 'neutral' });
    expect(chip(data({ route: { kind: 'direct', verified: false, exitIdentityOff: false, upstreamHealthy: true } }), 'route')!)
      .toMatchObject({ tone: 'error' });
  });

  it('resolver down, rules rejected, record full', () => {
    expect(chip(data({ resolver: { mode: 'in-tunnel', healthy: false, name: null } }), 'resolver')!.label).toBe('Resolver down');
    const rejected = chip(data({ rules: { loaded_at: null, source_mtime: null, ok: false, error: 'rules[1].match: unknown keys', active_count: 1 } }), 'rules')!;
    expect(rejected).toMatchObject({ label: 'Rules rejected', tone: 'error' });
    expect(rejected.title).toContain('still enforcing the previous 1 rule');
    expect(chip(data({ record: 'full' }), 'record')!).toMatchObject({ label: 'Record: full', tone: 'violet' });
  });

  it('flags an incomplete view, and only then', () => {
    expect(chip(data(), 'incomplete')).toBeUndefined();
    expect(chip(data({ telemetry: { written: 9, dropped: 12, invalid: 0, rotations: 0 } }), 'incomplete')!.title).toContain('dropped 12 records');
    expect(chip(data({}, { counters: { records: 0, invalid: 0, skipped: 0, gaps: 1 } }), 'incomplete')).toBeDefined();
    expect(chip(data({}, { historyTruncated: true }), 'incomplete')).toBeDefined();
  });
});

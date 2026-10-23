import { describe, expect, it } from 'vitest';
import { formatAge, formatBytes, gateChips, type GateChip } from './net-format.js';
import type { NetSessionData } from './net-state.js';
import { rulesView, sessionData } from './net-test-fixtures.js';

const data = sessionData;
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

/** Everything a chip's tip says, heading to facts. */
const tipText = (c: GateChip) => [c.tip.heading, c.tip.body, ...(c.tip.facts ?? [])].filter(Boolean).join(' ');

describe('gateChips', () => {
  it('explains the chips a newcomer cannot read, in plain words', () => {
    const none = data({ rules: { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0, sha256: null, last_rejected: null } });
    expect(chip(none, 'rules')!.label).toBe('No rules');
    expect(tipText(chip(none, 'rules')!)).toMatch(/haven’t added any rules.*guard still refuses private addresses and cloud metadata/);
    expect(tipText(chip(data(), 'record')!)).toMatch(/who connected to what, when, and how many bytes: not URLs/);
    expect(tipText(chip(data(), 'resolver')!)).toMatch(/inside the tunnel, so your own DNS provider never sees/);
    // Every chip has a heading and a sentence.
    for (const c of gateChips(data())) expect([c.key, !!c.tip.heading, c.tip.body.length > 20]).toEqual([c.key, true, true]);
  });

  it('says only "History only" for a session whose files are gone: its gate and route are not current', () => {
    const chips = gateChips(sessionData({}, { historyOnly: true }));
    expect(chips.map((c) => [c.key, c.label, c.tone])).toEqual([['history', 'History only', 'muted']]);
  });

  it('matches the design for the fixture session', () => {
    expect(labels(data())).toEqual([
      'Gate running', 'VPN · exit verified · Switzerland', 'Resolver in-tunnel', '1 rule enforced', 'Record: metadata',
    ]);
    expect(tipText(chip(data(), 'route')!)).toContain('via-proxy:am.i.mullvad.net');
    expect(tipText(chip(data(), 'route')!)).toContain('not looked up by Layman');
  });

  it('states only the default the gate enforces, and does not describe what it does not know', () => {
    const noRules = { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0, sha256: null, last_rejected: null };
    const enforced = (def: 'allow' | 'block' | null) => data({ rules: noRules }, {
      rules: rulesView({ enforced: def ? { v: 1, env: 'e', session: 'e', default: def, rules: [] } : null, file: { v: 1, env: 'e', session: 'e', default: 'allow', rules: [] } }),
    });
    expect(tipText(chip(enforced('block'), 'rules')!)).toMatch(/everything else is blocked/);
    // Layman's file says allow, but nothing says what the gate enforces: no default is claimed.
    expect(tipText(chip(enforced(null), 'rules')!)).not.toMatch(/everything else/);
    // A record mode this Layman does not know is reported as glove's word, not as metadata.
    expect(tipText(chip(data({ record: 'sampled' }), 'record')!)).toMatch(/“sampled”, which this version of Layman does not describe/);
    // Not running is not necessarily glove down: glove's own word is in the facts.
    const notRunning = chip(data({ freshness: 'stopped', state: 'error' }), 'gate')!;
    expect([notRunning.tip.heading, tipText(notRunning)]).toEqual(['The gate is not running', expect.stringContaining('glove reported “error”')]);
  });

  it('says when the gate and the route last changed, and says "at least" when Layman did not see it', () => {
    const t = new Date(2026, 9, 21, 0, 27, 3).getTime();
    const d = data({ since: { gate: { t, exact: true }, route: { t: t + 6000, exact: true }, exit: { t: t + 6000, exact: false }, resolver: null } });
    const now = t + 5 * 3_600_000;
    const chips = gateChips(d, now);
    const facts = (k: string) => chips.find((c) => c.key === k)!.tip.facts ?? [];
    expect(facts('gate')[0]).toBe('Running since Oct 21 00:27:03 (5 h ago)');
    expect(facts('route')).toContain('Verified since Oct 21 00:27:09 (5 h ago)');
    expect(facts('route')).toContain('This exit at least since Oct 21 00:27:09 (5 h ago)');
    // Nothing says when the resolver changed: no fact, rather than a guess.
    expect(facts('resolver').some((f) => /since/.test(f))).toBe(false);
  });

  it('names a corporate route as allowlist-only, with no exit to verify', () => {
    const c = chip(data({ route: { kind: 'corporate', verified: false, exitIdentityOff: true, upstreamHealthy: null } }), 'route')!;
    expect([c.label, c.tone]).toEqual(['Corporate route · allowlist only', 'neutral']);
    expect(tipText(c)).toMatch(/cannot allow more/);
  });

  it('puts the untunnelled alarm straight after the gate chip', () => {
    const l = labels(data({}, { totals: { ...data().totals, directFlows: 1 } }));
    expect(l[1]).toBe('1 UNTUNNELLED FLOW');
    expect(chip(data({}, { totals: { ...data().totals, directFlows: 2 } }), 'direct')!.tone).toBe('error');
  });

  it('says the data stopped, not the traffic, when the gate is stale', () => {
    const c = chip(data({ freshness: 'stale', heartbeatAgeMs: 45_000 }), 'gate')!;
    expect(c.label).toBe('Gate stale · data stopped updating');
    expect(tipText(c)).toContain('not the same as the traffic stopping');
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
    const rejected = chip(data({ rules: { loaded_at: null, source_mtime: null, ok: false, error: 'rules[1].match: unknown keys', active_count: 1, sha256: null, last_rejected: null } }), 'rules')!;
    expect(rejected).toMatchObject({ label: 'Rules rejected', tone: 'error' });
    expect(tipText(rejected)).toContain('still enforcing the previous 1 rule');
    expect(chip(data({ record: 'full' }), 'record')!).toMatchObject({ label: 'Record: full', tone: 'violet' });
  });

  it('says when all traffic is cut, straight after the gate state', () => {
    expect(chip(data(), 'cut')).toBeUndefined();
    const cut = data({}, { rules: rulesView({ file: { v: 1, env: 'e', session: 'e', default: 'block', rules: [
      { id: 'r_layman_cut_X_0', action: 'allow', match: { service: 'llm' } },
      { id: 'r_layman_cut_X_1', action: 'block', match: { scope: 'tunnelled' }, terminate: true },
    ] } }) });
    expect(labels(cut).slice(0, 2)).toEqual(['Gate running', 'ALL TRAFFIC CUT']);
    expect(tipText(chip(cut, 'cut')!)).toContain('except the agent’s model (LLM) link');
  });

  it('flags an incomplete view, and only then', () => {
    expect(chip(data(), 'incomplete')).toBeUndefined();
    expect(tipText(chip(data({ telemetry: { written: 9, dropped: 12, invalid: 0, rotations: 0 } }), 'incomplete')!)).toContain('dropped 12 records');
    expect(chip(data({}, { counters: { records: 0, invalid: 0, skipped: 0, gaps: 1 } }), 'incomplete')).toBeDefined();
    expect(chip(data({}, { historyTruncated: true }), 'incomplete')).toBeDefined();
  });
});

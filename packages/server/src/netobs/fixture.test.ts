/**
 * Cross-repo contract test: glove's own fixture (produced by its real gate
 * code), read through discovery → tail → store exactly as a live session is.
 * Facts asserted here are glove's handoff Appendix A / §6.1.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NetObs } from './index.js';
import type { DestinationAggregate, FlowView, NetSnapshot } from './types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const GLOVE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../glove/tests/fixtures/netobs');
const TOKEN = 'pi-search';
const STATUS_T = Date.parse('2026-09-23T14:14:47.625Z');

const FLOW_LINES = readFileSync(join(FIXTURE, 'flows.ndjson'), 'utf8').split('\n').filter(Boolean);

let home: string;

/** A fake `~/.glove` holding the fixture as `envs/pi-search/sessions/pi-search/net/`. */
function makeGloveHome(flowLines = FLOW_LINES): string {
  const net = join(home, 'envs', TOKEN, 'sessions', TOKEN, 'net');
  mkdirSync(net, { recursive: true });
  for (const f of ['session.json', 'status.json', 'exit.ndjson']) copyFileSync(join(FIXTURE, f), join(net, f));
  writeFileSync(join(net, 'flows.ndjson'), flowLines.map((l) => l + '\n').join(''));
  const control = join(home, 'control', TOKEN, TOKEN);
  mkdirSync(control, { recursive: true });
  copyFileSync(join(FIXTURE, 'rules.json'), join(control, 'rules.json'));
  return join(home, 'envs');
}

function load(now = STATUS_T + 1_000, flowLines = FLOW_LINES): NetSnapshot {
  const sessionsDir = makeGloveHome(flowLines);
  const obs = new NetObs({ getSessionsDir: () => sessionsDir });
  obs.poll(now);
  const snap = obs.store.snapshot(TOKEN);
  expect(snap).not.toBeNull();
  return snap!;
}

const byHost = (snap: NetSnapshot, host: string | null): FlowView[] =>
  snap.flows.filter((f) => f.dest.host === host);
const dest = (snap: NetSnapshot, key: string): DestinationAggregate => {
  const d = snap.destinations.find((x) => x.key === key);
  expect(d, key).toBeDefined();
  return d!;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'netobs-fixture-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('glove netobs fixture', () => {
  it('discovers the session under its token and reads every record', () => {
    const snap = load();
    expect(snap.token).toBe(TOKEN);
    expect(snap.env).toBe(TOKEN);
    expect(snap.name).toBe(TOKEN);
    expect(new Set(snap.flows.map((f) => f.id)).size).toBe(15);
    expect(snap.totals.flows).toBe(15);
    expect(snap.counters).toEqual({ records: 84, invalid: 0, skipped: 0, gaps: 0 }); // 83 flow + 1 exit
    expect(snap.historyTruncated).toBe(false);
  });

  it('totals match Appendix A: 14,357 B sent, 1,475,671 B received', () => {
    const snap = load();
    expect(snap.totals.bytesUp).toBe(14_357);
    expect(snap.totals.bytesDown).toBe(1_475_671);
    // Every byte lands in exactly one destination: nothing is folded in this fixture.
    const sum = snap.destinations.reduce((a, d) => [a[0] + d.bytesUp, a[1] + d.bytesDown], [0, 0]);
    expect(sum).toEqual([14_357, 1_475_671]);
    expect(snap.emptyFolded).toBe(0);
  });

  it('aggregates per destination, with both arxiv flows under one host', () => {
    const snap = load();
    expect(snap.destinations).toHaveLength(14);
    const arxiv = dest(snap, 'arxiv.org:443');
    expect(arxiv.flows).toBe(2);
    expect([arxiv.bytesUp, arxiv.bytesDown]).toEqual([1571 + 1550, 163_879 + 65_575]);
    expect(arxiv.ips).toEqual(['151.101.3.42']);
    const wiki = dest(snap, 'en.wikipedia.org:443');
    expect([wiki.bytesUp, wiki.bytesDown]).toEqual([1592, 163_879]);
    expect(wiki.groupKey).toBe('wikipedia.org');
    expect(dest(snap, 'www.nature.com:443').groupKey).toBe('nature.com');
    expect(dest(snap, 'llm.operator.lan:8080').groupKey).toBe('llm.operator.lan');
    expect(dest(snap, 'gluetun:8000').groupKey).toBe('gluetun');
    expect(dest(snap, '169.254.169.254:80').groupKey).toBe('169.254.169.254');
  });

  it('classifies every fixture state in handoff §6.1', () => {
    const snap = load();
    const one = (host: string | null) => {
      const fs = byHost(snap, host);
      expect(fs, String(host)).toHaveLength(1);
      return fs[0];
    };
    // Finished normally, tunnelled
    expect(one('en.wikipedia.org')).toMatchObject({ state: 'finished', flags: { scope: 'tunnelled', unresolved: false } });
    // Cut by gate shutdown (the second arxiv flow)
    const arxiv = byHost(snap, 'arxiv.org').map((f) => f.state).sort();
    expect(arxiv).toEqual(['finished', 'gate_shutdown']);
    // Local link: never mapped, so never "unresolved" either
    expect(one('llm.operator.lan')).toMatchObject({ state: 'finished', flags: { scope: 'local', unresolved: false } });
    // Tunnel/upstream failure + unresolved destination
    expect(one('duckduckgo.com')).toMatchObject({ state: 'broken', flags: { unresolved: true } });
    // Cleartext HTTP
    expect(one('example.org')).toMatchObject({ state: 'finished', flags: { cleartext: true } });
    // Refused by glove's guard, including the malformed request with no host
    expect(one('169.254.169.254')).toMatchObject({ state: 'guard', rule: 'builtin:ssrf-guard' });
    expect(one('gluetun')).toMatchObject({ state: 'guard', rule: 'builtin:ssrf-guard' });
    expect(one(null)).toMatchObject({ state: 'guard', rule: 'builtin:malformed-request', flags: { noHost: true } });
    // Blocked by a user rule
    expect(one('ads.tracker.example')).toMatchObject({ state: 'user_rule', rule: 'r_01M3FIXTUREADSBLOCK00000000' });
    // SearXNG fan-out
    for (const h of ['html.duckduckgo.com', 'search.brave.com', 'www.mojeek.com', 'api.qwant.com']) {
      expect(one(h)).toMatchObject({ state: 'finished', flags: { fanout: true, scope: 'tunnelled' } });
    }
    expect(snap.totals.blocked).toEqual({ guard: 3, userRule: 1, default: 0 });
    expect(snap.totals.broken).toBe(1);
    expect(snap.totals.directFlows).toBe(0);
  });

  it('renders a null-host flow as its service endpoint from session.json', () => {
    const snap = load();
    const d = dest(snap, '@proxy');
    expect(d.host).toBeNull();
    expect(d.endpoint).toBe('glove-pi-search-proxy:8888');
    expect(d.state).toBe('guard');
  });

  it('an open flow is live: stop the file before arxiv flow 2 closes', () => {
    const id = 'f_01M379WXCQWJBBQKXQKNJS4JWE';
    const closeAt = FLOW_LINES.findIndex((l) => l.includes(id) && l.includes('"phase":"close"'));
    expect(closeAt).toBeGreaterThan(0);
    const partial = FLOW_LINES.slice(0, closeAt);
    const lastT = Date.parse(JSON.parse(partial[partial.length - 1]).t);
    const snap = load(lastT, partial);
    const flow = snap.flows.find((f) => f.id === id)!;
    expect(flow.phase).not.toBe('close');
    expect(flow.state).toBe('active');
    expect(dest(snap, 'arxiv.org:443').state).toBe('active');
    expect(snap.totals.openFlows).toBeGreaterThanOrEqual(1);
    // …and it becomes "pooled, idle" once no bytes have moved for over 3 s.
    const later = load(lastT + 3_500, partial);
    expect(later.flows.find((f) => f.id === id)!.state).toBe('pooled');
  });

  it('reads the gate: running, exit observed, unwatched browser service', () => {
    const snap = load();
    expect(snap.gate.freshness).toBe('running');
    expect(snap.gate.route).toMatchObject({ kind: 'vpn', verified: true, exitIdentityOff: false });
    expect(snap.gate.resolver).toMatchObject({ mode: 'in-tunnel', healthy: true, name: 'dns://gluetun:53' });
    expect(snap.gate.rules).toMatchObject({ ok: true, active_count: 1 });
    expect(snap.gate.record).toBe('metadata');
    expect(snap.gate.telemetry).toMatchObject({ written: 83, dropped: 0 });
    expect(snap.gate.unwatchedServices).toEqual(['browser']);
    expect(snap.exit).toMatchObject({ country: 'Switzerland', city: null, ip: '195.177.93.17', healthy: true });
    expect(snap.exit!.source).toBe('via-proxy:am.i.mullvad.net');
    expect(snap.session!.services.map((s) => s.service)).toEqual(['llm', 'search', 'proxy', 'fanout', 'browser']);
  });

  it('goes stale 20 s after the last heartbeat', () => {
    expect(load(STATUS_T + 21_000).gate.freshness).toBe('stale');
  });

  it('reads rules.json from control/<env>/<name>/', () => {
    const snap = load();
    expect(snap.rules.exists).toBe(true);
    expect(snap.rules.readError).toBeNull();
    expect(snap.rules.file).toMatchObject({ default: 'allow', rules: [{ id: 'r_01M3FIXTUREADSBLOCK00000000', note: 'ads' }] });
  });
});

describe('fixture drift guard', () => {
  const available = existsSync(GLOVE_FIXTURE);
  it.skipIf(!available)('the copy is byte-identical to ../glove/tests/fixtures/netobs', () => {
    const theirs = readdirSync(GLOVE_FIXTURE).filter((f) => !f.startsWith('.') && f !== '__pycache__').sort();
    const ours = readdirSync(FIXTURE).filter((f) => f !== 'README.md').sort();
    expect(ours).toEqual(theirs);
    for (const f of theirs) {
      expect(readFileSync(join(FIXTURE, f)).equals(readFileSync(join(GLOVE_FIXTURE, f))), f).toBe(true);
    }
  });
});

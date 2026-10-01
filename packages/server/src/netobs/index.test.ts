import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { COALESCE_MS, NetObs, type NetServerMessage, type NetSocket } from './index.js';
import { NetStore } from './store.js';
import { addGloveSession } from './testing/glove-home.js';
import { GUARD_RULE, parseRulesBytes } from './rules.js';
import type { NetSessionLocation } from './discovery.js';
import type { FlowRecord, GateRecord, NetSessionFile } from './types.js';

const T0 = Date.parse('2026-09-23T14:00:00.000Z');

function rec(id: string, phase: FlowRecord['phase'], dt: number, over: Partial<FlowRecord> = {}): FlowRecord {
  const t = new Date(T0 + dt).toISOString();
  return {
    v: 1, type: 'flow', phase, id, env: 'e', session: 'e', t, t_open: new Date(T0).toISOString(),
    t_close: phase === 'close' ? t : null, service: 'proxy', tool: 'web_fetch', client: 'harness',
    proto: 'http-connect', dest: { host: 'arxiv.org', port: 443, ip: '151.101.3.42', resolution: 'in-tunnel' },
    scope: 'tunnelled', route: { kind: 'vpn', upstream: null }, bytes: { up: 10 * (dt + 1), down: 100 * (dt + 1) },
    verdict: 'allow', rule: null, close_reason: phase === 'close' ? 'eof' : null, request: null, run: null, ...over,
  };
}

const loc = (token: string): NetSessionLocation => ({
  token, netDir: '/nonexistent', controlDir: '/nonexistent', rulesPath: '/nonexistent/rules.json',
});

class FakeSocket implements NetSocket {
  readyState = 1;
  sent: NetServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  of<T extends NetServerMessage['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<NetServerMessage, { type: T }>[];
  }
}

describe('NetStore', () => {
  let store: NetStore;
  beforeEach(() => {
    store = new NetStore();
    store.ensure(loc('e'));
  });

  it('counts blocked flows by the rule that blocked each, across updates', () => {
    const blocked = (id: string, rule: string | null, dt: number) => ['open', 'close'].forEach((phase, k) =>
      store.ingestFlow('e', rec(id, phase as FlowRecord['phase'], dt + k, { verdict: 'block', rule, close_reason: phase === 'close' ? 'blocked' : null })));
    blocked('f1', 'r_old', 0);
    blocked('f2', 'r_old', 10);
    blocked('f3', 'r_new', 20);
    blocked('f4', null, 30);
    const d = store.snapshot('e')!.destinations[0];
    expect([d.blocked, d.rule, d.blockedBy]).toEqual([4, null, { r_old: 2, r_new: 1, '': 1 }]);
  });

  // glove runs its guard on a proxy destination's host and in-tunnel IP before any rule,
  // so the predicted verdict must name the guard, not a user rule for the same host.
  it('predicts the built-in guard ahead of a user rule, only on an http-proxy listener', () => {
    store.setSessionFile('e', { v: 1, services: [
      { service: 'proxy', listen: null, observed: true, mode: 'http-proxy' },
      { service: 'llm', listen: null, observed: true, mode: 'tcp' },
    ] } as unknown as NetSessionFile, T0);
    const rules = { v: 1, env: 'e', session: 'e', default: 'allow', rules: ['rebind.example', 'nas.lan'].map((host, i) => (
      { id: `r_${i}`, action: 'block', match: { host } })) };
    const { set } = parseRulesBytes(Buffer.from(JSON.stringify(rules)), { env: 'e', session: 'e' });
    store.setPolicy('e', { enforced: set, written: set });
    store.ingestFlow('e', rec('f1', 'open', 0, { dest: { host: 'rebind.example', port: 443, ip: '203.0.113.7', resolution: 'in-tunnel' } }), T0);
    store.ingestFlow('e', rec('f2', 'open', 0, { service: 'llm', dest: { host: 'nas.lan', port: 8080, ip: null, resolution: 'disabled' } }), T0);
    const policy = (host: string) => store.snapshot('e')!.destinations.find((d) => d.host === host)!.policy.enforced;
    expect(policy('rebind.example')).toEqual({ action: 'block', rule: GUARD_RULE });
    expect(policy('nas.lan')).toEqual({ action: 'block', rule: 'r_1' }); // tcp listener: no guard
  });

  it('bytes are cumulative: rates are deltas, totals the latest record', () => {
    store.ingestFlow('e', rec('f1', 'open', 0, { bytes: { up: 5, down: 0 } }), T0);
    store.ingestFlow('e', rec('f1', 'update', 1000, { bytes: { up: 50, down: 500 } }), T0);
    store.ingestFlow('e', rec('f1', 'update', 2000, { bytes: { up: 60, down: 900 } }), T0);
    const snap = store.snapshot('e')!;
    expect(snap.totals).toMatchObject({ bytesUp: 60, bytesDown: 900 });
    expect(snap.buckets.map((b) => [b.up, b.down])).toEqual([[5, 0], [45, 500], [10, 400]]);
  });

  it('a dropped update costs resolution, not accuracy', () => {
    store.ingestFlow('e', rec('f1', 'open', 0, { bytes: { up: 5, down: 0 } }), T0);
    store.ingestFlow('e', rec('f1', 'close', 3000, { bytes: { up: 70, down: 950 } }), T0);
    expect(store.snapshot('e')!.totals).toMatchObject({ bytesUp: 70, bytesDown: 950 });
  });

  it('moves a flow when its dest is refined after open (rule 2)', () => {
    const configured = { host: 'searxng', port: 8080, ip: null, resolution: 'disabled' };
    const sni = { host: 'search.brave.com', port: 443, ip: '143.204.55.93', resolution: 'in-tunnel' };
    store.ingestFlow('e', rec('f1', 'open', 0, { dest: configured }), T0);
    store.takeDelta('e');
    store.ingestFlow('e', rec('f1', 'update', 1000, { dest: sni }), T0);
    const delta = store.takeDelta('e')!;
    expect(delta.removedDestinations).toEqual(['searxng:8080']);
    expect(delta.destinations.map((d) => d.key)).toEqual(['search.brave.com:443']);
    const snap = store.snapshot('e')!;
    expect(snap.destinations.map((d) => [d.key, d.bytesUp])).toEqual([['search.brave.com:443', 10_010]]); // the whole flow moved, not just the new bytes
    expect(snap.destinations[0].groupKey).toBe('brave.com');
  });

  it('folds empty connections instead of listing them as destinations (rule 6)', () => {
    const none = { host: null, port: null, ip: null, resolution: 'unavailable' };
    store.ingestFlow('e', rec('f1', 'open', 0, { dest: none, bytes: { up: 0, down: 0 } }), T0);
    expect(store.snapshot('e')!.destinations.map((d) => d.key)).toEqual(['@proxy']);
    store.ingestFlow('e', rec('f1', 'close', 1000, { dest: none, bytes: { up: 0, down: 0 }, close_reason: 'timeout' }), T0);
    const snap = store.snapshot('e')!;
    expect(snap.destinations).toEqual([]);
    expect(snap.emptyFolded).toBe(1);
    expect(snap.flows[0]).toMatchObject({ state: 'empty', destKey: null });
  });

  it('keeps totals when closed flows are evicted from memory', () => {
    const small = new NetStore({ maxClosedFlows: 2 });
    small.ensure(loc('e'));
    for (let i = 0; i < 5; i++) {
      small.ingestFlow('e', rec(`f${i}`, 'open', 0, { bytes: { up: 1, down: 1 } }), T0);
      small.ingestFlow('e', rec(`f${i}`, 'close', 1, { bytes: { up: 10, down: 100 } }), T0);
    }
    const snap = small.snapshot('e')!;
    expect(snap.flows).toHaveLength(2);
    expect(snap.totals).toMatchObject({ flows: 5, bytesUp: 50, bytesDown: 500 });
    expect(snap.destinations[0]).toMatchObject({ flows: 5, bytesUp: 50, bytesDown: 500 });
  });

  it('turns an open flow pooled on tick once it has idled 3 s', () => {
    store.ingestFlow('e', rec('f1', 'open', 0), T0);
    store.tick(T0 + 1000);
    expect(store.snapshot('e')!.flows[0].state).toBe('active');
    store.tick(T0 + 3500);
    expect(store.snapshot('e')!.flows[0].state).toBe('pooled');
    expect(store.snapshot('e')!.destinations[0].state).toBe('pooled');
  });

  describe("gate lifecycle (glove's record contract)", () => {
    const gate = (event: 'start' | 'stop', run: string, dt: number, service: string | null = 'proxy', inferred = false): GateRecord => ({
      v: 1, type: 'gate', event, role: service === null ? 'collect' : 'forward', run, service, env: 'e', session: 'e',
      t: new Date(T0 + dt).toISOString(), inferred,
    });
    const stateOf = (id: string) => store.snapshot('e')!.flows.find((f) => f.id === id)!.state;

    it('a stop for the run cuts its unclosed flows, and a later record of the run revives them', () => {
      store.ingestGate('e', gate('start', 'g_A', 0), T0);
      store.ingestFlow('e', rec('f1', 'open', 0, { run: 'g_A' }), T0);
      store.ingestGate('e', gate('stop', 'g_A', 500, 'proxy', true), T0);
      expect(stateOf('f1')).toBe('gate_lost');
      expect(store.snapshot('e')!.totals).toMatchObject({ openFlows: 0, gateLost: 1 });
      store.ingestFlow('e', rec('f1', 'update', 1000, { run: 'g_A' }), T0 + 1000);
      expect(stateOf('f1')).toBe('active');
    });

    it('a new run for the same service ends the old one (the forwarder restarted)', () => {
      store.ingestFlow('e', rec('f1', 'open', 0, { run: 'g_A' }), T0);
      store.ingestFlow('e', rec('f2', 'open', 100, { run: 'g_L', service: 'llm' }), T0);
      store.ingestGate('e', gate('start', 'g_B', 500), T0);
      expect(stateOf('f1')).toBe('gate_lost');
      expect(stateOf('f2')).toBe('active'); // another service's run is untouched
    });

    it("the collector's own stop never ends a forwarder's run, and a heartbeat start is not a restart", () => {
      store.ingestGate('e', gate('start', 'g_A', 0), T0);
      store.ingestFlow('e', rec('f1', 'open', 0, { run: 'g_A' }), T0);
      store.ingestGate('e', gate('start', 'g_A', 0), T0);
      store.ingestGate('e', gate('stop', 'g_C', 500, null), T0);
      expect(stateOf('f1')).toBe('active');
    });

    it('a late inferred stop for a crashed run does not end its restarted replacement (glove d855a1c)', () => {
      store.ingestGate('e', gate('start', 'g_A', 0), T0);
      store.ingestGate('e', gate('start', 'g_B', 100), T0);
      store.ingestFlow('e', rec('f1', 'open', 200, { run: 'g_B' }), T0);
      store.ingestGate('e', gate('stop', 'g_A', 30_000, 'proxy', true), T0);
      expect(stateOf('f1')).toBe('active');
    });

    it('matches glove: a later record of an older run makes it current again, ending the newer', () => {
      store.ingestFlow('e', rec('f1', 'open', 0, { run: 'g_A' }), T0);
      store.ingestFlow('e', rec('f2', 'open', 100, { run: 'g_B' }), T0);
      expect(stateOf('f1')).toBe('gate_lost');
      store.ingestFlow('e', rec('f1', 'update', 200, { run: 'g_A' }), T0);
      expect([stateOf('f1'), stateOf('f2')]).toEqual(['active', 'gate_lost']);
    });

    it('a flow with no run (an older gate) is never judged by it', () => {
      store.ingestFlow('e', rec('f1', 'open', 0), T0);
      store.ingestGate('e', gate('start', 'g_B', 500), T0);
      expect(stateOf('f1')).toBe('active');
    });
  });

  it('keeps a per-flow sparkline of the last 60 s', () => {
    store.ingestFlow('e', rec('f1', 'open', 0, { bytes: { up: 5, down: 0 } }), T0);
    store.ingestFlow('e', rec('f1', 'update', 1000, { bytes: { up: 50, down: 500 } }), T0);
    store.ingestFlow('e', rec('f2', 'open', 90_000, { bytes: { up: 1, down: 1 } }), T0);
    const flows = store.snapshot('e')!.flows;
    // f1's buckets fell out of the window anchored on the session's latest record.
    expect(flows.find((f) => f.id === 'f1')!.spark).toEqual([]);
    expect(flows.find((f) => f.id === 'f2')!.spark).toEqual([{ t: T0 + 90_000, up: 1, down: 1 }]);
  });

  it('passes record:full request URLs and headers through the string filter only', () => {
    const redacting = new NetStore({ stringFilter: (s) => s.replace(/token=\w+/, 'token=[REDACTED]') });
    redacting.ensure(loc('e'));
    redacting.ingestFlow('e', rec('f1', 'open', 0, {
      proto: 'http',
      request: { method: 'GET', url: 'http://x.org/?token=abc', headers: { cookie: 'token=abc' } },
    }), T0);
    const f = redacting.snapshot('e')!.flows[0];
    expect(f.request).toEqual({ method: 'GET', url: 'http://x.org/?token=[REDACTED]', headers: { cookie: 'token=[REDACTED]' } });
    expect(f.dest.host).toBe('arxiv.org'); // destinations are never filtered
  });
});

describe('NetObs sockets and coalescing', () => {
  const E = 'e-000000';
  const OTHER = 'other-000000';
  let home: string;
  let obs: NetObs;
  let net: string;

  beforeEach(() => {
    vi.useFakeTimers();
    home = mkdtempSync(join(tmpdir(), 'netobs-obs-'));
    net = addGloveSession(home, E).net;
    addGloveSession(home, OTHER);
    writeFileSync(join(net, 'flows.ndjson'), '');
    obs = new NetObs({ getGloveHome: () => home });
    obs.poll(T0);
  });
  afterEach(() => {
    obs.stop();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  it('sends only the session list on connect', () => {
    const s = new FakeSocket();
    obs.attach(s);
    expect(s.sent.map((m) => m.type)).toEqual(['net:sessions']);
    expect(s.of('net:sessions')[0].sessions.map((x) => x.token).sort()).toEqual([E, OTHER]);
  });

  it('a subscriber gets a snapshot, then one coalesced delta per burst', () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E);
    expect(s.of('net:snapshot')).toHaveLength(1);
    for (let i = 0; i < 20; i++) obs.store.ingestFlow(E, rec(`f${i}`, 'open', i * 10), T0);
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(s.of('net:delta')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(s.of('net:delta')).toHaveLength(1);
    expect(s.of('net:delta')[0].delta.flows).toHaveLength(20);
    obs.store.ingestFlow(E, rec('f0', 'update', 400), T0);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(s.of('net:delta')).toHaveLength(2);
  });

  it('sends nothing for a session nobody subscribed to', () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E);
    const before = s.sent.length;
    for (let i = 0; i < 5; i++) obs.store.ingestFlow(OTHER, rec(`g${i}`, 'open', i), T0);
    vi.advanceTimersByTime(COALESCE_MS * 4);
    expect(s.sent.length).toBe(before);
    // …and a later subscriber starts from a snapshot that already includes them.
    obs.subscribe(s, OTHER);
    expect(s.of('net:snapshot').at(-1)!.snapshot.flows).toHaveLength(5);
  });

  it('tails the live file into deltas on each poll', () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E);
    appendFileSync(join(net, 'flows.ndjson'), JSON.stringify(rec('f1', 'open', 0)) + '\n');
    obs.poll(T0);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(s.of('net:delta')[0].delta.flows.map((f) => f.id)).toEqual(['f1']);
  });

  it('a directory missing from one pass is not read again from the start when it returns', () => {
    // Exit records and the records counter are what a re-read counts twice (flows still in memory dedupe by id).
    appendFileSync(join(net, 'flows.ndjson'), JSON.stringify(rec('f1', 'close', 0)) + '\n');
    writeFileSync(join(net, 'exit.ndjson'), JSON.stringify({
      v: 1, type: 'exit', t: new Date(T0).toISOString(), env: 'e', session: 'e', kind: 'vpn', ip: null,
      country: null, city: null, lat: null, lon: null, source: 'via-proxy:x', healthy: false,
    }) + '\n');
    let listed = true;
    const flaky = new NetObs({ getGloveHome: () => (listed ? home : join(home, 'nothing')) });
    flaky.poll(T0);
    const before = flaky.store.snapshot(E)!;
    expect(before.exits).toHaveLength(1);
    listed = false;
    flaky.poll(T0);
    listed = true;
    flaky.poll(T0);
    expect(flaky.store.snapshot(E)).toEqual(before);
    flaky.stop();
  });

  it('forgets every session when glove is switched off', () => {
    let on = true;
    const toggled = new NetObs({ getGloveHome: () => (on ? home : null) });
    toggled.poll(T0);
    expect(toggled.sessions()).toHaveLength(2);
    const s = new FakeSocket();
    toggled.attach(s);
    on = false;
    toggled.poll(T0);
    expect(toggled.sessions()).toEqual([]);
    expect(s.of('net:sessions').at(-1)!.sessions).toEqual([]);
  });
});

/**
 * The rule that must not be relaxed (docs/extensions/glove.md → Network): Layman
 * never makes a network request keyed on gloved flow data. Crude by design — it
 * exists so a future "prettier label" change trips over the rule.
 */
describe('no-network guard (server netobs/)', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  // netobs/ and the glove home reader it (and GloveSource) discovers sessions with.
  const files = [
    ...readdirSync(root).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
    ...readdirSync(join(root, '..', 'glove')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join('..', 'glove', f)),
  ];
  const banned: Array<[string, RegExp]> = [
    ["import from 'dns'", /from ['"](node:)?dns(\/promises)?['"]/],
    ["import from 'net'", /from ['"](node:)?net['"]/],
    ["import from 'http'", /from ['"](node:)?https?['"]/],
    ["import from 'tls'", /from ['"](node:)?tls['"]/],
    ['fetch() to anything but /api/', /fetch\(\s*(?!['"`]\/api\/)/],
    ['new WebSocket(', /new WebSocket\(/],
    ['favicon', /favicon/i],
  ];
  it('covers every source file', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });
  it.each(files)('%s makes no network call', (file) => {
    const src = readFileSync(join(root, file), 'utf8');
    for (const [what, re] of banned) expect(re.test(src), `${file}: ${what}`).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { NetStore } from './store.js';
import { agentSegment, buildSegments, sessionHours } from './segments.js';
import type { HistoryHour, HistoryRun } from './history.js';
import type { FlowRecord, GateRecord } from './types.js';
import type { TimelineEvent } from '../events/types.js';

const H = 60 * 60_000;
const T0 = Date.parse('2026-10-17T06:00:00.000Z');
const iso = (t: number) => new Date(t).toISOString();

const run = (id: string, started: number, ended: number | null, inferred = false): HistoryRun => ({ run: id, started, ended, inferred });
const hour = (t: number, over: Partial<HistoryHour> = {}): HistoryHour => ({
  hour: Math.floor(t / H) * H, run: 'r1', key: 'api.anthropic.com:443', tool: 'llm', hop: false, bytesUp: 10, bytesDown: 100, flows: 1, blocked: 0, blockedGuard: 0, blockedRule: 0, direct: 0,
  first: t, last: t + 60_000, ...over,
});
/** The browser sidecar's background traffic, every hour: what a sandbox does between jobs. */
const background = (t: number, run = 'r1') => hour(t, { run, key: 'glove-x-pw:8931', tool: 'browser', hop: true, flows: 550 });

describe('runs', () => {
  it('names how each run ended, and where one with no stop did', () => {
    const runs = [
      run('a', T0, T0 + H), // glove down
      run('b', T0 + 2 * H, T0 + 3 * H, true), // the collector's inferred stop
      run('c', T0 + 4 * H, null), // never stopped, then another started
      run('d', T0 + 6 * H, null), // the last: running now
    ];
    const live = buildSegments('e', { hours: [], runs, live: true, agentSessions: [] });
    expect(live.runs.map((r) => [r.run, r.end, r.to])).toEqual([
      ['a', 'stopped', T0 + H], ['b', 'died', T0 + 3 * H], ['c', 'replaced', T0 + 6 * H], ['d', null, null],
    ]);
    // The gate is not running: the last run died, at its last activity.
    const dead = buildSegments('e', { hours: [hour(T0 + 7 * H, { run: 'd' })], runs, live: false, agentSessions: [] });
    expect(dead.runs.at(-1)).toMatchObject({ run: 'd', end: 'died', to: T0 + 7 * H + 60_000 });
  });
});

describe('bursts', () => {
  // The shape seen on a real session: a gate left up for three days running a daily report, with
  // the browser sidecar busy every hour in between.
  const runs = [run('r1', T0, T0 + 72 * H)];
  const daily = [
    ...[0, 1, 24, 25, 48].map((h) => hour(T0 + h * H + 5 * 60_000)),
    ...Array.from({ length: 72 }, (_, h) => background(T0 + h * H + 30 * 60_000)),
  ];

  it('splits a long run at every pause of 6 hours or more in model calls, whatever else kept going', () => {
    const s = buildSegments('e', { hours: daily, runs, live: false, agentSessions: [] });
    expect(s.burstBasis).toBe('inference');
    expect(s.bursts.map((b) => [b.from - T0, b.run, b.flows])).toEqual([
      // The sidecar's flows are hops: counted at the next leg, not here.
      [5 * 60_000, 'r1', 2], [24 * H + 5 * 60_000, 'r1', 2], [48 * H + 5 * 60_000, 'r1', 1],
    ]);
    // A burst's edges are its first and last model call, not the hours around them.
    expect(s.bursts[0].to).toBe(T0 + H + 5 * 60_000 + 60_000);
  });

  it('falls back to all traffic when no model calls were observed', () => {
    const s = buildSegments('e', { hours: daily.filter((h) => h.tool !== 'llm'), runs, live: false, agentSessions: [] });
    expect([s.burstBasis, s.bursts.length]).toEqual(['traffic', 1]);
  });

  it('takes the gap as asked', () => {
    expect(buildSegments('e', { hours: daily, runs, live: false, agentSessions: [] }, 25 * H).bursts).toHaveLength(1);
  });

  it('starts a new burst at a new run, however short the pause', () => {
    // One `glove up` ends and the next starts within the hour: each run's burst keeps its own edges.
    const two = [run('a', T0, T0 + 30 * 60_000), run('b', T0 + 31 * 60_000, null)];
    const hours = [hour(T0 + 10 * 60_000, { run: 'a' }), hour(T0 + 40 * 60_000, { run: 'b' })];
    expect(buildSegments('e', { hours, runs: two, live: true, agentSessions: [] }).bursts.map((b) => [b.run, b.from - T0]))
      .toEqual([['a', 10 * 60_000], ['b', 40 * 60_000]]);
    // Records from before any collector run (an older gate) still make bursts.
    const old = hours.map((h) => ({ ...h, run: null }));
    expect(buildSegments('e', { hours: old, runs: [], live: true, agentSessions: [] }).bursts.map((b) => b.run)).toEqual([null]);
  });

  it('leaves a hop’s bytes out of the session’s hours, but not its times', () => {
    const [h] = sessionHours([hour(T0), hour(T0 + 1000, { key: 'llm-auth:8080', hop: true, bytesUp: 999, first: T0 - 1, last: T0 + 2 * 60_000 })]);
    expect([h.bytesUp, h.first, h.last, h.flows, h.inference]).toEqual([10, T0 - 1, T0 + 2 * 60_000, 1, true]);
  });
});

describe('the store’s time axis', () => {
  const flow = (id: string, phase: FlowRecord['phase'], t: number, up: number, over: Partial<FlowRecord> = {}): FlowRecord => ({
    v: 1, type: 'flow', phase, id, env: 'e', session: 'e', t: iso(t), t_open: iso(t), t_close: phase === 'close' ? iso(t) : null,
    service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
    dest: { host: 'arxiv.org', port: 443, ip: null, resolution: 'in-tunnel' }, scope: 'tunnelled', route: { kind: 'vpn', upstream: null },
    bytes: { up, down: up * 10 }, verdict: 'allow', rule: null, close_reason: phase === 'close' ? 'eof' : null, request: null, run: null, ...over,
  });
  const collect = (event: 'start' | 'stop', id: string, t: number, inferred = false): GateRecord =>
    ({ v: 1, type: 'gate', event, role: 'collect', run: id, service: null, env: 'e', session: 'e', t: iso(t), inferred });

  it('keeps each collector run with what moved during it, and counts a heartbeat as no activity', () => {
    const s = new NetStore();
    s.ensure({ token: 'e', netDir: '', controlDir: '', rulesPath: '' });
    s.ingestGate('e', collect('start', 'g_1', T0));
    s.ingestFlow('e', flow('f1', 'open', T0 + 1000, 5), T0);
    s.ingestFlow('e', flow('f1', 'close', T0 + 2000, 8), T0);
    s.ingestGate('e', collect('stop', 'g_1', T0 + 3000));
    s.ingestGate('e', collect('start', 'g_2', T0 + 5 * H));
    s.ingestFlow('e', flow('p1', 'open', T0 + 5 * H + 1000, 3), T0);
    s.ingestFlow('e', flow('p1', 'update', T0 + 7 * H, 3), T0); // a heartbeat two hours later: nothing moved
    s.ingestGate('e', collect('stop', 'g_2', T0 + 8 * H, true));
    expect(s.gateRuns('e').map((r) => [r.run, r.started - T0, r.ended! - T0, r.inferred])).toEqual([['g_1', 0, 3000, false], ['g_2', 5 * H, 8 * H, true]]);
    expect(s.hourly('e').map((h) => [h.hour - T0, h.run, h.tool, h.bytesUp, h.flows])).toEqual([[0, 'g_1', 'web_fetch', 8, 1], [5 * H, 'g_2', 'web_fetch', 3, 1]]);
    // A run's totals are its hours'.
    const seg = buildSegments('e', { hours: s.hourly('e'), runs: s.gateRuns('e'), live: false, agentSessions: [] });
    expect(seg.runs.map((r) => [r.run, r.bytesUp, r.flows])).toEqual([['g_1', 8, 1], ['g_2', 3, 1]]);
    // Reading the same collector record again changes nothing.
    s.ingestGate('e', collect('start', 'g_1', T0));
    expect(s.gateRuns('e')).toHaveLength(2);
  });

  const store = () => {
    const s = new NetStore();
    s.ensure({ token: 'e', netDir: '', controlDir: '', rulesPath: '' });
    return s;
  };

  it('keeps traffic between runs out of either', () => {
    const s = store();
    s.ingestGate('e', collect('start', 'a', T0));
    s.ingestGate('e', collect('stop', 'a', T0 + 60_000));
    s.ingestFlow('e', flow('late', 'close', T0 + 62_000, 1), T0); // the forwarders' last word, just after the stop
    s.ingestFlow('e', flow('gap', 'close', T0 + 30 * 60_000, 1), T0); // nothing running
    s.ingestGate('e', collect('start', 'b', T0 + 40 * 60_000));
    expect(s.hourly('e').map((h) => h.run)).toEqual([null, 'a']);
  });

  it('keeps a model call in its hour when another tool uses the same host later in it', () => {
    const s = store();
    s.ingestFlow('e', flow('m', 'close', T0 + 5 * 60_000, 1, { tool: 'llm' }), T0);
    s.ingestFlow('e', flow('w', 'close', T0 + 40 * 60_000, 1), T0);
    expect(s.hourly('e').map((h) => h.tool).sort()).toEqual(['llm', 'web_fetch']);
    expect(sessionHours(s.hourly('e'))[0].inference).toBe(true);
  });

  it('re-flags the hours when session.json makes a service a hop after its flows were read', () => {
    const s = store();
    s.ingestFlow('e', flow('h', 'close', T0 + 1000, 7, { service: 'llm', tool: 'llm', dest: { host: 'glove-x-llm-auth', port: 8080, ip: null, resolution: 'disabled' } }), T0);
    s.ingestFlow('e', flow('u', 'close', T0 + 2000, 7, { service: 'llm-upstream', tool: 'llm', dest: { host: 'api.anthropic.com', port: 443, ip: null, resolution: 'in-tunnel' } }), T0);
    expect(sessionHours(s.hourly('e'))[0].bytesUp).toBe(14); // not known to be one call yet
    s.setSessionFile('e', { v: 1, services: [
      { service: 'llm', listen: null, observed: true, harness: true, next: ['llm-upstream'] },
      { service: 'llm-upstream', listen: null, observed: true, harness: false },
    ] } as never, T0);
    expect(s.snapshot('e')!.totals.bytesUp).toBe(7);
    expect(sessionHours(s.hourly('e'))[0].bytesUp).toBe(7); // once, at the provider leg, as the totals
  });
});

describe('agent sessions', () => {
  const ev = (timestamp: number, data: Record<string, unknown> = {}) => ({ id: String(timestamp), timestamp, data } as unknown as TimelineEvent);

  it('spans its events by transcript time where kept, and is exact only when both edges are', () => {
    expect(agentSegment('s1', [ev(T0 + 9000, { transcriptAt: T0 }), ev(T0 + 9500, { transcriptAt: T0 + 100, transcriptCompletedAt: T0 + 400 })], 1))
      .toEqual({ sessionId: 's1', from: T0, to: T0 + 400, turns: 1, exact: true });
    expect(agentSegment('s2', [ev(T0), ev(T0 + 50)], 1)).toMatchObject({ from: T0, to: T0 + 50, exact: false });
    // The end came from a read time: not exact, though the start was.
    expect(agentSegment('s4', [ev(T0 + 9000, { transcriptAt: T0 }), ev(T0 + 99_000)], 2)).toMatchObject({ to: T0 + 99_000, exact: false });
    expect(agentSegment('s3', [], 0)).toBeNull();
  });
});

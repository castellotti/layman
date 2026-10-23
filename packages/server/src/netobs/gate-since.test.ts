import { describe, expect, it } from 'vitest';
import { classifySession, gateSince, type SinceRecords } from './classify.js';
import { NetStore } from './store.js';
import type { ExitRecord, GateRecord, NetGateView, StatusRecord } from './types.js';

const T0 = Date.parse('2026-10-21T00:27:03.000Z');
const iso = (t: number) => new Date(t).toISOString();
const status = (t: number, over: Partial<StatusRecord> = {}): StatusRecord => ({
  v: 1, gate: '0.2.0', state: 'running', record: 'metadata', upstream: { kind: 'vpn', healthy: true },
  resolver: { mode: 'in-tunnel', healthy: true }, rules: null, t: iso(t), telemetry: null, ...over,
} as StatusRecord);
const exit = (t: number, ip: string, healthy = true): ExitRecord => ({
  v: 1, type: 'exit', t: iso(t), env: 'e', session: 'e', kind: 'vpn', ip, country: 'Switzerland', city: 'Zürich',
  lat: null, lon: null, source: 'gluetun', healthy,
} as ExitRecord);
const view = (st: StatusRecord | null, exits: ExitRecord[], now: number): NetGateView =>
  classifySession({ status: st, statusMtimeMs: null, exit: exits.at(-1) ?? null, session: null }, now);
const none = view(null, [], T0);
const run = (id: string, started: number, ended: number | null = null) => ({ id, started, ended });
type Rec = SinceRecords & { prevExitIp: string | null; prevRunId: string | null };
const rec = (over: Partial<Rec> = {}): Rec => ({ exits: [], run: null, prevExitIp: null, prevRunId: null, ...over });

/** Successive reads, each dated against the one before, as the store does. */
function reads(steps: Array<{ st: StatusRecord; exits: ExitRecord[]; run?: Rec['run']; now: number }>): NetGateView[] {
  let prev = none;
  let prevExitIp: string | null = null;
  let prevRunId: string | null = null;
  return steps.map((s) => {
    const next = view(s.st, s.exits, s.now);
    next.since = gateSince(prev, next, rec({ exits: s.exits, run: s.run ?? null, prevExitIp, prevRunId }), Date.parse(s.st.t ?? ''), s.now);
    prevExitIp = s.exits.at(-1)?.ip ?? null;
    prevRunId = s.run?.id ?? null;
    prev = next;
    return next;
  });
}

describe('gateSince', () => {
  it('after a restart, takes each part from the records, not from when Layman started', () => {
    // An unhealthy record before the healthy streak: the streak's start is known exactly.
    const exits = [exit(T0 + 1000, '1.1.1.1', false), exit(T0 + 6000, '2.2.2.2'), exit(T0 + 9000, '2.2.2.2')];
    const now = T0 + 5 * 3_600_000;
    const next = view(status(now - 1000), exits, now);
    const since = gateSince(none, next, rec({ exits, run: run('g_1', T0) }), now - 1000, now);
    expect(since.gate).toEqual({ t: T0, exact: true });
    expect(since.route).toEqual({ t: T0 + 6000, exact: true });
    expect(since.exit).toEqual({ t: T0 + 6000, exact: true });
    expect(since.resolver).toBeNull();
  });

  it('a streak reaching back to the oldest record held is "at least since": older records may be gone', () => {
    const exits = [exit(T0 + 6000, '2.2.2.2'), exit(T0 + 9000, '2.2.2.2')];
    const now = T0 + 60_000;
    const since = gateSince(none, view(status(now), exits, now), rec({ exits }), now, now);
    expect(since.route).toEqual({ t: T0 + 6000, exact: false });
    expect(since.exit).toEqual({ t: T0 + 6000, exact: false });
  });

  it('dates a change from its record when one says, the same live as after a restart', () => {
    const r = run('g_1', T0);
    const ok = [exit(T0, '2.2.2.2', false), exit(T0 + 5000, '2.2.2.2')];
    const [, , stale] = reads([
      { st: status(T0 + 1000), exits: ok.slice(0, 1), run: r, now: T0 + 1000 },
      // The exit turns healthy: verified since its record, not since Layman read it.
      { st: status(T0 + 6000), exits: ok, run: r, now: T0 + 7000 },
      // Its heartbeat stops at T0 + 6000; the clock turns it stale later: quiet since the heartbeat.
      { st: status(T0 + 6000), exits: ok, run: r, now: T0 + 40_000 },
    ]);
    expect(stale.since.route).toEqual({ t: T0 + 5000, exact: true });
    expect(stale.since.gate).toEqual({ t: T0 + 6000, exact: true });
    expect(stale.freshness).toBe('stale');
  });

  it('an upstream blip does not re-date "verified since"', () => {
    const r = run('g_1', T0);
    const ok = [exit(T0, '2.2.2.2')];
    const views = reads([
      { st: status(T0 + 1000), exits: ok, run: r, now: T0 + 1000 },
      { st: status(T0 + 2000, { upstream: { kind: 'vpn', healthy: false } } as Partial<StatusRecord>), exits: ok, run: r, now: T0 + 2000 },
      { st: status(T0 + 3000), exits: ok, run: r, now: T0 + 3000 },
    ]);
    expect(views.map((v) => v.since.route)).toEqual(Array(3).fill(views[0].since.route));
  });

  it('a new glove up is running since its own start, not the previous run’s', () => {
    const views = reads([
      { st: status(T0 + 1000), exits: [], run: run('g_1', T0), now: T0 + 1000 },
      { st: status(T0 + 9000), exits: [], run: run('g_2', T0 + 8000), now: T0 + 9000 },
    ]);
    expect(views.map((v) => v.since.gate?.t)).toEqual([T0, T0 + 8000]);
  });

  it('a new exit IP is dated from its record; a change no record dates, when Layman saw it', () => {
    const views = reads([
      { st: status(T0 + 1000), exits: [exit(T0, '2.2.2.2')], now: T0 + 1000 },
      { st: status(T0 + 3000, { resolver: { mode: 'in-tunnel', healthy: false } } as Partial<StatusRecord>), exits: [exit(T0, '2.2.2.2'), exit(T0 + 2000, '3.3.3.3')], now: T0 + 3500 },
    ]);
    expect(views[1].since.exit).toEqual({ t: T0 + 2000, exact: true });
    expect(views[1].since.resolver).toEqual({ t: T0 + 3500, exact: true });
  });
});

describe('the store keeps them', () => {
  const store = () => {
    const s = new NetStore();
    s.ensure({ token: 'e', netDir: '', controlDir: '', rulesPath: '' });
    return s;
  };
  const collect = (event: 'start' | 'stop', id: string, t: number): GateRecord =>
    ({ v: 1, type: 'gate', event, role: 'collect', run: id, service: null, env: 'e', session: 'e', t: iso(t), inferred: false });

  it('dates the gate from its run, and keeps that date while it runs', () => {
    const s = store();
    s.ingestGate('e', collect('start', 'g_1', T0), T0);
    s.ingestExit('e', exit(T0 + 3000, '2.2.2.2'), T0 + 3000);
    s.setStatus('e', status(T0 + 10_000), null, T0 + 10_000);
    expect(s.gate('e')!.since).toMatchObject({ gate: { t: T0, exact: true }, exit: { t: T0 + 3000, exact: false } });
    s.tick(T0 + 12_000);
    s.setStatus('e', status(T0 + 13_000), null, T0 + 13_000);
    expect(s.gate('e')!.since.gate).toEqual({ t: T0, exact: true });
  });

  it('a history-only session is dated from its kept run; when its files return, from the records again', () => {
    const s = new NetStore();
    s.setHistory({
      token: 'h', filterSince: null, filterSawDir: false, firstSeen: T0, lastSeen: T0, watermark: T0, carry: {},
      bytesUp: 0, bytesDown: 0, flows: 0, blockedGuard: 0, blockedRule: 0, blockedDefault: 0, directFlows: 0,
      lastExit: exit(T0 + 1000, '2.2.2.2'), lastStatus: status(T0 + 2000, { state: 'stopped' }), sessionFile: null, destinations: [],
      hours: [], runs: [{ run: 'g_1', started: T0, ended: T0 + 1500, inferred: false }],
    }, T0 + 5000);
    // Stopped since its run's stop, and only one exit kept: its time is a lower bound.
    expect(s.gate('h')!.since).toMatchObject({ gate: { t: T0 + 1500, exact: true }, exit: { t: T0 + 1000, exact: false } });
    s.relocate({ token: 'h', netDir: '/x', controlDir: '/x', rulesPath: '/x' });
    s.ingestGate('h', collect('start', 'g_2', T0 + 60_000), T0 + 99_000);
    s.setStatus('h', status(T0 + 98_000), null, T0 + 99_000);
    // Running since the new run's start record, not since Layman read it.
    expect(s.gate('h')!.since.gate).toEqual({ t: T0 + 60_000, exact: true });
  });
});

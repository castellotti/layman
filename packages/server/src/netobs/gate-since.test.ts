import { describe, expect, it } from 'vitest';
import { classifySession, gateSince } from './classify.js';
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

describe('gateSince', () => {
  it('after a restart, takes each part from the records, not from when Layman started', () => {
    const exits = [exit(T0 + 1000, '1.1.1.1', false), exit(T0 + 6000, '2.2.2.2'), exit(T0 + 9000, '2.2.2.2')];
    const now = T0 + 5 * 3_600_000;
    const next = view(status(now - 1000), exits, now);
    const since = gateSince(none, next, { exits, run: { started: T0, ended: null }, prevExitIp: null }, now - 1000, now);
    expect(since.gate).toEqual({ t: T0, exact: true }); // running since its run started
    expect(since.route).toEqual({ t: T0 + 6000, exact: true }); // verified since the healthy streak began
    expect(since.exit).toEqual({ t: T0 + 6000, exact: true }); // this IP since its first record in a row
    expect(since.resolver).toBeNull(); // nothing says: the tip leaves it out
  });

  it('a stale gate is stale since its last heartbeat; a stopped one since its run stopped', () => {
    const now = T0 + 60_000;
    const stale = view(status(T0), [], now);
    expect(gateSince(none, stale, { exits: [], run: null, prevExitIp: null }, T0, now).gate).toEqual({ t: T0, exact: true });
    const stopped = view(status(T0, { state: 'stopped' }), [], now);
    expect(gateSince(none, stopped, { exits: [], run: { started: T0 - 9000, ended: T0 - 10 }, prevExitIp: null }, T0, now).gate)
      .toEqual({ t: T0 - 10, exact: true });
  });

  it('a change Layman sees happen is dated when it saw it, and an unchanged part keeps its date', () => {
    const exits = [exit(T0, '2.2.2.2')];
    const first = view(status(T0), exits, T0);
    first.since = gateSince(none, first, { exits, run: { started: T0 - 5000, ended: null }, prevExitIp: null }, T0, T0);
    // A second later nothing changed: every date stays.
    const same = view(status(T0 + 1000), exits, T0 + 1000);
    const kept = gateSince(first, same, { exits, run: { started: T0 - 5000, ended: null }, prevExitIp: '2.2.2.2' }, T0 + 1000, T0 + 1000);
    expect(kept).toEqual(first.since);
    same.since = kept;
    // Then the exit moves to a new IP and the upstream fails.
    const moved = [...exits, exit(T0 + 2000, '3.3.3.3')];
    const later = view(status(T0 + 2000, { upstream: { kind: 'vpn', healthy: false } } as Partial<StatusRecord>), moved, T0 + 2500);
    const changed = gateSince(same, later, { exits: moved, run: null, prevExitIp: '2.2.2.2' }, T0 + 2000, T0 + 2500);
    expect(changed.exit).toEqual({ t: T0 + 2500, exact: true });
    expect(changed.route).toEqual({ t: T0 + 2500, exact: true });
    expect(changed.gate).toEqual(first.since.gate);
  });
});

describe('the store keeps them', () => {
  it('dates the gate from its run, and keeps that date while it runs', () => {
    const s = new NetStore();
    s.ensure({ token: 'e', netDir: '', controlDir: '', rulesPath: '' });
    const start: GateRecord = { v: 1, type: 'gate', event: 'start', role: 'collect', run: 'g_1', service: null, env: 'e', session: 'e', t: iso(T0), inferred: false };
    s.ingestGate('e', start, T0);
    s.ingestExit('e', exit(T0 + 3000, '2.2.2.2'));
    s.setStatus('e', status(T0 + 10_000), null, T0 + 10_000);
    expect(s.gate('e')!.since).toMatchObject({ gate: { t: T0, exact: true }, exit: { t: T0 + 3000, exact: true } });
    s.tick(T0 + 12_000);
    s.setStatus('e', status(T0 + 13_000), null, T0 + 13_000);
    expect(s.gate('e')!.since.gate).toEqual({ t: T0, exact: true });
  });
});

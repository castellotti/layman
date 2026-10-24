import { describe, expect, it } from 'vitest';
import {
  MAX_CLOSED_FLOWS, applyNetMessage, arrivalNetToken, defaultNetToken, netPickerOrder, initialNetState, networkTabSignal, rangeKey, subscribeTo,
  type NetClientState,
} from './net-state.js';
import type {
  NetDelta, NetSessionSummary, NetSnapshot,
} from './netobs-types.js';
import { dest, flow, gate, rulesView, totals } from './net-test-fixtures.js';

const snapshot = (token: string, over: Partial<NetSnapshot> = {}): NetSnapshot => ({
  token, session: null, gate: gate(), exit: null, exits: [],
  rules: rulesView({ exists: false, file: null }),
  destinations: [dest('arxiv.org:443'), dest('gone.example:443')], flows: [flow('f1')], buckets: [{ t: 1000, up: 1, down: 2 }],
  totals: totals({ flows: 1 }), counters: { records: 1, invalid: 0, skipped: 0, gaps: 0 }, emptyFolded: 0,
  historyTruncated: false, historyOnly: false, range: null, ...over,
});
const delta = (over: Partial<NetDelta> = {}): NetDelta => ({
  flows: [], destinations: [], removedDestinations: [], buckets: [], totals: totals(),
  counters: { records: 2, invalid: 0, skipped: 0, gaps: 0 }, emptyFolded: 0, ...over,
});
const subscribed = (token: string): NetClientState => ({ ...initialNetState, subscribed: token });

describe('applyNetMessage', () => {
  it('records the session list, and that it has been told', () => {
    const s = applyNetMessage(initialNetState, {
      type: 'net:sessions', sessions: [], notObservable: [{ token: 'dark', harness: 'pi', template: null }],
      registry: { state: 'v2-home', detail: 'upgrade glove' },
    });
    expect(s.sessionsKnown).toBe(true);
    expect(s.registry.state).toBe('v2-home');
    expect(s.notObservable.map((n) => n.token)).toEqual(['dark']);
    // A session without data is never a default to show.
    expect(defaultNetToken(s.sessions, 'dark')).toBeNull();
  });

  it('ignores frames for a token it did not subscribe to', () => {
    const s = applyNetMessage(subscribed('a'), { type: 'net:snapshot', token: 'b', snapshot: snapshot('b') });
    expect(s.data).toBeNull();
  });

  it('drops a delta that arrives before the snapshot', () => {
    const s = applyNetMessage(subscribed('a'), { type: 'net:delta', token: 'a', range: null, delta: delta({ flows: [flow('f9')] }) });
    expect(s.data).toBeNull();
  });

  it('applies deltas by replacing, so a repeated delta is harmless', () => {
    let s = applyNetMessage(subscribed('a'), { type: 'net:snapshot', token: 'a', snapshot: snapshot('a') });
    const d = delta({
      flows: [flow('f1', { phase: 'close', state: 'finished', bytes: { up: 9, down: 90 } }), flow('f2')],
      destinations: [dest('arxiv.org:443', { bytesUp: 10 })],
      removedDestinations: ['gone.example:443'],
      buckets: [{ t: 1000, up: 5, down: 6 }, { t: 2000, up: 1, down: 1 }],
      totals: totals({ flows: 2 }),
    });
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', range: null, delta: d });
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', range: null, delta: d });
    expect([...s.data!.flows.keys()].sort()).toEqual(['f1', 'f2']);
    expect(s.data!.flows.get('f1')!.bytes).toEqual({ up: 9, down: 90 });
    expect([...s.data!.destinations.keys()]).toEqual(['arxiv.org:443']);
    expect(s.data!.destinations.get('arxiv.org:443')!.bytesUp).toBe(10);
    expect(s.data!.buckets.get(1000)).toEqual({ t: 1000, up: 5, down: 6 });
    expect(s.data!.totals.flows).toBe(2);
  });

  it('bounds closed flows but never evicts an open one', () => {
    let s = applyNetMessage(subscribed('a'), { type: 'net:snapshot', token: 'a', snapshot: snapshot('a') });
    const closed = Array.from({ length: MAX_CLOSED_FLOWS + 10 }, (_, i) => flow(`c${i}`, { phase: 'close', lastT: i }));
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', range: null, delta: delta({ flows: closed }) });
    expect(s.data!.flows.size).toBe(MAX_CLOSED_FLOWS + 1);
    expect(s.data!.flows.has('f1')).toBe(true);
    expect(s.data!.flows.has('c0')).toBe(false);
  });

  it('applies status, exit and rules frames', () => {
    let s = applyNetMessage(subscribed('a'), { type: 'net:snapshot', token: 'a', snapshot: snapshot('a') });
    s = applyNetMessage(s, { type: 'net:status', token: 'a', status: gate({ freshness: 'stale' }) });
    expect(s.data!.gate.freshness).toBe('stale');
    s = applyNetMessage(s, { type: 'net:rules', token: 'a', rules: rulesView({ file: null, readError: 'bad' }) });
    expect(s.data!.rules.readError).toBe('bad');
    const exit = { v: 1 as const, type: 'exit' as const, t: 't', env: 'a', session: 'a', kind: 'vpn', ip: '1.2.3.4', country: 'Sweden', city: null, lat: null, lon: null, source: 'x', healthy: true };
    s = applyNetMessage(s, { type: 'net:exit', token: 'a', range: null, exit });
    expect(s.data!.exit?.country).toBe('Sweden');
    expect(s.data!.exits).toHaveLength(1);
  });
});

describe('time ranges', () => {
  const R = rangeKey({ from: 1000, to: null });
  const info = { key: R, from: 1000, to: null, filesFrom: 500, sessionFrom: 500, truncated: false, hourly: null, scannedBytes: 10 };
  const inRange = () => subscribeTo(subscribed('a'), 'a', R);

  it('keys a range as the server does', () => {
    expect([rangeKey({ from: 5, to: null }), rangeKey({ from: 5, to: 9 })]).toEqual(['5-now', '5-9']);
  });

  it('shows only the subscribed range: another range’s snapshot, deltas and exits are dropped', () => {
    // All records' snapshot, arriving after the client asked for a range: not this view's.
    let s = applyNetMessage(inRange(), { type: 'net:snapshot', token: 'a', snapshot: snapshot('a') });
    expect(s.data).toBeNull();
    s = applyNetMessage(s, { type: 'net:snapshot', token: 'a', snapshot: snapshot('a', { range: info }) });
    expect(s.data?.range?.key).toBe(R);
    const before = s.data;
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', range: null, delta: delta({ flows: [flow('live')] }) });
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', range: '1-2', delta: delta({ flows: [flow('other')] }) });
    expect(s.data).toBe(before);
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', range: R, delta: delta({ flows: [flow('mine')] }) });
    expect(s.data!.flows.has('mine')).toBe(true);
    // The gate is the same in every range.
    s = applyNetMessage(s, { type: 'net:status', token: 'a', status: gate({ freshness: 'stale' }) });
    expect(s.data!.gate.freshness).toBe('stale');
  });

  it('tracks progress and errors for its own range only, and clears both with the snapshot', () => {
    let s = applyNetMessage(inRange(), { type: 'net:range:progress', token: 'a', range: '1-2', scannedBytes: 1, totalBytes: 9 });
    expect(s.rangeProgress).toBeNull();
    s = applyNetMessage(s, { type: 'net:range:progress', token: 'a', range: R, scannedBytes: 3, totalBytes: 9 });
    expect(s.rangeProgress).toEqual({ range: R, scannedBytes: 3, totalBytes: 9 });
    s = applyNetMessage(s, { type: 'net:snapshot', token: 'a', snapshot: snapshot('a', { range: info }) });
    expect(s.rangeProgress).toBeNull();
    s = applyNetMessage(inRange(), { type: 'net:range:error', token: 'a', range: R, error: 'files gone' });
    expect([s.rangeError, s.data]).toEqual([{ range: R, error: 'files gone' }, null]);
  });

  it('changing range drops what was shown, so the old range never reads as the new one', () => {
    const s = applyNetMessage(subscribed('a'), { type: 'net:snapshot', token: 'a', snapshot: snapshot('a') });
    expect(subscribeTo(s, 'a', R).data).toBeNull();
    expect(subscribeTo(s, 'a', null)).toBe(s);
  });
});

const summary = (token: string, over: Partial<NetSessionSummary> = {}): NetSessionSummary => ({
  token, harness: 'pi', live: false, firstSeen: 0, lastSeen: 0,
  bytesUp: 0, bytesDown: 0, flows: 0, directFlows: 0, rulesOk: true, historyOnly: false,
  glove: { template: null, filter: 'not-granted', transcripts: true, orphaned: false }, ...over,
});

describe('defaultNetToken', () => {
  it('prefers the glove session of the active Layman session', () => {
    expect(defaultNetToken([summary('a'), summary('b')], 'b')).toBe('b');
  });
  it('otherwise the first in the list (the picker’s order)', () => {
    expect(defaultNetToken([summary('a'), summary('b')], 'not-gloved')).toBe('a');
    expect(defaultNetToken([summary('a')], null)).toBe('a');
  });
  it('null with no sessions', () => {
    expect(defaultNetToken([], 'x')).toBeNull();
  });
});

describe('netPickerOrder', () => {
  const tokens = (xs: NetSessionSummary[]) => xs.map((s) => s.token);
  it('puts the Dashboard’s sessions first, in its order, then live, then the newest started', () => {
    const net = [summary('old', { firstSeen: 1 }), summary('idle', { firstSeen: 5, live: true }), summary('dash2', { firstSeen: 2 }),
      summary('new', { firstSeen: 9 }), summary('dash1', { firstSeen: 3, live: true })];
    const dashboard = [{ sessionName: 'dash1' }, { sessionName: 'not-gloved' }, {}, { sessionName: 'dash2' }];
    expect(tokens(netPickerOrder(net, dashboard))).toEqual(['dash1', 'dash2', 'idle', 'new', 'old']);
    // A dragged Dashboard order is followed.
    expect(tokens(netPickerOrder(net, [{ sessionName: 'dash2' }, { sessionName: 'dash1' }])).slice(0, 2)).toEqual(['dash2', 'dash1']);
  });
  it('does not move with traffic: two idle live sessions keep their places as records arrive', () => {
    const a = summary('a', { live: true, firstSeen: 10, lastSeen: 100 });
    const b = summary('b', { live: true, firstSeen: 20, lastSeen: 50 });
    const first = tokens(netPickerOrder([a, b], []));
    for (let t = 101; t < 120; t++) {
      // Each heartbeat makes the other the most recent, and the server reorders by it.
      const server = t % 2 ? [{ ...b, lastSeen: t }, a] : [{ ...a, lastSeen: t }, b];
      expect(tokens(netPickerOrder(server, []))).toEqual(first);
    }
    expect(first).toEqual(['b', 'a']);
  });
  it('breaks a tie by token', () => {
    expect(tokens(netPickerOrder([summary('z'), summary('m')], []))).toEqual(['m', 'z']);
  });
});

describe('arrivalNetToken', () => {
  it('adopts the active session’s glove session only if it is one', () => {
    expect(arrivalNetToken('b', [summary('a'), summary('b')])).toBe('b');
    expect(arrivalNetToken('renamed', [summary('a')])).toBeNull();
    expect(arrivalNetToken(null, [summary('a')])).toBeNull();
  });
});

describe('networkTabSignal', () => {
  it('red for a running gate with rejected rules or untunnelled traffic', () => {
    expect(networkTabSignal([summary('a', { live: true, rulesOk: false })])).toBe('alert');
    expect(networkTabSignal([summary('a', { live: true, directFlows: 1 })])).toBe('alert');
  });
  it('teal for a running gate otherwise', () => {
    expect(networkTabSignal([summary('a', { live: true })])).toBe('live');
  });
  it('nothing for finished sessions, whatever their history', () => {
    expect(networkTabSignal([summary('a', { directFlows: 3, rulesOk: false })])).toBeNull();
  });
});

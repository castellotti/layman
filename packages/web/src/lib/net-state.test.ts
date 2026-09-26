import { describe, expect, it } from 'vitest';
import {
  MAX_CLOSED_FLOWS, applyNetMessage, defaultNetToken, initialNetState, networkTabSignal,
  type NetClientState,
} from './net-state.js';
import type {
  NetDelta, NetSessionSummary, NetSnapshot,
} from './netobs-types.js';
import { dest, flow, gate, rulesView, totals } from './net-test-fixtures.js';

const snapshot = (token: string, over: Partial<NetSnapshot> = {}): NetSnapshot => ({
  token, env: token, name: token, session: null, gate: gate(), exit: null, exits: [],
  rules: rulesView({ exists: false, file: null }),
  destinations: [dest('arxiv.org:443'), dest('gone.example:443')], flows: [flow('f1')], buckets: [{ t: 1000, up: 1, down: 2 }],
  totals: totals({ flows: 1 }), counters: { records: 1, invalid: 0, skipped: 0, gaps: 0 }, emptyFolded: 0,
  historyTruncated: false, historyOnly: false, ...over,
});
const delta = (over: Partial<NetDelta> = {}): NetDelta => ({
  flows: [], destinations: [], removedDestinations: [], buckets: [], totals: totals(),
  counters: { records: 2, invalid: 0, skipped: 0, gaps: 0 }, emptyFolded: 0, ...over,
});
const subscribed = (token: string): NetClientState => ({ ...initialNetState, subscribed: token });

describe('applyNetMessage', () => {
  it('records the session list, and that it has been told', () => {
    const s = applyNetMessage(initialNetState, { type: 'net:sessions', sessions: [] });
    expect(s.sessionsKnown).toBe(true);
  });

  it('ignores frames for a token it did not subscribe to', () => {
    const s = applyNetMessage(subscribed('a'), { type: 'net:snapshot', token: 'b', snapshot: snapshot('b') });
    expect(s.data).toBeNull();
  });

  it('drops a delta that arrives before the snapshot', () => {
    const s = applyNetMessage(subscribed('a'), { type: 'net:delta', token: 'a', delta: delta({ flows: [flow('f9')] }) });
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
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', delta: d });
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', delta: d });
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
    s = applyNetMessage(s, { type: 'net:delta', token: 'a', delta: delta({ flows: closed }) });
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
    s = applyNetMessage(s, { type: 'net:exit', token: 'a', exit });
    expect(s.data!.exit?.country).toBe('Sweden');
    expect(s.data!.exits).toHaveLength(1);
  });
});

const summary = (token: string, over: Partial<NetSessionSummary> = {}): NetSessionSummary => ({
  token, env: token, name: token, harness: 'pi', live: false, firstSeen: 0, lastSeen: 0,
  bytesUp: 0, bytesDown: 0, flows: 0, directFlows: 0, rulesOk: true, historyOnly: false, ...over,
});

describe('defaultNetToken', () => {
  it('prefers the glove session of the active Layman session', () => {
    expect(defaultNetToken([summary('a'), summary('b')], 'b')).toBe('b');
  });
  it('otherwise the first (most recently active) one', () => {
    expect(defaultNetToken([summary('a'), summary('b')], 'not-gloved')).toBe('a');
    expect(defaultNetToken([summary('a')], null)).toBe('a');
  });
  it('null with no sessions', () => {
    expect(defaultNetToken([], 'x')).toBeNull();
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

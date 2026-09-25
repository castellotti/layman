import { describe, expect, it } from 'vitest';
import { IDLE_MS, STALE_MS, aggregateState, classifyFlow, classifySession, flowFlags, type ClassifiableFlow } from './classify.js';
import type { ExitRecord, NetSessionFile, NetState, StatusRecord } from './types.js';

const NOW = Date.parse('2026-09-23T14:15:00.000Z');

const flow = (over: Partial<ClassifiableFlow> = {}): ClassifiableFlow => ({
  phase: 'close',
  verdict: 'allow',
  rule: null,
  close_reason: 'eof',
  dest: { host: 'arxiv.org', port: 443, ip: '151.101.3.42', resolution: 'in-tunnel' },
  scope: 'tunnelled',
  proto: 'http-connect',
  client: 'harness',
  tool: 'web_fetch',
  lastActivityAt: NOW,
  ...over,
});

const NULL_DEST = { host: null, port: null, ip: null, resolution: 'unavailable' };

describe('classifyFlow: one row per NetState', () => {
  const rows: Array<[string, Partial<ClassifiableFlow>, NetState]> = [
    ['open, bytes just moved', { phase: 'update', close_reason: null }, 'active'],
    ['open, idle exactly 3 s is still live', { phase: 'update', close_reason: null, lastActivityAt: NOW - IDLE_MS }, 'active'],
    ['open, idle past 3 s', { phase: 'update', close_reason: null, lastActivityAt: NOW - IDLE_MS - 1 }, 'pooled'],
    ['eof', {}, 'finished'],
    ['reset', { close_reason: 'reset' }, 'finished'],
    ['an unknown close reason', { close_reason: 'novel' }, 'finished'],
    ['guard', { verdict: 'block', rule: 'builtin:ssrf-guard', close_reason: 'blocked' }, 'guard'],
    ['malformed request', { verdict: 'block', rule: 'builtin:malformed-request', dest: NULL_DEST }, 'guard'],
    ['user rule', { verdict: 'block', rule: 'r_01ABC', close_reason: 'blocked' }, 'user_rule'],
    ['terminate:true cutting an allowed flow', { verdict: 'allow', rule: 'r_01ABC', close_reason: 'blocked' }, 'user_rule'],
    ['default block (rule null)', { verdict: 'block', rule: null, close_reason: 'blocked' }, 'default_block'],
    ['a block is a block even while open', { phase: 'open', verdict: 'block', rule: null, close_reason: null }, 'default_block'],
    ['upstream unreachable', { close_reason: 'upstream_unreachable' }, 'broken'],
    ['timeout with a destination', { close_reason: 'timeout' }, 'broken'],
    ['gate shutdown', { close_reason: 'gate_shutdown' }, 'gate_shutdown'],
    ['empty: no host, eof', { close_reason: 'eof', dest: NULL_DEST }, 'empty'],
    ['empty: no host, timeout', { close_reason: 'timeout', dest: NULL_DEST }, 'empty'],
  ];
  it.each(rows)('%s', (_label, over, want) => {
    expect(classifyFlow(flow(over), NOW)).toBe(want);
  });
});

describe('flowFlags', () => {
  it('direct is its own scope', () => {
    expect(flowFlags(flow({ scope: 'direct' })).scope).toBe('direct');
  });
  it('unresolved only for traffic that would be mapped', () => {
    const unresolved = { host: 'duckduckgo.com', port: 443, ip: null, resolution: 'unavailable' };
    expect(flowFlags(flow({ dest: unresolved })).unresolved).toBe(true);
    expect(flowFlags(flow({ dest: unresolved, scope: 'local' })).unresolved).toBe(false);
    expect(flowFlags(flow()).unresolved).toBe(false);
  });
  it('cleartext by proto or port 80', () => {
    expect(flowFlags(flow({ proto: 'http' })).cleartext).toBe(true);
    expect(flowFlags(flow({ dest: { host: 'x.org', port: 80, ip: null, resolution: 'unavailable' } })).cleartext).toBe(true);
    expect(flowFlags(flow()).cleartext).toBe(false);
  });
  it('fan-out by client or tool', () => {
    expect(flowFlags(flow({ client: 'searxng' })).fanout).toBe(true);
    expect(flowFlags(flow({ tool: 'search-engine-fanout' })).fanout).toBe(true);
  });
  it('an unrecognised scope is "unknown", never guessed', () => {
    expect(flowFlags(flow({ scope: 'mesh' })).scope).toBe('unknown');
  });
});

describe('aggregateState', () => {
  it('live wins, then pooled, then the latest flow', () => {
    expect(aggregateState(['finished', 'active'])).toBe('active');
    expect(aggregateState(['user_rule', 'pooled'])).toBe('pooled');
    expect(aggregateState(['finished', 'gate_shutdown'])).toBe('gate_shutdown');
  });
});

const status = (over: Partial<StatusRecord> = {}): StatusRecord => ({
  v: 1,
  gate: '0.1.0',
  state: 'running',
  record: 'metadata',
  upstream: { kind: 'vpn', healthy: true },
  resolver: { mode: 'in-tunnel', healthy: true },
  rules: { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0 },
  t: new Date(NOW - 2_000).toISOString(),
  telemetry: { written: 10, dropped: 0, invalid: 0, rotations: 0 },
  ...over,
});
const exit = (healthy: boolean): ExitRecord => ({
  v: 1, type: 'exit', t: '', env: 'e', session: 'e', kind: 'vpn', ip: healthy ? '195.177.93.17' : null,
  country: healthy ? 'Switzerland' : null, city: null, lat: null, lon: null, source: 'via-proxy:am.i.mullvad.net', healthy,
});
const session = (over: Partial<NetSessionFile> = {}): NetSessionFile => ({
  v: 1, type: 'session', env: 'e', session: 'e', harness: 'pi', gate: '0.1.0', record: 'metadata', resolve: 'in-tunnel',
  resolver: null, exit_identity: 'via-proxy:x', upstream_kind: 'vpn', rendered_at: null,
  services: [{ service: 'proxy', listen: 'p:8888', observed: true }, { service: 'browser', listen: 'b:3001', observed: false }],
  ...over,
});
const gate = (over: Parameters<typeof classifySession>[0]) => classifySession(over, NOW);

describe('classifySession', () => {
  const base = { status: status(), statusMtimeMs: null, exit: exit(true), session: session() };

  it('running with a fresh heartbeat', () => {
    expect(gate(base).freshness).toBe('running');
  });
  it('stale: heartbeat 21 s old', () => {
    expect(gate({ ...base, status: status({ t: new Date(NOW - 21_000).toISOString() }) }).freshness).toBe('stale');
    expect(STALE_MS).toBe(20_000);
  });
  it('stopped: any state other than running', () => {
    expect(gate({ ...base, status: status({ state: 'stopping' }) }).freshness).toBe('stopped');
  });
  it('falls back to status.json mtime when the gate writes no heartbeat', () => {
    const noT = status({ t: null });
    expect(gate({ ...base, status: noT, statusMtimeMs: NOW - 30_000 }).freshness).toBe('stale');
    expect(gate({ ...base, status: noT, statusMtimeMs: NOW - 1_000 }).freshness).toBe('running');
  });
  it('unknown without a status file', () => {
    expect(gate({ ...base, status: null }).freshness).toBe('unknown');
  });
  it('route verified only while the latest exit is healthy', () => {
    expect(gate(base).route.verified).toBe(true);
    expect(gate({ ...base, exit: exit(false) }).route.verified).toBe(false);
    expect(gate({ ...base, exit: null }).route.verified).toBe(false);
  });
  it('declared, not verified, is expected with exit identity off', () => {
    const r = gate({ ...base, exit: null, session: session({ exit_identity: 'none' }) }).route;
    expect(r).toMatchObject({ kind: 'vpn', verified: false, exitIdentityOff: true });
  });
  it('record: full', () => {
    expect(gate({ ...base, status: status({ record: 'full' }) }).record).toBe('full');
  });
  it('telemetry dropped is passed through', () => {
    const g = gate({ ...base, status: status({ telemetry: { written: 9, dropped: 12, invalid: 0, rotations: 0 } }) });
    expect(g.telemetry?.dropped).toBe(12);
  });
  it('resolver down', () => {
    expect(gate({ ...base, status: status({ resolver: { mode: 'in-tunnel', healthy: false } }) }).resolver.healthy).toBe(false);
  });
  it('rules rejected', () => {
    const rules = { loaded_at: null, source_mtime: null, ok: false, error: 'rules[0].match: unknown keys', active_count: 1 };
    expect(gate({ ...base, status: status({ rules }) }).rules).toMatchObject({ ok: false, active_count: 1 });
  });
  it('lists unobserved services', () => {
    expect(gate(base).unwatchedServices).toEqual(['browser']);
  });
});

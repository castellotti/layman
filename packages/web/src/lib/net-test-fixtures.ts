/** Shared fixtures for the network-view unit tests (not a test file itself). */
import type { NetSessionData } from './net-state.js';
import type { DestinationAggregate, FlowView, NetGateView, NetTotals, RulesView } from './netobs-types.js';

/** A healthy, fresh gate on a verified VPN route: the glove fixture session. */
export const gate = (over: Partial<NetGateView> = {}): NetGateView => ({
  freshness: 'running', state: 'running', gateVersion: '0.1.0', heartbeatAgeMs: 2000, record: 'metadata',
  route: { kind: 'vpn', verified: true, exitIdentityOff: false, upstreamHealthy: true },
  resolver: { mode: 'in-tunnel', healthy: true, name: 'dns://gluetun:53' },
  rules: { loaded_at: '2026-09-23T14:14:47.630Z', source_mtime: null, ok: true, error: null, active_count: 1, sha256: null, last_rejected: null },
  telemetry: { written: 83, dropped: 0, invalid: 0, rotations: 0 }, unwatchedServices: [], ...over,
});

export const totals = (over: Partial<NetTotals> = {}): NetTotals => ({
  bytesUp: 0, bytesDown: 0, flows: 0, openFlows: 0, gateLost: 0, destinations: 0,
  blocked: { guard: 0, userRule: 0, default: 0 }, directFlows: 0, broken: 0, ...over,
});

const FLAGS = { scope: 'tunnelled', unresolved: false, noHost: false, cleartext: false, fanout: false } as const;

export const flow = (id: string, over: Partial<FlowView> = {}): FlowView => ({
  id, phase: 'open', tOpen: 1, tClose: null, lastT: 1, lastActivityAt: 1, service: 'proxy', tool: 'web_fetch',
  client: 'harness', proto: 'http-connect', dest: { host: 'arxiv.org', port: 443, ip: null, resolution: 'in-tunnel' },
  scope: 'tunnelled', route: null, bytes: { up: 1, down: 1 }, verdict: 'allow', rule: null, closeReason: null,
  request: null, state: 'active', flags: { ...FLAGS }, destKey: 'arxiv.org:443', groupKey: 'arxiv.org', spark: [], ...over,
});

export const dest = (key: string, over: Partial<DestinationAggregate> = {}): DestinationAggregate => ({
  key, host: key.split(':')[0], port: 443, groupKey: key.split(':')[0], endpoint: null, ips: [], services: [], tools: [], clients: [],
  scope: 'tunnelled', resolution: 'in-tunnel', bytesUp: 1, bytesDown: 1, flows: 1, openFlows: 0, blocked: 0,
  firstSeen: 0, lastSeen: 0, state: 'finished', rule: null, flags: { ...FLAGS }, spark: [],
  policy: { enforced: null, written: null }, ...over,
});

/** rules.json as read: present, empty, enforced, and writable unless overridden. */
export const rulesView = (over: Partial<RulesView> = {}): RulesView => ({
  path: '/r', displayPath: '/r', exists: true, file: { v: 1, env: 'e', session: 'e', default: 'allow', rules: [] },
  readError: null, mtimeMs: 1, sha256: 'aa', invalid: null, enforcement: 'enforced',
  enforced: { v: 1, env: 'e', session: 'e', default: 'allow', rules: [] },
  control: { state: 'ok', detail: '' }, write: null, externalChange: null, ...over,
});

/** One session's client-side data, the fixture session by default. */
export const sessionData = (g: Partial<NetGateView> = {}, over: Partial<NetSessionData> = {}): NetSessionData => ({
  token: 'pi-search', env: 'pi-search', name: 'pi-search', session: null, gate: gate(g),
  exit: { v: 1, type: 'exit', t: 't', env: 'e', session: 'e', kind: 'vpn', ip: '195.177.93.17', country: 'Switzerland', city: null, lat: 47.36, lon: 8.54, source: 'via-proxy:am.i.mullvad.net', healthy: true },
  exits: [],
  rules: rulesView(),
  destinations: new Map(), flows: new Map(), buckets: new Map(), totals: totals(),
  counters: { records: 0, invalid: 0, skipped: 0, gaps: 0 }, emptyFolded: 0, historyTruncated: false,
  ...over,
});

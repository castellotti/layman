import { describe, expect, it } from 'vitest';
import {
  GIBSON_MAX_HOSTS, GIBSON_MAX_LINKS, GIBSON_MAX_LOG, blockOf, hostsFromCalls, hostsFromDestinations, hostsFromFlows,
  linksFromCalls, linksFromFlows, logFromCalls, logFromFlows, mergeHosts, mergeLinks, mergeLog, parseLimit,
} from './gibson.js';
import type { DestinationAggregate, FlowView, TraceCall } from '../netobs/types.js';

const NOW = 1_000_000_000_000;
const at = (secondsAgo: number): number => NOW - secondsAgo * 1000;

function flow(o: {
  host?: string | null; ip?: string | null; port?: number | null; up?: number; down?: number; state?: string; scope?: string;
  hop?: boolean; vpn?: 'listed'; client?: string | null; service?: string; tool?: string | null; open?: number; last?: number;
  closed?: boolean; method?: string; url?: string; rule?: string;
}): FlowView {
  return {
    tOpen: at(o.open ?? 10), tClose: o.closed ? at(1) : null, lastActivityAt: at(o.last ?? 2),
    service: o.service ?? 'proxy', tool: o.tool === undefined ? 'web_fetch' : o.tool, client: o.client === undefined ? 'harness' : o.client,
    proto: 'http-connect',
    dest: { host: o.host === undefined ? 'example.org' : o.host, port: o.port === undefined ? 443 : o.port, ip: o.ip ?? null, resolution: 'in-tunnel' },
    bytes: { up: o.up ?? 0, down: o.down ?? 0 }, state: o.state ?? 'finished', scope: o.scope ?? 'tunnelled', rule: o.rule ?? null,
    request: o.url ? { method: o.method ?? 'GET', url: o.url } : null,
    flags: { hop: o.hop ?? false, ...(o.vpn ? { vpn: o.vpn } : {}) },
  } as unknown as FlowView;
}

function dest(o: { host: string | null; port?: number | null; up?: number; down?: number; flows?: number; open?: number; blocked?: number; scope?: string; hop?: boolean; first?: number; last?: number }): DestinationAggregate {
  return {
    host: o.host, port: o.port === undefined ? 443 : o.port, bytesUp: o.up ?? 0, bytesDown: o.down ?? 0, flows: o.flows ?? 1,
    openFlows: o.open ?? 0, blocked: o.blocked ?? 0, scope: o.scope ?? 'tunnelled', flags: { hop: o.hop ?? false },
    firstSeen: at(o.first ?? 100), lastSeen: at(o.last ?? 5), clients: ['harness'], tools: ['web_fetch'], services: ['proxy'],
  } as unknown as DestinationAggregate;
}

const call = (start: number, tool: string, targets: Array<[string, number | null, ('http' | 'https')?]>, o: { end?: number | null; failed?: boolean; label?: string } = {}): TraceCall =>
  ({
    start, end: o.end === undefined ? start + 1000 : o.end, failed: o.failed ?? false, toolName: tool, label: o.label ?? 'a call',
    targets: targets.map(([host, port, scheme]) => ({ host, port, scheme })),
  }) as unknown as TraceCall;

describe('blockOf', () => {
  it('is the /16 of an IPv4, the registrable domain of a name, and the host itself for IPv6 and unlisted suffixes', () => {
    expect(blockOf('165.1.213.8')).toBe('165.1.0.0/16');
    expect(blockOf('en.wikipedia.org')).toBe('wikipedia.org');
    expect(blockOf('API.GitHub.com')).toBe('github.com');
    expect(blockOf('::1')).toBe('::1');
    expect(blockOf('llm.operator.lan')).toBe('llm.operator.lan');
  });
});

describe('parseLimit', () => {
  it.each([[undefined, 100], ['1', 1], ['500', 500], ['120', 120]])('%j is %j', (raw, n) => expect(parseLimit(raw)).toBe(n));
  it.each(['0', '501', 'x', '1.5', '', '-1', '1e2'])('%j is refused', (raw) => expect(parseLimit(raw)).toBeNull());
});

describe('hostsFromFlows', () => {
  it('merges the ports of one host into one row and sums what moved', () => {
    const rows = hostsFromFlows([
      flow({ host: 'API.GitHub.com', up: 5, down: 50 }), flow({ host: 'api.github.com', up: 1, down: 10 }), flow({ host: 'api.github.com', port: 80 }),
    ], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ host: 'api.github.com', block: 'github.com', ports: [80, 443], sent: 6, received: 60, count: 3, scope: 'tunnelled' });
  });
  it('leaves out a hop and a flow with neither host nor ip, and falls back to the ip', () => {
    const rows = hostsFromFlows([flow({ host: 'glove-llm-auth', hop: true }), flow({ host: null, ip: null }), flow({ host: null, ip: '10.1.2.3' })], NOW);
    expect(rows.map((r) => r.host)).toEqual(['10.1.2.3']);
    expect(rows[0].block).toBe('10.1.0.0/16');
  });
  it('counts refused flows as blocked, and a connection that is open and active or pooled as open', () => {
    const rows = hostsFromFlows([
      ...['guard', 'user_rule', 'default_block', 'finished'].map((state) => flow({ state })),
      flow({ state: 'active' }), flow({ state: 'pooled' }), flow({ state: 'active', closed: true }),
    ], NOW);
    expect(rows[0]).toMatchObject({ count: 7, blocked: 3, open: 2 });
  });
  it('is untunnelled for a direct flow unless it is a known VPN route, and one such flow marks the host', () => {
    expect(hostsFromFlows([flow({ scope: 'direct' })], NOW)[0].untunnelled).toBe(true);
    expect(hostsFromFlows([flow({ scope: 'direct', vpn: 'listed' })], NOW)[0].untunnelled).toBe(false);
    expect(hostsFromFlows([flow({ scope: 'tunnelled' }), flow({ scope: 'direct' })], NOW)[0].untunnelled).toBe(true);
  });
  it('ages run from the first open to the latest activity, and are never negative', () => {
    const [r] = hostsFromFlows([flow({ open: 840, last: 3 }), flow({ open: 10, last: 400 })], NOW);
    expect(r.first_seen_ago).toBe(840);
    expect(r.last_seen_ago).toBe(3);
    const future = hostsFromFlows([{ ...flow({}), tOpen: NOW + 5000, lastActivityAt: NOW + 5000 } as FlowView], NOW)[0];
    expect(future.first_seen_ago).toBe(0);
    expect(future.last_seen_ago).toBe(0);
  });
  it('lists clients, tools and services sorted, unique and at most 8, and skips a null client or tool', () => {
    const flows = Array.from({ length: 12 }, (_, i) => flow({ client: `c${String(11 - i).padStart(2, '0')}`, tool: null, service: 'proxy' }));
    flows.push(flow({ client: null, tool: 'web_fetch' }));
    const [r] = hostsFromFlows(flows, NOW);
    expect(r.clients).toEqual(['c00', 'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07']);
    expect(r.tools).toEqual(['web_fetch']);
    expect(r.services).toEqual(['proxy']);
  });
  it('takes scope from the part with more flows when merged', () => {
    const merged = mergeHosts([
      hostsFromDestinations([dest({ host: 'a.test', flows: 1, scope: 'direct' })], NOW),
      hostsFromDestinations([dest({ host: 'a.test', flows: 5, scope: 'tunnelled' })], NOW),
    ]);
    expect(merged[0]).toMatchObject({ scope: 'tunnelled', count: 6, untunnelled: true });
  });
});

describe('hostsFromDestinations', () => {
  it('maps glove running totals, merges ports, skips hops and a null host', () => {
    const rows = hostsFromDestinations([
      dest({ host: 'a.test', port: 443, up: 3, down: 9, flows: 4, open: 1, blocked: 1, scope: 'direct', first: 840, last: 3 }),
      dest({ host: 'a.test', port: 80, flows: 2 }),
      dest({ host: 'glove-fetcher', hop: true }),
      dest({ host: null }),
    ], NOW);
    expect(rows).toEqual([{
      host: 'a.test', block: 'a.test', ports: [80, 443], sent: 3, received: 9, count: 6, open: 1, blocked: 1, untunnelled: true, scope: 'direct',
      first_seen_ago: 840, last_seen_ago: 3, clients: ['harness'], tools: ['web_fetch'], services: ['proxy'],
    }]);
  });
});

describe('hostsFromCalls', () => {
  it('counts a call once per host, with the ports its URLs gave, only calls inside the window, and no bytes', () => {
    const rows = hostsFromCalls([
      call(at(30), 'WebFetch', [['a.test', null, 'https'], ['a.test', 80, 'http'], ['b.test', null]]),
      call(at(20), 'Bash', [['a.test', 443, 'https']], { end: null }),
      call(at(5000), 'WebFetch', [['a.test', 443, 'https']]),
    ], at(600), NOW, NOW);
    expect(rows).toEqual([
      {
        host: 'a.test', block: 'a.test', ports: [80, 443], sent: 0, received: 0, count: 2, open: 1, blocked: 0, untunnelled: false, scope: '',
        first_seen_ago: 30, last_seen_ago: 20, clients: [], tools: ['Bash', 'WebFetch'], services: [],
      },
      expect.objectContaining({ host: 'b.test', ports: [], count: 1 }),
    ]);
  });
});

describe('mergeHosts', () => {
  it('sums a host across sources, never changes its inputs, and sorts by count then host', () => {
    const a = hostsFromFlows([flow({ host: 'x.test', up: 1 }), flow({ host: 'b.test' }), flow({ host: 'a.test' })], NOW);
    const b = hostsFromCalls([call(at(1), 'WebFetch', [['x.test', 443, 'https']])], 0, NOW, NOW);
    const merged = mergeHosts([a, b]);
    expect(merged.map((r) => [r.host, r.count])).toEqual([['x.test', 2], ['a.test', 1], ['b.test', 1]]);
    expect(a.find((r) => r.host === 'x.test')!.count).toBe(1);
  });
  it('caps after sorting', () => {
    const many = Array.from({ length: GIBSON_MAX_HOSTS + 10 }, (_, i) => flow({ host: `h${String(i).padStart(4, '0')}.test` }));
    many.push(flow({ host: 'zzz.test' }), flow({ host: 'zzz.test' }));
    const rows = hostsFromFlows(many, NOW);
    expect(rows).toHaveLength(GIBSON_MAX_HOSTS);
    expect(rows[0].host).toBe('zzz.test');
    expect(rows[1].host).toBe('h0000.test');
  });
  it('is empty for no sources', () => expect(mergeHosts([])).toEqual([]));
});

describe('links', () => {
  it('are one row per client, gate and host; a missing client is "harness"; hops and host-less flows are left out', () => {
    const rows = linksFromFlows([
      flow({ host: 'a.test', client: null, up: 2 }), flow({ host: 'a.test', client: null, up: 3, state: 'guard' }),
      flow({ host: 'a.test', client: 'llm-auth', service: 'llm' }), flow({ host: 'x', hop: true }), flow({ host: null }),
    ], NOW);
    expect(rows).toEqual([
      { source: 'harness', source_kind: 'client', via: 'proxy', target: 'a.test', sent: 5, received: 0, count: 2, open: 0, blocked: 1, last_seen_ago: 2 },
      { source: 'llm-auth', source_kind: 'client', via: 'llm', target: 'a.test', sent: 0, received: 0, count: 1, open: 0, blocked: 0, last_seen_ago: 2 },
    ]);
  });
  it('for a standard session are the agent, through each tool, to each host', () => {
    const rows = linksFromCalls([call(at(7), 'WebFetch', [['a.test', 443, 'https'], ['a.test', 80, 'http']], { end: null }), call(at(1), 'WebFetch', [['a.test', 443]])], 0, NOW, NOW);
    expect(rows).toEqual([{ source: 'agent', source_kind: 'agent', via: 'WebFetch', target: 'a.test', sent: 0, received: 0, count: 2, open: 1, blocked: 0, last_seen_ago: 1 }]);
  });
  it('merge by key, sort by count, source, via, target, and cap', () => {
    const merged = mergeLinks([
      linksFromFlows([flow({ host: 'b.test' }), flow({ host: 'a.test' })], NOW),
      linksFromFlows([flow({ host: 'b.test' })], NOW),
    ]);
    expect(merged.map((r) => [r.target, r.count])).toEqual([['b.test', 2], ['a.test', 1]]);
    const many = Array.from({ length: GIBSON_MAX_LINKS + 5 }, (_, i) => flow({ host: `h${String(i).padStart(4, '0')}.test` }));
    expect(linksFromFlows(many, NOW)).toHaveLength(GIBSON_MAX_LINKS);
  });
});

describe('the log', () => {
  it('has one row per connection, newest first, filtered by host in lower case, with the request as glove recorded it', () => {
    const rows = logFromFlows([
      flow({ host: 'a.test', open: 30, url: 'https://a.test/x', method: 'POST', up: 4, down: 8 }),
      flow({ host: 'A.test', open: 5, state: 'user_rule', rule: 'r1' }),
      flow({ host: 'b.test', open: 1 }),
    ], NOW, 'A.TEST');
    expect(rows.map((r) => r.ago)).toEqual([5, 30]);
    expect(rows[0]).toMatchObject({ host: 'a.test', time: Math.floor(at(5) / 1000), source: 'harness', via: 'proxy', tool: 'web_fetch', port: 443, proto: 'http-connect', state: 'user_rule', blocked: true, rule: 'r1', method: null, url: null, label: null });
    expect(rows[1]).toMatchObject({ method: 'POST', url: 'https://a.test/x', sent: 4, received: 8, blocked: false });
  });
  it('for a standard session has one row per call and host, with its state and label', () => {
    const rows = logFromCalls([
      call(at(9), 'WebFetch', [['a.test', null, 'https'], ['a.test', 80, 'http']], { label: 'https://a.test/' }),
      call(at(5), 'Bash', [['a.test', 443, 'https']], { end: null }),
      call(at(2), 'WebFetch', [['a.test', 443, 'https']], { failed: true }),
      call(at(1), 'WebFetch', [['b.test', 443, 'https']]),
    ], 0, NOW, NOW, 'a.test');
    expect(rows.map((r) => r.state)).toEqual(['broken', 'active', 'finished']);
    expect(rows[2]).toMatchObject({ source: 'agent', via: 'WebFetch', tool: 'WebFetch', port: 443, proto: 'https', label: 'https://a.test/', url: null, method: null, sent: 0 });
  });
  it('is cut to the limit after sorting, and ties go by host', () => {
    const a = logFromFlows(Array.from({ length: 5 }, (_, i) => flow({ host: `h${i}.test`, open: 3 })), NOW);
    expect(mergeLog([a], 3).map((r) => r.host)).toEqual(['h0.test', 'h1.test', 'h2.test']);
    expect(logFromFlows(Array.from({ length: GIBSON_MAX_LOG + 5 }, () => flow({})), NOW)).toHaveLength(GIBSON_MAX_LOG);
  });
});

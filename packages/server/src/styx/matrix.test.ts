import { describe, expect, it } from 'vitest';
import { MATRIX_MAX_ROWS, mergeRows, parseRelative, rowsFromCalls, rowsFromDestinations, rowsFromFlows } from './matrix.js';
import type { DestinationAggregate, FlowView, TraceCall } from '../netobs/types.js';

function flow(o: { host?: string | null; ip?: string | null; port?: number | null; up?: number; down?: number; state?: string; scope?: string; hop?: boolean; vpn?: 'listed' }): FlowView {
  return {
    dest: { host: o.host === undefined ? 'example.org' : o.host, port: o.port === undefined ? 443 : o.port, ip: o.ip ?? null, resolution: 'in-tunnel' },
    bytes: { up: o.up ?? 0, down: o.down ?? 0 },
    state: o.state ?? 'done',
    scope: o.scope ?? 'tunnelled',
    flags: { hop: o.hop ?? false, ...(o.vpn ? { vpn: o.vpn } : {}) },
  } as unknown as FlowView;
}

function dest(o: { host: string | null; port?: number | null; up?: number; down?: number; flows?: number; blocked?: number; scope?: string; hop?: boolean }): DestinationAggregate {
  return {
    host: o.host, port: o.port === undefined ? 443 : o.port, bytesUp: o.up ?? 0, bytesDown: o.down ?? 0,
    flows: o.flows ?? 1, blocked: o.blocked ?? 0, scope: o.scope ?? 'tunnelled', flags: { hop: o.hop ?? false },
  } as unknown as DestinationAggregate;
}

const call = (start: number, ...targets: Array<[string, number | null, ('http' | 'https')?]>): TraceCall =>
  ({ start, targets: targets.map(([host, port, scheme]) => ({ host, port, scheme })) }) as unknown as TraceCall;

describe('parseRelative', () => {
  it.each([['60s', 60_000], ['15m', 900_000], ['1h', 3_600_000], ['2d', 172_800_000]])('%s is %i ms', (raw, ms) => {
    expect(parseRelative(raw)).toBe(ms);
  });
  it.each(['', '60', 's', '-5m', '0s', '1y', '1.5h', '60 s', '15M', '00m'])('%j is malformed', (raw) => {
    expect(parseRelative(raw)).toBeNull();
  });
});

describe('rowsFromFlows', () => {
  it('one row per host:port, lower-case, summing bytes and counting flows', () => {
    const rows = rowsFromFlows([flow({ host: 'API.GitHub.com', up: 5, down: 50 }), flow({ host: 'api.github.com', up: 1, down: 10 }), flow({ host: 'api.github.com', port: 80 })]);
    expect(rows).toEqual([
      { address: 'api.github.com:443', sent: 6, received: 60, count: 2, blocked: 0, untunnelled: false },
      { address: 'api.github.com:80', sent: 0, received: 0, count: 1, blocked: 0, untunnelled: false },
    ]);
  });
  it('uses the ip when there is no host, the bare host when there is no port, and skips a flow with neither', () => {
    const rows = rowsFromFlows([flow({ host: null, ip: '10.1.2.3' }), flow({ host: 'nohost.test', port: null }), flow({ host: null, ip: null })]);
    expect(rows.map((r) => r.address).sort()).toEqual(['10.1.2.3:443', 'nohost.test']);
  });
  it('never lists a hop as a destination', () => {
    expect(rowsFromFlows([flow({ host: 'glove-llm-auth', hop: true }), flow({ host: 'real.test' })]).map((r) => r.address)).toEqual(['real.test:443']);
  });
  it('counts refused flows (the states Trace refuses) as blocked', () => {
    const rows = rowsFromFlows(['guard', 'user_rule', 'default_block', 'done', 'live'].map((state) => flow({ state })));
    expect(rows[0]).toMatchObject({ count: 5, blocked: 3 });
  });
  it('is untunnelled only for direct traffic that is not a known VPN route, and one such flow marks the row', () => {
    expect(rowsFromFlows([flow({ scope: 'direct' })])[0].untunnelled).toBe(true);
    expect(rowsFromFlows([flow({ scope: 'direct', vpn: 'listed' })])[0].untunnelled).toBe(false);
    expect(rowsFromFlows([flow({ scope: 'tunnelled' })])[0].untunnelled).toBe(false);
    expect(rowsFromFlows([flow({ scope: 'tunnelled' }), flow({ scope: 'direct' })])[0].untunnelled).toBe(true);
  });
});

describe('rowsFromDestinations', () => {
  it('maps glove running totals, skipping hops and a null host (a service endpoint)', () => {
    const rows = rowsFromDestinations([
      dest({ host: 'a.test', up: 3, down: 9, flows: 4, blocked: 1, scope: 'direct' }),
      dest({ host: 'glove-fetcher', hop: true }),
      dest({ host: null }),
    ]);
    expect(rows).toEqual([{ address: 'a.test:443', sent: 3, received: 9, count: 4, blocked: 1, untunnelled: true }]);
  });
  it('the same host on two ports is two rows', () => {
    expect(rowsFromDestinations([dest({ host: 'a.test', port: 80 }), dest({ host: 'a.test' })]).map((r) => r.address)).toEqual(['a.test:443', 'a.test:80']);
  });
});

describe('rowsFromCalls', () => {
  it('counts a call once per host it names, only calls that started in the window, with no bytes', () => {
    const rows = rowsFromCalls([call(100, ['a.test', 443], ['b.test', null]), call(200, ['a.test', 443]), call(50, ['a.test', 443]), call(999, ['a.test', 443])], 100, 200);
    expect(rows).toEqual([
      { address: 'a.test:443', sent: 0, received: 0, count: 2, blocked: 0, untunnelled: false },
      { address: 'b.test', sent: 0, received: 0, count: 1, blocked: 0, untunnelled: false },
    ]);
  });
});

describe('rowsFromCalls: the scheme gives the port', () => {
  it('an unspelled port is 443 for https and 80 for http, so a row says which was used; a spelled port wins; no scheme (ssh) is the bare host', () => {
    const rows = rowsFromCalls([call(1, ['a.test', null, 'https'], ['b.test', null, 'http'], ['c.test', 8080, 'http'], ['d.test', null])], 0, 10);
    expect(rows.map((r) => r.address)).toEqual(['a.test:443', 'b.test:80', 'c.test:8080', 'd.test']);
  });
});

describe('mergeRows', () => {
  it('sums the same address across sources and does not change its inputs', () => {
    const a = rowsFromDestinations([dest({ host: 'x.test', flows: 2, up: 1 })]);
    const b = rowsFromCalls([call(1, ['x.test', 443])], 0, 10);
    const merged = mergeRows([a, b]);
    expect(merged).toEqual([{ address: 'x.test:443', sent: 1, received: 0, count: 3, blocked: 0, untunnelled: false }]);
    expect(a[0].count).toBe(2);
  });
  it('sorts by count descending then address ascending, and caps after sorting', () => {
    const many = Array.from({ length: MATRIX_MAX_ROWS + 10 }, (_, i) => dest({ host: `h${String(i).padStart(4, '0')}.test`, flows: 1 }));
    many.push(dest({ host: 'zzz.test', flows: 9 }));
    const rows = mergeRows([rowsFromDestinations(many)]);
    expect(rows).toHaveLength(MATRIX_MAX_ROWS);
    expect(rows[0].address).toBe('zzz.test:443');
    expect(rows[1].address).toBe('h0000.test:443');
    expect(rows.at(-1)!.address).toBe(`h${String(MATRIX_MAX_ROWS - 2).padStart(4, '0')}.test:443`);
  });
  it('is empty for no sources', () => {
    expect(mergeRows([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { HostRow, LinkRow, LogRow } from './gibson-feed.js';
import {
  EMPTY_PLACEMENT, boxOf, buildCity, createTraffic, formatAgoShort, formatBytesShort, menuOf, pageOf, place, routeOf, spiral, toneOf,
  type City, type Placement,
} from './gibson-city.js';

const host = (name: string, over: Partial<HostRow> = {}): HostRow => ({
  host: name, block: name.split('.').slice(-2).join('.'), ports: [443], sent: 100, received: 1000, count: 10, open: 0, blocked: 0,
  untunnelled: false, scope: 'tunnelled', first_seen_ago: 60, last_seen_ago: 5, clients: [], tools: [], services: [], ...over,
});
const link = (target: string, over: Partial<LinkRow> = {}): LinkRow => ({
  source: 'harness', source_kind: 'client', via: 'proxy', target, sent: 100, received: 100, count: 10, open: 0, blocked: 0, last_seen_ago: 1, ...over,
});
const log = (over: Partial<LogRow> = {}): LogRow => ({
  host: 'a.org', time: 1_700_000_000, ago: 1, source: 'harness', via: 'proxy', tool: null, port: 443, proto: null, sent: 10, received: 20,
  state: 'finished', blocked: false, rule: null, method: null, url: null, label: null, ...over,
});

describe('spiral', () => {
  it('walks out from the centre in the design\'s order', () => {
    const want: Record<number, [number, number]> = {
      0: [0, 0], 1: [1, 0], 2: [1, 1], 3: [0, 1], 4: [-1, 1], 5: [-1, 0], 6: [-1, -1], 7: [0, -1], 8: [1, -1], 9: [2, -1],
      12: [2, 2], 13: [1, 2], 16: [-2, 2], 17: [-2, 1], 20: [-2, -2], 21: [-1, -2], 24: [2, -2],
    };
    for (const [i, xz] of Object.entries(want)) expect(spiral(Number(i)), `slot ${i}`).toEqual(xz);
  });
  it('never repeats a slot', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(spiral(i).join(','));
    expect(seen.size).toBe(400);
  });
});

describe('toneOf', () => {
  it('takes the first that matches: blocked, untunnelled, local, normal', () => {
    expect(toneOf(host('a.org', { count: 3, blocked: 3, untunnelled: true, scope: 'lan' }))).toBe('blocked');
    expect(toneOf(host('a.org', { count: 3, blocked: 2, untunnelled: true, scope: 'lan' }))).toBe('untunnelled');
    expect(toneOf(host('a.org', { untunnelled: false, scope: 'lan' }))).toBe('local');
    expect(toneOf(host('a.org', { scope: 'local' }))).toBe('local');
    expect(toneOf(host('a.org', { count: 3, blocked: 1 }))).toBe('normal');
    expect(toneOf(host('a.org', { count: 0, blocked: 0 }))).toBe('normal');
  });
});

describe('place', () => {
  const slotOf = (p: Placement, h: string): number => p.blocks.get(p.lots.get(h)!.block)!;

  it('puts the busiest block nearest the centre and one chip, LOCAL, on lot 5 with no links', () => {
    const p = place(EMPTY_PLACEMENT, [host('a.github.com', { block: 'github.com' }), host('x.example.org', { block: 'example.org' })], []);
    expect(slotOf(p, 'a.github.com')).toBe(1);
    expect(slotOf(p, 'x.example.org')).toBe(2);
    expect([...p.home]).toEqual([['LOCAL', 5]]);
  });
  it('gives each source the lowest free home lot, in the order the links arrive, the 17th onward lot 15', () => {
    const links = Array.from({ length: 18 }, (_, i) => link('a.org', { source: `s${i}` }));
    const p = place(EMPTY_PLACEMENT, [], links);
    expect(p.home.get('s0')).toBe(0);
    expect(p.home.get('s15')).toBe(15);
    expect(p.home.get('s16')).toBe(15);
    expect(p.home.get('s17')).toBe(15);
    const next = place(p, [], links.slice(1));
    expect(next.home.get('s1')).toBe(1); // stays
  });
  it('starts a second block with the 17th host of a block', () => {
    const hosts = Array.from({ length: 17 }, (_, i) => host(`h${i}.big.com`, { block: 'big.com' }));
    const p = place(EMPTY_PLACEMENT, hosts, []);
    expect(p.lots.get('h15.big.com')).toEqual({ block: 'big.com', lot: 15 });
    expect(p.lots.get('h16.big.com')).toEqual({ block: 'big.com#2', lot: 0 });
    expect(p.blocks.get('big.com')).toBe(1);
    expect(p.blocks.get('big.com#2')).toBe(2);
  });
  it('frees the lot of a host that left, and the next new host of that block takes it; an empty block frees its slot', () => {
    const a = host('a.one.com', { block: 'one.com' });
    const b = host('b.one.com', { block: 'one.com' });
    const c = host('c.two.com', { block: 'two.com' });
    const p1 = place(EMPTY_PLACEMENT, [a, b, c], []);
    const p2 = place(p1, [b, c], []);
    expect(p2.lots.has('a.one.com')).toBe(false);
    const d = host('d.one.com', { block: 'one.com' });
    const p3 = place(p2, [b, c, d], []);
    expect(p3.lots.get('d.one.com')).toEqual(p1.lots.get('a.one.com'));
    // two.com's only host goes: its slot is free for the next new block
    const p4 = place(p3, [b, d], []);
    expect(p4.blocks.has('two.com')).toBe(false);
    const e = host('e.three.com', { block: 'three.com' });
    expect(place(p4, [b, d, e], []).blocks.get('three.com')).toBe(p1.blocks.get('two.com'));
  });
  it('never moves a host that stays, across ten refreshes with changing counts', () => {
    let p = place(EMPTY_PLACEMENT, [host('a.one.com', { block: 'one.com' }), host('b.two.com', { block: 'two.com' })], []);
    const first = new Map(p.lots);
    const firstBlocks = new Map(p.blocks);
    for (let i = 0; i < 10; i++) {
      // the answer's order changes and new hosts come and go around the two
      const hosts = [host(`n${i}.new${i % 3}.com`, { block: `new${i % 3}.com`, count: 99 }), host('b.two.com', { block: 'two.com', count: i }), host('a.one.com', { block: 'one.com', count: 50 - i })];
      p = place(p, hosts, []);
      expect(p.lots.get('a.one.com')).toEqual(first.get('a.one.com'));
      expect(p.lots.get('b.two.com')).toEqual(first.get('b.two.com'));
      expect(p.blocks.get('one.com')).toBe(firstBlocks.get('one.com'));
      expect(p.blocks.get('two.com')).toBe(firstBlocks.get('two.com'));
    }
  });
  it('does not mutate what it was given', () => {
    const prev = place(EMPTY_PLACEMENT, [host('a.one.com', { block: 'one.com' })], [link('a.one.com')]);
    const before = JSON.stringify([[...prev.blocks], [...prev.lots], [...prev.home]]);
    place(prev, [host('b.two.com', { block: 'two.com' })], [link('b.two.com', { source: 'other' })]);
    expect(JSON.stringify([[...prev.blocks], [...prev.lots], [...prev.home]])).toBe(before);
    expect(EMPTY_PLACEMENT.blocks.size + EMPTY_PLACEMENT.lots.size + EMPTY_PLACEMENT.home.size).toBe(0);
  });
});

describe('buildCity', () => {
  const city = (hosts: HostRow[], links: LinkRow[] = [], fresh = new Set<string>()): City => buildCity(place(EMPTY_PLACEMENT, hosts, links), hosts, links, fresh);

  it('stands towers on their lots', () => {
    const c = city([host('a.one.com', { block: 'one.com' })]);
    // slot 1 is (1, 0): centre x 16; lot 0 is column 0, row 0: (-1.5 * 3, -1.5 * 3)
    expect(c.towers[0].x).toBeCloseTo(16 - 4.5);
    expect(c.towers[0].z).toBeCloseTo(-4.5);
  });
  it('makes height from bytes, the largest at 36 and a quiet one at least 2', () => {
    const c = city([host('big.org', { sent: 1e6, received: 1e6 }), host('small.org', { sent: 0, received: 1 }), host('none.org', { sent: 0, received: 0 })]);
    const h = (n: string) => c.towers.find((t) => t.host === n)!.height;
    expect(h('big.org')).toBeCloseTo(36);
    expect(h('small.org')).toBeGreaterThan(2);
    expect(h('small.org')).toBeLessThan(h('big.org'));
    expect(h('none.org')).toBe(2);
  });
  it('makes height from the count when no host has bytes', () => {
    const c = city([host('a.org', { sent: 0, received: 0, count: 100 }), host('b.org', { sent: 0, received: 0, count: 3 })]);
    expect(c.towers[0].height).toBeCloseTo(36);
    expect(c.towers[1].height).toBeLessThan(36);
    expect(c.towers[1].height).toBeGreaterThan(2);
  });
  it('keeps height and side inside their bounds, even for an empty answer or all zeros', () => {
    expect(city([]).towers).toEqual([]);
    const z = city([host('a.org', { sent: 0, received: 0, count: 0 })]);
    expect(z.towers[0].height).toBe(2);
    expect(z.towers[0].side).toBeCloseTo(1.2);
    const c = city([host('a.org', { count: 1000 }), host('b.org', { count: 1 })]);
    for (const t of c.towers) {
      expect(t.height).toBeGreaterThanOrEqual(2);
      expect(t.height).toBeLessThanOrEqual(36);
      expect(t.side).toBeGreaterThanOrEqual(1.2);
      expect(t.side).toBeLessThanOrEqual(2);
    }
    expect(c.towers[0].side).toBeCloseTo(2);
  });
  it('carries tone, the refused part, activity and fresh', () => {
    const c = city([host('a.org', { count: 4, blocked: 1, last_seen_ago: 15 }), host('b.org', { last_seen_ago: 99 })], [], new Set(['b.org']));
    expect(c.towers[0].blockedFraction).toBeCloseTo(0.25);
    expect(c.towers[0].activity).toBeCloseTo(0.5);
    expect(c.towers[1].activity).toBe(0);
    expect(c.towers.map((t) => t.fresh)).toEqual([false, true]);
  });
  it('has a chip for each source, and the extent grows with the rings, at least 24', () => {
    expect(city([]).extent).toBe(24);
    expect(city([], [link('a.org', { source: 'x' }), link('a.org', { source: 'y' })]).chips.map((k) => k.source)).toEqual(['x', 'y']);
    const many = Array.from({ length: 60 }, (_, i) => host(`h.b${i}.com`, { block: `b${i}.com` }));
    const big = city(many);
    expect(big.extent).toBeGreaterThan(24);
    const reach = Math.max(...big.towers.map((t) => Math.max(Math.abs(t.x), Math.abs(t.z))));
    expect(big.extent).toBeGreaterThanOrEqual(reach);
  });
});

describe('routeOf', () => {
  const axisAligned = (r: Array<[number, number]>): boolean => r.every((p, i) => i === 0 || p[0] === r[i - 1][0] || p[1] === r[i - 1][1]);
  const noDuplicates = (r: Array<[number, number]>): boolean => r.every((p, i) => i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1]);

  it('runs along street centre lines to a tower next to home', () => {
    const r = routeOf([-1.5, -1.5], [11.5, -4.5]);
    expect(r[0]).toEqual([-1.5, -1.5]);
    expect(r[r.length - 1]).toEqual([11.5, -4.5]);
    expect(axisAligned(r)).toBe(true);
    expect(noDuplicates(r)).toBe(true);
    // the middle legs are on streets: x or z is 16 k + 8
    for (const [x, z] of r.slice(1, -1)) expect((x - 8) % 16 === 0 || (z - 8) % 16 === 0).toBe(true);
  });
  it('and to one three blocks away', () => {
    const r = routeOf([-1.5, 1.5], [3 * 16 - 4.5, 2 * 16 + 1.5]);
    expect(axisAligned(r)).toBe(true);
    expect(noDuplicates(r)).toBe(true);
    expect(r[r.length - 1]).toEqual([3 * 16 - 4.5, 2 * 16 + 1.5]);
  });
  it('drops a point equal to the one before it', () => {
    const r = routeOf([8, 8], [8, 8]);
    expect(r).toEqual([[8, 8]]);
  });
});

describe('formatting', () => {
  it('writes bytes in powers of 1024, one decimal from K up', () => {
    expect([0, 512, 1023, 1024, 5222, 2 * 1024 ** 2, 1024 ** 3, 1024 * 1024 - 1].map(formatBytesShort))
      .toEqual(['0B', '512B', '1023B', '1.0K', '5.1K', '2.0M', '1.0G', '1.0M']);
  });
  it('writes ages in the largest whole unit', () => {
    expect([0, 3, 59, 60, 240, 7200, 5 * 86400, -4].map(formatAgoShort)).toEqual(['0S', '3S', '59S', '1M', '4M', '2H', '5D', '0S']);
  });
});

describe('pageOf', () => {
  it('lists what the row holds, upper-case, in order, and ends in two blank lines', () => {
    const p = pageOf(host('api.example.com', {
      ports: [80, 443], count: 14, open: 1, sent: 5222, received: 90_000, scope: 'direct', blocked: 3,
      services: ['proxy'], tools: ['web_fetch'], clients: ['harness'], last_seen_ago: 3,
    }));
    expect(p).toEqual([
      'API.EXAMPLE.COM', '', 'PORT 80 443', 'COUNT 14', 'OPEN 1', 'UP 5.1K', 'DOWN 87.9K', 'SCOPE DIRECT', 'REFUSED 3',
      'VIA PROXY', 'TOOL WEB_FETCH', 'FROM HARNESS', 'SEEN 3S AGO', '', '',
    ]);
  });
  it('leaves out what is not there and wraps a long host', () => {
    const p = pageOf(host('a'.repeat(30) + '.org', { ports: [], scope: '', open: 0, blocked: 0 }));
    expect(p.slice(0, 3)).toEqual(['A'.repeat(24), 'A'.repeat(6) + '.ORG', '']);
    expect(p.some((l) => l.startsWith('OPEN') || l.startsWith('PORT') || l.startsWith('SCOPE') || l.startsWith('REFUSED'))).toBe(false);
    expect(p.every((l) => l.length <= 24)).toBe(true);
  });
  it('continues after SEEN with the log, newest first as given, at most 40', () => {
    const noon = new Date(2026, 0, 2, 12, 34, 56).getTime() / 1000;
    const rows = [log({ time: noon, port: 443 }), log({ time: noon - 5, port: null, blocked: true, state: 'refused' }), log({ time: noon - 9, state: 'active' }), log({ time: noon - 20, state: 'broken' })];
    const p = pageOf(host('a.org'), rows);
    const at = p.indexOf('SEEN 5S AGO');
    expect(p.slice(at + 1, at + 5)).toEqual(['12:34:56 443 OK', '12:34:51 - REFUSED', '12:34:47 443 LIVE', '12:34:36 443 BROKEN']);
    const many = pageOf(host('a.org'), Array.from({ length: 80 }, () => log()));
    expect(many.length).toBe(pageOf(host('a.org')).length + 40);
  });
});

describe('menuOf', () => {
  it('groups by port and via (or source when via is empty), busiest first, ties by label', () => {
    const rows = [
      log({ port: 443, via: 'proxy' }), log({ port: 443, via: 'proxy' }), log({ port: 443, via: 'proxy' }),
      log({ port: 80, via: 'proxy' }),
      log({ port: 443, via: '', source: '172.16.100.102' }), log({ port: 443, via: '', source: '172.16.100.102' }),
      log({ port: null, via: 'proxy' }),
    ];
    const m = menuOf(rows);
    expect(m.map((i) => [i.label, i.rows.length])).toEqual([['443 PROXY', 3], ['443 172.16.100.102', 2], ['- PROXY', 1], ['80 PROXY', 1]]);
  });
  it('shows at most 12 items', () => {
    expect(menuOf(Array.from({ length: 30 }, (_, i) => log({ port: 1000 + i }))).length).toBe(12);
  });
  it('is empty for an empty log', () => {
    expect(menuOf([])).toEqual([]);
  });
});

describe('boxOf', () => {
  it('titles a row with a url by its method and path, cut to 22', () => {
    expect(boxOf(log({ method: 'get', url: 'https://a.org/v1/models?x=1' })).title).toBe('GET /V1/MODELS');
    expect(boxOf(log({ method: 'POST', url: 'https://a.org/' + 'p'.repeat(40) })).title).toBe('POST /' + 'P'.repeat(21));
    expect(boxOf(log({ url: 'https://a.org/x' })).title).toBe('/X');
  });
  it('else its label, cut to 22, else its time', () => {
    expect(boxOf(log({ label: 'a label that is much longer than allowed' })).title).toBe('A LABEL THAT IS MUCH L');
    const t = new Date(2026, 0, 2, 3, 4, 5).getTime() / 1000;
    expect(boxOf(log({ time: t })).title).toBe('03:04:05');
  });
  it('captions the state and the bytes; a refused row names its rule', () => {
    expect(boxOf(log({ sent: 5222, received: 90_000 }))).toEqual({ title: expect.any(String), caption: 'OK 5.1K 87.9K', blocked: false });
    expect(boxOf(log({ state: 'active', sent: 1, received: 2 })).caption).toBe('LIVE 1B 2B');
    expect(boxOf(log({ blocked: true, state: 'refused', rule: 'default_block' }))).toMatchObject({ caption: 'REFUSED DEFAULT_BLOCK', blocked: true });
    expect(boxOf(log({ blocked: true, state: 'refused' })).caption).toBe('REFUSED');
  });
});

describe('traffic', () => {
  const hosts = [host('a.org'), host('b.org')];
  const world = (links: LinkRow[]): City => buildCity(place(EMPTY_PLACEMENT, hosts, links), hosts, links, new Set());
  /** Simulate `seconds` at 10 steps a second; the number of distinct cars seen. */
  const seen = (links: LinkRow[], seconds: number): Set<string> => {
    const city = world(links);
    const t = createTraffic();
    const keys = new Set<string>();
    for (let i = 0; i < seconds * 10; i++) for (const c of t.step(0.1, links, city)) keys.add(c.key);
    return keys;
  };

  it('sends nothing on a link quiet for over 60 s with nothing open', () => {
    expect(seen([link('a.org', { last_seen_ago: 100, open: 0 })], 60).size).toBe(0);
    expect(seen([link('a.org', { last_seen_ago: 100, open: 1 })], 60).size).toBeGreaterThan(0);
  });
  it('sends more on a busy link than on a quiet one', () => {
    const busy = seen([link('a.org', { count: 500, last_seen_ago: 0 })], 60).size;
    const quiet = seen([link('a.org', { count: 1, last_seen_ago: 40 })], 60).size;
    expect(busy).toBeGreaterThan(quiet);
    expect(quiet).toBeGreaterThan(0);
  });
  it('sends nothing for a link whose target has no tower', () => {
    expect(seen([link('nowhere.org')], 30).size).toBe(0);
  });
  it('is repeatable, and a step of 0 seconds changes nothing', () => {
    const links = [link('a.org'), link('b.org', { sent: 900, received: 100 })];
    const city = world(links);
    const run = () => { const t = createTraffic(); let last: unknown[] = []; for (let i = 0; i < 100; i++) last = t.step(0.1, links, city); return last; };
    expect(run()).toEqual(run());
    const t = createTraffic();
    for (let i = 0; i < 50; i++) t.step(0.1, links, city);
    expect(t.step(0, links, city)).toEqual(t.step(0, links, city));
  });
  it('runs a fully refused link\'s cars outbound only, ending in a flash, then gone', () => {
    const links = [link('a.org', { count: 5, blocked: 5, sent: 0, received: 900 })];
    const city = world(links);
    const tower = city.towers[0];
    const t = createTraffic();
    let flashed = false;
    const reached = new Set<string>();
    for (let i = 0; i < 600; i++) {
      for (const c of t.step(0.05, links, city)) {
        expect(c.blocked).toBe(true);
        if (c.flash > 0) {
          flashed = true;
          expect([c.x, c.z]).toEqual([tower.x, tower.z]); // stopped at the tower
        }
      }
      for (const h of t.arrivals()) reached.add(h);
    }
    expect(flashed).toBe(true);
    expect([...reached]).toEqual(['a.org']);
    // with the link gone the cars finish and the street is empty
    for (let i = 0; i < 100; i++) t.step(0.1, [], city);
    expect(t.step(0, [], city)).toEqual([]);
  });
  it('sends some cars inbound when the link receives, and brightens a tower only for an outbound arrival', () => {
    const links = [link('a.org', { count: 800, last_seen_ago: 0, sent: 500, received: 500 })];
    const city = world(links);
    const t = createTraffic();
    const start = new Map<string, [number, number]>();
    let inbound = 0;
    let outbound = 0;
    for (let i = 0; i < 1200; i++) {
      for (const c of t.step(0.05, links, city)) {
        if (!start.has(c.key)) start.set(c.key, [c.x, c.z]);
      }
    }
    for (const [x, z] of start.values()) {
      const nearTower = Math.abs(x - city.towers[0].x) + Math.abs(z - city.towers[0].z) < 8;
      if (nearTower) inbound++; else outbound++;
    }
    expect(inbound).toBeGreaterThan(0);
    expect(outbound).toBeGreaterThan(0);
  });
  it('never has more than 96 cars alive', () => {
    const many = Array.from({ length: 300 }, (_, i) => link('a.org', { source: `s${i}`, count: 9999, last_seen_ago: 0 }));
    const city = world(many);
    const t = createTraffic();
    let max = 0;
    for (let i = 0; i < 400; i++) max = Math.max(max, t.step(0.1, many, city).length);
    expect(max).toBeLessThanOrEqual(96);
    expect(max).toBe(96);
  });
});

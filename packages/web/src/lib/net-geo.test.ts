import { describe, expect, it } from 'vitest';
import {
  arcPath, clusterDestinations, fitBounds, isMappable, makeProjection, ribbonLanes, screenCurve, strokeWidth, trunkFor, unknownLocation,
  LAT_MAX, LAT_MIN,
} from './net-geo.js';
import { dest, flow, gate } from './net-test-fixtures.js';
import type { ExitRecord } from './netobs-types.js';

const SF = { lat: 37.77, lon: -122.42, city: 'San Francisco', country: 'United States', countryCode: 'US' };
const AMS = { lat: 52.37, lon: 4.9, city: 'Amsterdam', country: 'Netherlands', countryCode: 'NL' };

describe('fitting the view', () => {
  it('defaults to the North Atlantic, and widens a single point', () => {
    expect(fitBounds([])).toEqual([[-100, 20], [35, 62]]);
    const [[w, s], [e, n]] = fitBounds([[4.9, 52.37]]);
    expect(e - w).toBeCloseTo(50);
    expect(n - s).toBeCloseTo(25);
  });
  it('never fits past the Mercator clip', () => {
    const [[, s], [, n]] = fitBounds([[0, 89], [0, -80]]);
    expect([s, n]).toEqual([LAT_MIN, LAT_MAX]);
  });
  it('fits the destinations, not the whole world', () => {
    const p = makeProjection(800, 500, fitBounds([[SF.lon, SF.lat], [AMS.lon, AMS.lat]]), 0);
    const span = p([AMS.lon, AMS.lat])![0] - p([SF.lon, SF.lat])![0];
    expect(span).toBeGreaterThan(700); // the two ends nearly fill the width
  });
  it('keeps the fit clear of the cards over the map', () => {
    const p = makeProjection(1440, 680, fitBounds([[SF.lon, SF.lat], [AMS.lon, AMS.lat]]), { top: 56, right: 350, bottom: 56, left: 330 });
    expect(p([SF.lon, SF.lat])![0]).toBeGreaterThanOrEqual(329);
    expect(p([AMS.lon, AMS.lat])![0]).toBeLessThanOrEqual(1091);
  });
  it('puts both ends of the fit inside the box', () => {
    const p = makeProjection(800, 500, fitBounds([[SF.lon, SF.lat], [AMS.lon, AMS.lat]]));
    for (const pt of [[SF.lon, SF.lat], [AMS.lon, AMS.lat]] as Array<[number, number]>) {
      const [x, y] = p(pt)!;
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(800);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(500);
    }
  });
});

describe('arcs', () => {
  const p = makeProjection(1000, 600, fitBounds([[SF.lon, SF.lat], [AMS.lon, AMS.lat]]));
  const project = (pt: [number, number]) => p(pt) as [number, number] | null;
  it('samples a great circle into one path', () => {
    const d = arcPath(project, [AMS.lon, AMS.lat], [SF.lon, SF.lat], 1000);
    expect(d.match(/[ML]/g)).toHaveLength(49);
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/M/g)).toHaveLength(1);
  });
  it('breaks at the antimeridian instead of crossing the whole map', () => {
    const wide = makeProjection(1000, 600, [[-180, -50], [180, 70]]);
    const d = arcPath((pt) => wide(pt) as [number, number], [150, -33], [-122, 37], 1000);
    expect(d.match(/M/g)!.length).toBeGreaterThan(1);
  });
  it('bows the sandbox curve upward', () => {
    expect(screenCurve([0, 500], [400, 300])).toMatch(/^M0.0,500.0Q200.0,200.0 400.0,300.0$/);
  });
  it('scales width by the square root of bytes', () => {
    expect(strokeWidth(0, 100)).toBe(1);
    expect(strokeWidth(100, 100)).toBe(3.5);
    expect(strokeWidth(25, 100)).toBe(2.25);
  });
});

describe('what goes where', () => {
  const ds = [
    dest('arxiv.org:443', { geo: SF, state: 'active', bytesDown: 900 }),
    dest('export.arxiv.org:443', { geo: SF, bytesDown: 100, lastSeen: 5 }),
    dest('en.wikipedia.org:443', { geo: AMS, bytesDown: 50 }),
    dest('duckduckgo.com:443', { geo: null, lastSeen: 9 }),
    dest('llm.lan:8080', { geo: null, scope: 'local' }),
    dest('169.254.169.254:80', { geo: null, scope: 'local', state: 'guard' }),
    dest('tracker.example:443', { geo: SF, state: 'user_rule' }),
    dest('api.github.com:443', { geo: AMS, scope: 'direct' }),
  ];
  it('maps located, non-local destinations that left', () => {
    expect(ds.filter(isMappable).map((d) => d.key)).toEqual(['arxiv.org:443', 'export.arxiv.org:443', 'en.wikipedia.org:443', 'api.github.com:443']);
  });
  it('puts the rest that left in Unknown location, never local links or refusals', () => {
    expect(unknownLocation(ds).map((d) => d.key)).toEqual(['duckduckgo.com:443']);
  });
  it('clusters by city, busiest first, carrying live and direct', () => {
    const cs = clusterDestinations(ds);
    expect(cs.map((c) => [c.label, c.dests.length, c.live, c.direct])).toEqual([
      ['San Francisco', 2, true, false], ['Amsterdam', 2, false, true],
    ]);
  });
});

describe('the trunk', () => {
  const exit = (over: Partial<ExitRecord> = {}): ExitRecord => ({
    v: 1, type: 'exit', t: 't', env: 'e', session: 'e', kind: 'vpn', ip: '195.1.1.1', country: 'Switzerland', city: 'Zurich',
    lat: 47.37, lon: 8.54, source: 'via-proxy:am.i.mullvad.net', healthy: true, ...over,
  });
  it('is solid to a verified exit', () => {
    expect(trunkFor(gate(), exit())).toEqual({ kind: 'verified', exit: [8.54, 47.37], label: 'Exit · Zurich' });
  });
  it('is dashed, with no pin, when the route is only declared', () => {
    expect(trunkFor(gate({ route: { kind: 'vpn', verified: false, exitIdentityOff: true, upstreamHealthy: true } }), null)).toEqual({ kind: 'declared', exit: null, label: null });
    expect(trunkFor(gate({ route: { kind: 'vpn', verified: false, exitIdentityOff: false, upstreamHealthy: true } }), exit({ healthy: false, lat: null, lon: null })).kind).toBe('declared');
  });
  it('is absent for a direct or point-to-point route', () => {
    expect(trunkFor(gate({ route: { kind: 'direct', verified: false, exitIdentityOff: true, upstreamHealthy: true } }), null).kind).toBe('none');
    expect(trunkFor(gate({ route: { kind: 'tcp', verified: false, exitIdentityOff: true, upstreamHealthy: true } }), null).kind).toBe('none');
  });
});

describe('the ribbon', () => {
  const T = 1_000_000;
  it('lays out the last 60 s, open flows running to now', () => {
    const { lanes, more } = ribbonLanes([
      flow('old', { tOpen: T - 120_000, tClose: T - 90_000, phase: 'close', lastT: T - 90_000 }),
      flow('a', { tOpen: T - 30_000, tClose: T - 15_000, phase: 'close', lastT: T - 15_000, state: 'finished' }),
      flow('b', { tOpen: T - 70_000, phase: 'update', lastT: T }),
    ], T);
    expect(more).toBe(0);
    expect(lanes.map((l) => [l.id, +l.x0.toFixed(2), +l.x1.toFixed(2), l.open])).toEqual([['b', 0, 1, true], ['a', 0.5, 0.75, false]]);
  });
  it('caps the lanes and counts the rest', () => {
    const flows = Array.from({ length: 30 }, (_, i) => flow(`f${i}`, { tOpen: T - 1000 + i, lastT: T }));
    const r = ribbonLanes(flows, T, 24);
    expect([r.lanes.length, r.more, r.lanes[23].id]).toEqual([24, 6, 'f29']);
  });
});

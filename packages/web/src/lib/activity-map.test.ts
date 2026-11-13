import { describe, expect, it } from 'vitest';
import { aside, edge, lanes, layoutMap, legPath, MIN_SIZE, spoke, spokeWidth, wear, type MapLayout, type Point } from './activity-map.js';
import { STATION_IDS } from './station.js';

const SIZE = { width: 520, height: 400 };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** A point's place on the ring's ellipse: 0 at the core, 1 on the ring. */
const share = (l: MapLayout, p: Point) => Math.hypot((p.x - l.core.x) / l.rx, (p.y - l.core.y) / l.ry);

function curve(d: string): Point[] {
  const [x0, y0, cx, cy, x1, y1] = d.replace(/[MQ]/g, ' ').trim().split(/\s+/).map(Number);
  return Array.from({ length: 41 }, (_, k) => {
    const t = k / 40;
    const u = 1 - t;
    return { x: u * u * x0 + 2 * u * t * cx + t * t * x1, y: u * u * y0 + 2 * u * t * cy + t * t * y1 };
  });
}

describe('layoutMap', () => {
  it('puts the first station at the top and the rest clockwise', () => {
    const l = layoutMap(STATION_IDS, SIZE);
    expect(l.stations.map((s) => s.id)).toEqual(STATION_IDS);
    expect(l.stations[0]).toMatchObject({ x: l.core.x, angle: 0 });
    expect(l.stations[0].y).toBeLessThan(l.core.y);
    expect(l.stations[1].x).toBeGreaterThan(l.core.x);
    expect(l.stations[l.stations.length - 1].x).toBeLessThan(l.core.x);
  });

  it('keeps every node and label inside the box, and labels away from the ring', () => {
    for (const n of [1, 3, 5, 7, 10, 12]) {
      const l = layoutMap(Array.from({ length: n }, (_, i) => `s${i}`), SIZE);
      for (const s of l.stations) {
        expect(s.x - l.node).toBeGreaterThanOrEqual(0);
        expect(s.x + l.node).toBeLessThanOrEqual(l.width);
        expect(s.y - l.node).toBeGreaterThanOrEqual(0);
        expect(s.y + l.node).toBeLessThanOrEqual(l.height);
        expect(s.label.x).toBeGreaterThanOrEqual(0);
        expect(s.label.x).toBeLessThanOrEqual(l.width);
        expect(s.label.y).toBeGreaterThanOrEqual(0);
        expect(s.label.y).toBeLessThanOrEqual(l.height);
        expect(dist(s.label, s)).toBeGreaterThan(l.node);
        expect(share(l, s.label)).toBeGreaterThan(1);
      }
    }
  });

  it('leaves a side label room for a station name (about 50 px at the map\'s font)', () => {
    for (const n of [5, 10, 12]) {
      const l = layoutMap(Array.from({ length: n }, (_, i) => `s${i}`), SIZE);
      for (const s of l.stations) {
        if (s.label.anchor === 'start') expect(l.width - s.label.x).toBeGreaterThanOrEqual(50);
        if (s.label.anchor === 'end') expect(s.label.x).toBeGreaterThanOrEqual(50);
      }
    }
  });

  it('runs a side label away from the ring, and centres one above or below', () => {
    const l = layoutMap(['top', 'right', 'bottom', 'left'], SIZE);
    expect(l.stations.map((s) => s.label.anchor)).toEqual(['middle', 'start', 'middle', 'end']);
  });

  it('never lets two nodes touch, at any count a session has', () => {
    for (let n = 2; n <= 14; n++) {
      const l = layoutMap(Array.from({ length: n }, (_, i) => `s${i}`), SIZE);
      for (let i = 0; i < n; i++) {
        expect(dist(l.stations[i], l.stations[(i + 1) % n])).toBeGreaterThan(2 * l.node);
      }
    }
  });

  it('lays out a box smaller than the least at the least', () => {
    const l = layoutMap(STATION_IDS, { width: 100, height: 50 });
    expect([l.width, l.height]).toEqual([MIN_SIZE.width, MIN_SIZE.height]);
  });
});

describe('wear and spokeWidth', () => {
  it('starts at nothing, grows by the log, and is full at 127', () => {
    expect(wear(0)).toBe(0);
    expect(wear(1)).toBeCloseTo(1 / 7);
    expect(wear(127)).toBe(1);
    expect(wear(100_000)).toBe(1);
    for (let c = 1; c < 200; c++) expect(wear(c)).toBeGreaterThanOrEqual(wear(c - 1));
    expect(wear(10) / wear(1000)).toBeGreaterThan(0.3); // a station used 100 times less still shows
  });

  it('gives an unused spoke a hairline and a worn one at most 3.6', () => {
    expect(spokeWidth(0)).toBe(1);
    expect(spokeWidth(1e6)).toBe(3.6);
  });
});

describe('spoke', () => {
  it("runs from the core's rim to the station's rim", () => {
    const l = layoutMap(STATION_IDS, SIZE);
    for (const s of l.stations) {
      const sp = spoke(l, s.id)!;
      expect(dist(sp.from, l.core)).toBeCloseTo(l.hub, 0);
      expect(dist(sp.to, s)).toBeCloseTo(l.node, 0);
    }
    expect(spoke(l, 'nowhere')).toBeUndefined();
  });
});

describe('legPath', () => {
  it('curves through the room between the core and the ring for every pair, ending on the rims', () => {
    for (const n of [4, 5, 7, 10, 12]) {
      const l = layoutMap(Array.from({ length: n }, (_, i) => `s${i}`), SIZE);
      for (const a of l.stations) {
        for (const b of l.stations) {
          if (a === b) continue;
          const leg = legPath(l, a.id, b.id)!;
          expect(dist(leg.start, a)).toBeCloseTo(l.node + 4, 0);
          expect(dist(leg.end, b)).toBeCloseTo(l.node + 4, 0);
          for (const p of curve(leg.d)) {
            // Clear of the core, and inside the ring, where no label is.
            expect(dist(p, l.core)).toBeGreaterThan(l.hub + 4);
            expect(share(l, p)).toBeLessThan(1);
          }
        }
      }
    }
  });

  it('has no leg from a station to itself or to one not on the map', () => {
    const l = layoutMap(STATION_IDS, SIZE);
    expect(legPath(l, 'files', 'files')).toBeUndefined();
    expect(legPath(l, 'files', 'nowhere')).toBeUndefined();
  });
});

describe('lanes and aside', () => {
  it('centres the lanes on the spoke, a lane apart', () => {
    expect(lanes(0)).toEqual([]);
    expect(lanes(1)).toEqual([0]);
    expect(lanes(3)).toEqual([-5, 0, 5]);
    expect(lanes(2, 4)).toEqual([-2, 2]);
  });

  it('moves a line sideways by the offset, keeping its direction', () => {
    const [a, b] = aside({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(a).toEqual({ x: 0, y: 5 });
    expect(b).toEqual({ x: 10, y: 5 });
  });

  it('finds where a line leaves a circle', () => {
    expect(edge({ x: 0, y: 0 }, { x: 0, y: 20 }, 5)).toEqual({ x: 0, y: 5 });
  });
});

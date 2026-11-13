import { describe, expect, it } from 'vitest';
import { aside, byteWear, CAP, DESCENT, edge, LABEL_WIDTH, lanes, LEG_GAP, layoutMap, legPath, MIN_SIZE, spoke, spokeWidth, wear, type MapLayout, type Point } from './activity-map.js';
import { STATION_IDS } from './station.js';

const SIZE = { width: 520, height: 400 };
const SIZES = [SIZE, MIN_SIZE];
const COUNTS = Array.from({ length: 15 }, (_, i) => i + 2); // 2..16
/** Every count at every size. */
const CASES = COUNTS.flatMap((c) => SIZES.map((z) => [c, z] as const));
const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** A point's place on the ring's ellipse: 0 at the core, 1 on the ring. */
const share = (l: MapLayout, p: Point) => Math.hypot((p.x - l.core.x) / l.rx, (p.y - l.core.y) / l.ry);

/** Points along a leg's quadratic curve. */
function curve({ start: p, bend: c, end: q }: { start: Point; bend: Point; end: Point }): Point[] {
  return Array.from({ length: 41 }, (_, k) => {
    const t = k / 40;
    const u = 1 - t;
    return { x: u * u * p.x + 2 * u * t * c.x + t * t * q.x, y: u * u * p.y + 2 * u * t * c.y + t * t * q.y };
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
    for (const [n, size] of CASES) {
      const l = layoutMap(ids(n), size);
      for (const s of l.stations) {
        expect(s.x - l.node).toBeGreaterThanOrEqual(0);
        expect(s.x + l.node).toBeLessThanOrEqual(l.width);
        expect(s.y - l.node).toBeGreaterThanOrEqual(0);
        expect(s.y + l.node).toBeLessThanOrEqual(l.height);
        expect(s.label.x).toBeGreaterThanOrEqual(0);
        expect(s.label.x).toBeLessThanOrEqual(l.width);
        // Room for a capital above the baseline and a descender below it.
        expect(s.label.y).toBeGreaterThanOrEqual(CAP);
        expect(s.label.y).toBeLessThanOrEqual(l.height - DESCENT);
        expect(dist(s.label, s)).toBeGreaterThan(l.node);
        expect(share(l, s.label)).toBeGreaterThan(1);
      }
    }
  });

  it('leaves a side label its width of room', () => {
    for (const [n, size] of CASES) {
      for (const s of layoutMap(ids(n), size).stations) {
        if (s.label.anchor === 'start') expect(size.width - s.label.x).toBeGreaterThanOrEqual(LABEL_WIDTH);
        if (s.label.anchor === 'end') expect(s.label.x).toBeGreaterThanOrEqual(LABEL_WIDTH);
      }
    }
  });

  it('never draws one label over another or over a node, at any count, at the least size too', () => {
    const box = (s: { label: Point & { anchor: string } }) => {
      const x0 = s.label.anchor === 'middle' ? s.label.x - LABEL_WIDTH / 2 : s.label.anchor === 'start' ? s.label.x : s.label.x - LABEL_WIDTH;
      return { x0, x1: x0 + LABEL_WIDTH, y0: s.label.y - CAP, y1: s.label.y + DESCENT };
    };
    const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    for (const [n, size] of CASES) {
      const l = layoutMap(ids(n), size);
      const boxes = l.stations.map(box);
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          const s = l.stations[b];
          const node = { x0: s.x - l.node, x1: s.x + l.node, y0: s.y - l.node, y1: s.y + l.node };
          expect(hit(boxes[a], node), `n=${n} ${size.width}: label ${a} on node ${b}`).toBe(false);
          if (a < b) expect(hit(boxes[a], boxes[b]), `n=${n} ${size.width}: labels ${a} and ${b}`).toBe(false);
        }
      }
    }
  });

  it('runs a side label away from the ring, and centres one above or below', () => {
    const l = layoutMap(['top', 'right', 'bottom', 'left'], SIZE);
    expect(l.stations.map((s) => s.label.anchor)).toEqual(['middle', 'start', 'middle', 'end']);
  });

  it('never lets two nodes touch, at any count a session has', () => {
    for (const [n, size] of CASES) {
      const l = layoutMap(ids(n), size);
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
  it('starts at nothing, grows by the log, and is full at 2,047', () => {
    expect(wear(0)).toBe(0);
    expect(wear(1)).toBeCloseTo(1 / 11);
    expect(wear(2047)).toBe(1);
    // A long session's busy stations still read as different widths.
    expect(spokeWidth(wear(150))).toBeLessThan(spokeWidth(wear(400)));
    expect(spokeWidth(wear(400))).toBeLessThan(spokeWidth(wear(2000)));
    expect(wear(100_000)).toBe(1);
    for (let c = 1; c < 200; c++) expect(wear(c)).toBeGreaterThanOrEqual(wear(c - 1));
    expect(wear(10) / wear(1000)).toBeGreaterThan(0.3); // a station used 100 times less still shows
  });

  it('gives an unused spoke a hairline and a worn one at most 3.6', () => {
    expect(spokeWidth(wear(0))).toBe(1);
    expect(spokeWidth(wear(1e6))).toBe(3.6);
  });
});

describe('byteWear', () => {
  it("wears a gate's spoke by the log of its bytes: a third at a kilobyte, two thirds at a megabyte, full at a gigabyte", () => {
    expect(byteWear(0)).toBe(0);
    expect(byteWear(1e3)).toBeCloseTo(1 / 3, 2);
    expect(byteWear(1e6)).toBeCloseTo(2 / 3, 2);
    expect(byteWear(1e9)).toBeCloseTo(1, 2);
    expect(byteWear(1e12)).toBe(1);
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
    for (const [n, size] of CASES) {
      const l = layoutMap(ids(n), size);
      for (const a of l.stations) {
        for (const b of l.stations) {
          if (a === b) continue;
          const leg = legPath(l, a.id, b.id)!;
          const at = `n=${n} ${size.width}: ${a.id}->${b.id}`;
          expect(leg.d, at).toBe(`M${leg.start.x} ${leg.start.y}Q${leg.bend.x} ${leg.bend.y} ${leg.end.x} ${leg.end.y}`);
          expect(dist(leg.start, a), at).toBeCloseTo(l.node + LEG_GAP, 0);
          expect(dist(leg.end, b), at).toBeCloseTo(l.node + LEG_GAP, 0);
          // Clear of the core, and inside the ring, where no label is: checked once per leg, at its
          // nearest and farthest samples.
          const points = curve(leg);
          expect(Math.min(...points.map((p) => dist(p, l.core))), at).toBeGreaterThan(l.hub + LEG_GAP);
          expect(Math.max(...points.map((p) => share(l, p))), at).toBeLessThan(1);
        }
      }
    }
  });

  it('takes the same side both ways between two stations exactly opposite', () => {
    for (const n of [2, 4, 10]) {
      const l = layoutMap(ids(n), SIZE);
      const there = legPath(l, 's0', `s${n / 2}`)!;
      const back = legPath(l, `s${n / 2}`, 's0')!;
      expect(back.bend).toEqual(there.bend);
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

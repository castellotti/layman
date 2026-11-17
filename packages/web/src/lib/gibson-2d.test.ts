import { describe, expect, it } from 'vitest';
import type { Tower } from './gibson-city.js';
import { MAX_SCALE, MIN_SCALE, corners, drawOrder, fitCam, pickTower, project, silhouette, unproject, zoomAt, type Cam } from './gibson-2d.js';

const tower = (host: string, x: number, z: number, over: Partial<Tower> = {}): Tower => ({
  host, row: {} as Tower['row'], x, z, side: 2, height: 10, tone: 'normal', blockedFraction: 0, activity: 1, fresh: false, ...over,
});
const cam: Cam = { cx: 400, cy: 300, scale: 10 };

describe('project and unproject', () => {
  it('puts the origin at the camera and a taller point higher up', () => {
    expect(project(cam, 0, 0, 0)).toEqual([400, 300]);
    expect(project(cam, 0, 5, 0)[1]).toBe(250);
  });
  it('makes a larger x + z nearer the viewer (lower on screen)', () => {
    expect(project(cam, 3, 0, 3)[1]).toBeGreaterThan(project(cam, 1, 0, 1)[1]);
  });
  it('round-trips a point on the board', () => {
    for (const [x, z] of [[0, 0], [12.5, -7], [-30, 22.25], [100, 100]]) {
      const [sx, sy] = project(cam, x, 0, z);
      const [bx, bz] = unproject(cam, sx, sy);
      expect(bx).toBeCloseTo(x, 9);
      expect(bz).toBeCloseTo(z, 9);
    }
  });
});

describe('fitCam', () => {
  it('fits every corner of the city and its tallest tower inside the box, with a margin', () => {
    const c = fitCam(40, 36, 1200, 700);
    const pts: Array<[number, number]> = [];
    for (const x of [-40, 40]) for (const z of [-40, 40]) for (const y of [0, 36]) pts.push(project(c, x, y, z));
    for (const [sx, sy] of pts) {
      expect(sx).toBeGreaterThan(0);
      expect(sx).toBeLessThan(1200);
      expect(sy).toBeGreaterThan(0);
      expect(sy).toBeLessThan(700);
    }
    // At least one dimension is within 10 % of the box: it is fitted, not just small.
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    expect(Math.max(w / 1200, h / 700)).toBeCloseTo(0.9, 1);
  });
  it('centres the picture', () => {
    const c = fitCam(40, 36, 1000, 800);
    const ys = [-40, 40].flatMap((x) => [-40, 40].flatMap((z) => [0, 36].map((y) => project(c, x, y, z)[1])));
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(400, 6);
  });
  it('clamps the scale', () => {
    expect(fitCam(100000, 36, 100, 100).scale).toBe(MIN_SCALE);
    expect(fitCam(1, 1, 5000, 5000).scale).toBe(MAX_SCALE);
  });
});

describe('zoomAt', () => {
  it('keeps the board point under the pointer where it was', () => {
    const [bx, bz] = unproject(cam, 250, 420);
    const z = zoomAt(cam, 250, 420, 1.1);
    expect(z.scale).toBeCloseTo(11, 9);
    const [sx, sy] = project(z, bx, 0, bz);
    expect(sx).toBeCloseTo(250, 9);
    expect(sy).toBeCloseTo(420, 9);
  });
  it('clamps, and keeps the point at the clamp too', () => {
    const z = zoomAt(cam, 250, 420, 1e6);
    expect(z.scale).toBe(MAX_SCALE);
    const [bx, bz] = unproject(cam, 250, 420);
    const [sx, sy] = project(z, bx, 0, bz);
    expect(sx).toBeCloseTo(250, 6);
    expect(sy).toBeCloseTo(420, 6);
    expect(zoomAt(cam, 0, 0, 1e-9).scale).toBe(MIN_SCALE);
  });
});

describe('drawOrder', () => {
  it('goes back to front: ascending x + z, ties by host, and never changes its input', () => {
    const towers = [tower('c', 5, 5), tower('a', -5, -5), tower('b', 2, 8), tower('d', 8, 2)];
    // b, c and d tie at x + z = 10, so they go by host.
    expect(drawOrder(towers).map((t) => t.host)).toEqual(['a', 'b', 'c', 'd']);
    expect(towers.map((t) => t.host)).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('silhouette', () => {
  it('is the six points of a tower: three on the base, three on the top, the top at its height', () => {
    const t = tower('a', 0, 0);
    const s = silhouette(cam, t);
    expect(s).toHaveLength(6);
    const { base, top } = corners(cam, t);
    // The top corners are the base corners lifted by height · scale.
    for (let i = 0; i < 4; i++) {
      expect(top[i][0]).toBeCloseTo(base[i][0], 9);
      expect(top[i][1]).toBeCloseTo(base[i][1] - 10 * cam.scale, 9);
    }
    // A is left of B, which is left of C; B is the lowest base corner on screen.
    expect(base[0][0]).toBeLessThan(base[1][0]);
    expect(base[1][0]).toBeLessThan(base[2][0]);
    expect(base[1][1]).toBeGreaterThan(base[0][1]);
    expect(base[1][1]).toBeGreaterThan(base[2][1]);
  });
});

describe('pickTower', () => {
  it('finds the tower under a point on its face or top, and null on empty board', () => {
    const t = tower('a', 0, 0);
    const [sx, sy] = project(cam, 0, 5, 0);
    expect(pickTower(cam, [t], sx, sy)?.host).toBe('a');
    const top = project(cam, 0, 10, 0);
    expect(pickTower(cam, [t], top[0], top[1] + 1)?.host).toBe('a');
    expect(pickTower(cam, [t], 50, 50)).toBeNull();
    // Just below the base corner B is board.
    const b = corners(cam, t).base[1];
    expect(pickTower(cam, [t], b[0], b[1] + 3)).toBeNull();
  });
  it('picks the nearer of two overlapping towers', () => {
    const far = tower('far', 0, 0, { height: 30 });
    const near = tower('near', 1.5, 1.5, { height: 8 });
    // A point on the near tower's face that the far one's silhouette also covers.
    const [sx, sy] = project(cam, 1.5, 4, 1.5);
    expect(pickTower(cam, [far, near], sx, sy)?.host).toBe('near');
    expect(pickTower(cam, [near, far], sx, sy)?.host).toBe('near');
    // High on the far tower, above the near one: the far one.
    const high = project(cam, 0, 25, 0);
    expect(pickTower(cam, [far, near], high[0], high[1])?.host).toBe('far');
  });
});

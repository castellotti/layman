import { describe, expect, it } from 'vitest';
import type { HostRow } from './gibson-feed.js';
import type { City, Tower } from './gibson-city.js';
import { paletteOf } from './gibson-schemes.js';
import { glyphIndex } from './matrix-gpu.js';
import {
  FLAG_DASHES, FLAG_OPEN, FLAG_SELECTED, FLAG_STRIPES, FLAG_WINDOWS, NOT_RISING, PAGES_W, PAGE_COLS, TOWER_STRIDE,
  aimed, between, boundOf, cityKey, forwardOf, invert, labelsOf, lookFrom, moved, multiply, overhead, packPages, packTowers,
  perspective, pickTower3d, rayThrough, rightOf, tourCam, turned, viewpointFor, type FlyCam, type Mat4,
} from './gibson-gpu.js';

const host = (over: Partial<HostRow> = {}): HostRow => ({
  host: 'a.example', block: 'example.com', count: 4, sent: 10, received: 20, blocked: 0, open: 0, ports: [443], scope: 'wan',
  untunnelled: false, services: [], tools: [], clients: [], last_seen_ago: 2, first_seen_ago: 10, ...over,
} as HostRow);
const tower = (name: string, x: number, z: number, over: Partial<Tower> = {}, row: Partial<HostRow> = {}): Tower => ({
  host: name, row: host({ host: name, ...row }), x, z, side: 2, height: 10, tone: 'normal', blockedFraction: 0, activity: 1, fresh: false, ...over,
});
const city = (towers: Tower[]): City => ({ towers, chips: [{ source: 'LOCAL', x: 0, z: 0 }], extent: 24 });
const dark = paletteOf('green', () => '');
const identity = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const apply = (m: Mat4, p: [number, number, number]): [number, number, number, number] => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
];

describe('matrices', () => {
  it('multiplies by the inverse to the identity', () => {
    const m = multiply(perspective(1, 1.6, 0.1, 500), lookFrom([3, 5, 9], 0.4, -0.3));
    const inv = invert(m);
    expect(inv).not.toBeNull();
    const id = multiply(m, inv as Mat4);
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(identity[i], 4);
  });
  it('has no inverse for a singular matrix', () => {
    expect(invert(new Float32Array(16))).toBeNull();
  });
  it('projects a point straight ahead to the centre', () => {
    const vp = multiply(perspective(1, 1.5, 0.1, 500), lookFrom([2, 3, 4], 0, 0));
    const [x, y, , w] = apply(vp, [2, 3, -20]);
    expect(x / w).toBeCloseTo(0, 5);
    expect(y / w).toBeCloseTo(0, 5);
    const [, , , w2] = apply(vp, [2, 3, 10]);
    expect(w2).toBeLessThan(0);
  });
  it('turns right when the yaw grows', () => {
    const cam: FlyCam = { pos: [0, 2, 0], yaw: Math.PI / 2, pitch: 0 };
    expect(forwardOf(cam)[0]).toBeCloseTo(1, 6);
    expect(rightOf(cam)[2]).toBeCloseTo(1, 6);
  });
});

describe('rayThrough', () => {
  it('runs along the view direction at the centre, from the camera', () => {
    const cam: FlyCam = { pos: [4, 6, 8], yaw: 0.7, pitch: -0.4 };
    const vp = multiply(perspective(1, 1.3, 0.1, 500), lookFrom(cam.pos, cam.yaw, cam.pitch));
    const { origin, dir } = rayThrough(invert(vp) as Mat4, 0, 0);
    const f = forwardOf(cam);
    for (let i = 0; i < 3; i++) expect(dir[i]).toBeCloseTo(f[i], 3);
    // The origin is on the near plane, in front of the eye.
    expect(Math.hypot(origin[0] - 4, origin[1] - 6, origin[2] - 8)).toBeCloseTo(0.1, 2);
  });
});

describe('pickTower3d', () => {
  it('hits the nearer of two towers in line, misses beside them, and hits one from above', () => {
    const near = tower('near', 0, 0);
    const far = tower('far', 0, -10);
    expect(pickTower3d([0, 5, 20], [0, 0, -1], [far, near])?.host).toBe('near');
    expect(pickTower3d([5, 5, 20], [0, 0, -1], [far, near])).toBeNull();
    const down = pickTower3d([0, 50, 0], [0, -1, 0], [near]);
    expect(down?.host).toBe('near');
    // Above the tower's top the ray passes over it.
    expect(pickTower3d([0, 50, 20], [0, 0, -1], [near])).toBeNull();
  });
});

describe('the fly camera', () => {
  const cam: FlyCam = { pos: [0, 5, 0], yaw: 0, pitch: 0 };
  it('keeps off the floor and inside the bound', () => {
    expect(moved(cam, 0, -100, 0, 50).pos[1]).toBeCloseTo(0.8, 6);
    expect(moved(cam, 0, 0, 1000, 50).pos[2]).toBe(-50);
    expect(moved(cam, 1000, 0, 0, 50).pos[0]).toBe(50);
  });
  it('moves along the view, up and sideways', () => {
    const m = moved(cam, 2, 1, 3, 100);
    expect(m.pos).toEqual([2, 6, -3]);
  });
  it('keeps the pitch off the poles', () => {
    expect(turned(cam, 0, 10).pitch).toBeLessThanOrEqual(1.5);
    expect(turned(cam, 0, -10).pitch).toBeGreaterThanOrEqual(-1.5);
  });
  it('aims at a target', () => {
    const a = aimed([0, 0, 0], [0, 0, -10]);
    expect(a.yaw).toBeCloseTo(0, 6);
    expect(a.pitch).toBeCloseTo(0, 6);
    const b = aimed([0, 0, 0], [10, 0, 0]);
    expect(forwardOf(b)[0]).toBeCloseTo(1, 6);
  });
  it('eases between two cameras, ends exact, and turns the short way across ±π', () => {
    const a: FlyCam = { pos: [0, 5, 0], yaw: 3, pitch: 0 };
    const b: FlyCam = { pos: [10, 5, 0], yaw: -3, pitch: 0.2 };
    expect(between(a, b, 0)).toEqual(a);
    expect(between(a, b, 1)).toEqual(b);
    const mid = between(a, b, 0.5);
    expect(mid.pos[0]).toBeCloseTo(5, 6);
    // Through π, not back through 0: the middle is near ±π.
    expect(Math.abs(Math.cos(mid.yaw) + 1)).toBeLessThan(0.05);
  });
  it('stands 9 units off the nearest face toward where the camera is, at reading height', () => {
    const t = tower('t', 10, 10, { height: 30, side: 2 });
    const v = viewpointFor(t, { pos: [10, 8, 60], yaw: 0, pitch: 0 });
    expect(v.pos[0]).toBeCloseTo(10, 6);
    expect(v.pos[2]).toBeCloseTo(10 + 1 + 9, 6);
    expect(v.pos[1]).toBe(10);
    const f = forwardOf(v);
    expect(f[2]).toBeCloseTo(-1, 6);
    // A low tower: the eye is 60 % of its height.
    expect(viewpointFor(tower('low', 0, 0, { height: 5 }), cam).pos[1]).toBeCloseTo(3, 6);
  });
  it('starts overhead looking down at 45°, and the tour is continuous and loops', () => {
    const o = overhead(48);
    expect(o.pitch).toBeCloseTo(-Math.PI / 4, 6);
    expect(o.pos[1]).toBeGreaterThan(48);
    const step = 0.05;
    let last = tourCam(0, 48);
    for (let t = step; t < 180; t += step) {
      const c = tourCam(t, 48);
      expect(Math.hypot(c.pos[0] - last.pos[0], c.pos[1] - last.pos[1], c.pos[2] - last.pos[2])).toBeLessThan(6);
      expect(Math.abs(Math.sin(c.yaw - last.yaw))).toBeLessThan(0.2);
      expect(c.pos[1]).toBeGreaterThanOrEqual(0.8);
      last = c;
    }
    // On a street at eye height 6..10 for part of every lap.
    const lap = tourCam(0.4 * 90, 48);
    expect(lap.pos[1]).toBeGreaterThanOrEqual(6);
    expect(lap.pos[1]).toBeLessThanOrEqual(10);
    expect(boundOf(48)).toBeGreaterThan(48);
  });
});

describe('packPages', () => {
  it('puts page 17 at column 24, row 64, and each page after its length', () => {
    const pages = Array.from({ length: 18 }, (_, i) => (i === 17 ? ['AB', '', 'C'] : ['X']));
    const { data, rows } = packPages(pages);
    expect(rows[17]).toBe(3);
    expect(rows[0]).toBe(1);
    expect(data[64 * PAGES_W + 24]).toBe(glyphIndex('A'));
    expect(data[64 * PAGES_W + 25]).toBe(glyphIndex('B'));
    expect(data[66 * PAGES_W + 24]).toBe(glyphIndex('C'));
    expect(data[0]).toBe(glyphIndex('X'));
  });
  it('upper-cases, writes `_` for what the glyph set lacks, and drops what does not fit', () => {
    const lines = Array.from({ length: 70 }, (_, i) => (i === 0 ? 'a€' : 'x'));
    const { data, rows } = packPages([lines, ['x'.repeat(30)]]);
    expect(rows[0]).toBe(64);
    expect(data[0]).toBe(glyphIndex('A'));
    expect(data[1]).toBe(glyphIndex('_'));
    // A line longer than 24 does not spill into the next page's columns.
    expect(data[PAGE_COLS * 1 + 0]).toBe(glyphIndex('X'));
    expect(data[PAGE_COLS * 2 - 1 + 0]).toBe(glyphIndex('X'));
    expect(data[(PAGE_COLS * 2) + 0]).toBe(0);
    // Row 64 would be the next page down: it holds nothing of page 0's 70th line.
    expect(data[64 * PAGES_W + 0]).toBe(0);
  });
});

describe('packTowers', () => {
  it('writes TOWER_STRIDE floats per tower and the flags for a striped, a dashed and a selected tower', () => {
    const towers = [
      tower('stripe', 0, 0, { tone: 'blocked' }), tower('dash', 3, 0, { tone: 'untunnelled' }), tower('sel', 6, 0, {}, { open: 2 }),
    ];
    const pages = new Map([['stripe', 0], ['dash', 1], ['sel', 2]]);
    const rows = new Map([['stripe', 12], ['dash', 12], ['sel', 30]]);
    const buf = packTowers(city(towers), dark, 'sel', pages, rows);
    expect(buf.length).toBe(3 * TOWER_STRIDE);
    const flags = (i: number): number => buf[i * TOWER_STRIDE + 13];
    expect(flags(0) & FLAG_STRIPES).toBe(FLAG_STRIPES);
    expect(flags(0) & FLAG_DASHES).toBe(0);
    expect(flags(1) & FLAG_DASHES).toBe(FLAG_DASHES);
    expect(flags(2) & FLAG_SELECTED).toBe(FLAG_SELECTED);
    expect(flags(2) & FLAG_OPEN).toBe(FLAG_OPEN);
    expect(flags(0) & FLAG_WINDOWS).toBe(0);
    expect(buf[0]).toBe(0);
    expect(buf[2]).toBe(2);
    expect(buf[3]).toBe(10);
    expect(buf[11]).toBe(0);
    expect(buf[2 * TOWER_STRIDE + 14]).toBe(30);
    expect(buf[15]).toBe(NOT_RISING);
    // The selected tower wears the highlight.
    expect(buf[2 * TOWER_STRIDE + 4]).toBeCloseTo(dark.highlight[0], 6);
  });
  it('marks nothing in State, where hue says it, and sets Night windows', () => {
    const state = paletteOf('state', () => '#102030');
    const buf = packTowers(city([tower('b', 0, 0, { tone: 'blocked' })]), state, null, new Map(), new Map());
    expect(buf[13]).toBe(0);
    expect(buf[11]).toBe(-1);
    const night = packTowers(city([tower('n', 0, 0)]), paletteOf('night', () => ''), null, new Map(), new Map());
    expect(night[13] & FLAG_WINDOWS).toBe(FLAG_WINDOWS);
  });
  it('gives a part-refused tower a cap of at least half a unit, and a fresh one its rise time', () => {
    const t = tower('c', 0, 0, { blockedFraction: 0.01, height: 10, fresh: true });
    const buf = packTowers(city([t]), dark, null, new Map(), new Map(), new Map([['c', 4.5]]));
    expect(buf[12]).toBeCloseTo(0.05, 6);
    expect(buf[15]).toBe(4.5);
    expect(buf[4]).toBeCloseTo(dark.fresh[0], 6);
    expect(packTowers(city([tower('d', 0, 0, { blockedFraction: 1 })]), dark, null, new Map(), new Map())[12]).toBe(0);
  });
});

describe('cityKey', () => {
  const base = (): Tower[] => [tower('a', 0, 0, { activity: 0 }, { last_seen_ago: 100 })];
  it('changes when a height changes by 0.1', () => {
    const a = cityKey(city(base()), null, 0, 's');
    const t = base();
    t[0].height += 0.1;
    expect(cityKey(city(t), null, 0, 's')).not.toBe(a);
  });
  it('does not change when only last_seen_ago does', () => {
    const a = cityKey(city(base()), null, 0, 's');
    const t = base();
    t[0].row = { ...t[0].row, last_seen_ago: 101 };
    expect(cityKey(city(t), null, 0, 's')).toBe(a);
  });
  it('changes with the selection, the log, the scheme and the set of towers', () => {
    const a = cityKey(city(base()), null, 0, 's');
    expect(cityKey(city(base()), 'a', 0, 's')).not.toBe(a);
    expect(cityKey(city(base()), null, 3, 's')).not.toBe(a);
    expect(cityKey(city(base()), null, 0, 'other')).not.toBe(a);
    expect(cityKey(city([...base(), tower('b', 3, 0)]), null, 0, 's')).not.toBe(a);
  });
});

describe('labelsOf', () => {
  const cam: FlyCam = { pos: [0, 12, 40], yaw: 0, pitch: -0.2 };
  const vp = multiply(perspective(1, 1.5, 0.1, 500), lookFrom(cam.pos, cam.yaw, cam.pitch));
  it('labels the near ones, the selected and the busiest, not what is behind or far', () => {
    const near = tower('near', 0, 0);
    const behind = tower('behind', 0, 80, {}, { count: 1 });
    const farOnes = Array.from({ length: 14 }, (_, i) => tower(`far${i}`, -300 + i, -400, {}, { count: 20 - i }));
    const labels = labelsOf(city([near, behind, ...farOnes]), cam, vp, 1200, 800, null);
    const names = labels.map((l) => l.host);
    expect(names).toContain('near');
    expect(names).not.toContain('behind');
    // The 12 busiest are wanted, but a label far off screen is not shown.
    expect(names.filter((n) => n.startsWith('far')).length).toBeLessThanOrEqual(12);
    const l = labels.find((x) => x.host === 'near');
    expect(l?.x).toBeGreaterThan(0);
    expect(l?.x).toBeLessThan(1200);
    expect(l?.opacity).toBeGreaterThan(0.5);
  });
  it('shows the selected one even from far away', () => {
    const t = tower('s', 0, -100, {}, { count: 1 });
    const filler = Array.from({ length: 14 }, (_, i) => tower(`f${i}`, 40 + i, -90, {}, { count: 50 }));
    expect(labelsOf(city([t, ...filler]), cam, vp, 1200, 800, 's').some((x) => x.host === 's' && x.opacity === 1)).toBe(true);
  });
});

/**
 * The Gibson 2D drawing's geometry: a plan-oblique projection of the city (docs/extensions/styx.md → "Gibson").
 * Pure: numbers in, numbers out; the canvas component only paints what this says and holds no rule of its own.
 *
 * A larger `x + z` is nearer the viewer. For a tower centred at (x, z) with half-side `a`, the base corners are
 * A = (x - a, z + a) (left on screen), B = (x + a, z + a) (nearest), C = (x + a, z - a) (right) and
 * D = (x - a, z - a) (hidden); the visible faces are A–B and B–C and the top is A B C D at `height`.
 */
import type { Tower } from './gibson-city.js';

/** Screen px of the world origin, and px per world unit. */
export interface Cam { cx: number; cy: number; scale: number }

/** cos 30°: the horizontal scale of the oblique view. */
export const COS = 0.866;
export const MIN_SCALE = 1.5;
export const MAX_SCALE = 60;

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function project(cam: Cam, x: number, y: number, z: number): [number, number] {
  return [cam.cx + (x - z) * COS * cam.scale, cam.cy + (x + z) * 0.5 * cam.scale - y * cam.scale];
}

/** The point on the board (y = 0) under a screen point. */
export function unproject(cam: Cam, sx: number, sy: number): [number, number] {
  const u = (sx - cam.cx) / (COS * cam.scale); // x - z
  const v = (sy - cam.cy) / (0.5 * cam.scale); // x + z
  return [(u + v) / 2, (v - u) / 2];
}

/**
 * A camera that fits the city (a square of half-side `extent`, towers up to `tallest`) in the box with a 10 %
 * margin, centred; the scale is clamped to [1.5, 60].
 */
export function fitCam(extent: number, tallest: number, width: number, height: number): Cam {
  // The square's screen width is 4 · extent · cos 30°, its height 2 · extent plus the tallest tower.
  const scale = clampScale(Math.min((width * 0.9) / (4 * extent * COS), (height * 0.9) / (2 * extent + tallest)));
  // The picture runs from -(extent + tallest) to +extent below the origin's row: centre that.
  return { cx: width / 2, cy: height / 2 + (tallest * scale) / 2, scale };
}

/** Zoom by `factor` keeping the board point under (sx, sy) where it is. */
export function zoomAt(cam: Cam, sx: number, sy: number, factor: number): Cam {
  const scale = clampScale(cam.scale * factor);
  const k = scale / cam.scale;
  return { cx: sx - (sx - cam.cx) * k, cy: sy - (sy - cam.cy) * k, scale };
}

/** Towers back to front: ascending x + z (then by host, so the order is the same on every call). */
export function drawOrder(towers: readonly Tower[]): Tower[] {
  return [...towers].sort((a, b) => a.x + a.z - (b.x + b.z) || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** A tower's base corners and top corners: A, B, C, D in the order the header describes. */
export function corners(cam: Cam, t: Tower): { base: Array<[number, number]>; top: Array<[number, number]> } {
  const a = t.side / 2;
  const at = (y: number): Array<[number, number]> => [
    project(cam, t.x - a, y, t.z + a), project(cam, t.x + a, y, t.z + a),
    project(cam, t.x + a, y, t.z - a), project(cam, t.x - a, y, t.z - a),
  ];
  return { base: at(0), top: at(t.height) };
}

/** The six screen points of a tower's outline, clockwise from the left base corner. */
export function silhouette(cam: Cam, t: Tower): Array<[number, number]> {
  const { base, top } = corners(cam, t);
  return [base[0], base[1], base[2], top[2], top[3], top[0]];
}

/** Whether (x, y) is inside a convex polygon, whichever way it winds. */
function inside(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** The front-most tower under a screen point, or null. */
export function pickTower(cam: Cam, towers: readonly Tower[], sx: number, sy: number): Tower | null {
  const order = drawOrder(towers);
  for (let i = order.length - 1; i >= 0; i--) {
    if (inside(silhouette(cam, order[i]), sx, sy)) return order[i];
  }
  return null;
}

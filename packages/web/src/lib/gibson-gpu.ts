/**
 * The GPU side of Gibson 3D, pure: matrices and the fly camera, picking, the tour, and how a city is packed into
 * the buffers and textures the shaders read (docs/extensions/styx.md → "Gibson 3D"). Numbers in, numbers out;
 * the GL component only uploads what this says. It never reads the DOM, so every rule here is tested.
 *
 * Conventions: y is up, the board is `y = 0`; yaw 0 looks toward -z and a larger yaw turns toward +x; matrices
 * are column-major, as WebGL takes them.
 */
import { glyphIndex } from './matrix-gpu.js';
import { BLOCK_PITCH, PAGE_COLUMNS, type City, type Tower } from './gibson-city.js';
import type { Palette, Rgb } from './gibson-schemes.js';

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

const TAU = Math.PI * 2;
const PITCH_LIMIT = 1.5;
/** The lowest the camera may go, and how far past the city it may wander (world units). */
export const MIN_EYE = 0.8;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const smooth = (t: number): number => { const k = clamp(t, 0, 1); return k * k * (3 - 2 * k); };

// ---------------------------------------------------------------------------------------------------------------
// Matrices

export function perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface FlyCam { pos: Vec3; yaw: number; pitch: number }

/** The direction the camera looks. */
export function forwardOf(cam: FlyCam): Vec3 {
  const cp = Math.cos(cam.pitch);
  return [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp];
}
/** Its right, level with the board. */
export function rightOf(cam: FlyCam): Vec3 {
  return [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
}

/** The view matrix of a camera at `pos` turned by `yaw` and `pitch`. */
export function lookFrom(pos: Vec3, yaw: number, pitch: number): Mat4 {
  const cam: FlyCam = { pos, yaw, pitch };
  const f = forwardOf(cam);
  const r = rightOf(cam);
  const u = cross([-f[0], -f[1], -f[2]], r);
  const m = new Float32Array(16);
  // Rows of the rotation: right, up, back (the camera looks down its own -z).
  m[0] = r[0]; m[4] = r[1]; m[8] = r[2];
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
  m[12] = -dot(r, pos);
  m[13] = -dot(u, pos);
  m[14] = dot(f, pos);
  m[15] = 1;
  return m;
}

/** `a · b`: apply `b` first. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

/** The inverse, or null when the matrix is singular. */
export function invert(m: Mat4): Mat4 | null {
  const a = Array.from(m, Number);
  const inv = new Array<number>(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return Float32Array.from(inv, (v) => v / det);
}

// ---------------------------------------------------------------------------------------------------------------
// The fly camera

/** Move by a local offset (right, up, forward along the view) in world units; y stays ≥ 0.8 and |x|, |z| ≤ bound. */
export function moved(cam: FlyCam, right: number, up: number, forward: number, bound: number): FlyCam {
  const f = forwardOf(cam);
  const r = rightOf(cam);
  const pos: Vec3 = [
    clamp(cam.pos[0] + r[0] * right + f[0] * forward, -bound, bound),
    Math.max(MIN_EYE, cam.pos[1] + up + f[1] * forward),
    clamp(cam.pos[2] + r[2] * right + f[2] * forward, -bound, bound),
  ];
  return { pos, yaw: cam.yaw, pitch: cam.pitch };
}

/** A camera at `pos` looking at `target`. */
export function aimed(pos: Vec3, target: Vec3): FlyCam {
  const dx = target[0] - pos[0];
  const dy = target[1] - pos[1];
  const dz = target[2] - pos[2];
  return { pos, yaw: Math.atan2(dx, -dz), pitch: clamp(Math.atan2(dy, Math.hypot(dx, dz)), -PITCH_LIMIT, PITCH_LIMIT) };
}

/** Ease from `a` to `b` (smoothstep on `t` in 0..1), the yaw taking the short way round. */
export function between(a: FlyCam, b: FlyCam, t: number): FlyCam {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const s = smooth(t);
  const turn = ((((b.yaw - a.yaw) % TAU) + TAU + Math.PI) % TAU) - Math.PI;
  return {
    pos: [a.pos[0] + (b.pos[0] - a.pos[0]) * s, a.pos[1] + (b.pos[1] - a.pos[1]) * s, a.pos[2] + (b.pos[2] - a.pos[2]) * s],
    yaw: a.yaw + turn * s,
    pitch: a.pitch + (b.pitch - a.pitch) * s,
  };
}

/** Turn by `dyaw` and `dpitch`, the pitch kept off the poles. */
export function turned(cam: FlyCam, dyaw: number, dpitch: number): FlyCam {
  return { pos: cam.pos, yaw: cam.yaw + dyaw, pitch: clamp(cam.pitch + dpitch, -PITCH_LIMIT, PITCH_LIMIT) };
}

/** How far from the centre the camera may wander. */
export const boundOf = (extent: number): number => extent + 60;

/** The overhead start: above the home block, looking down at 45°, high enough to see the city. */
export function overhead(extent: number): FlyCam {
  const d = extent * 1.5 + 30;
  return aimed([0, d * Math.SQRT1_2, d * Math.SQRT1_2], [0, 0, 0]);
}

/** Where to stand to read a tower: 9 units out from its nearest face toward where the camera is now, eye at min(height · 0.6, 10). */
export function viewpointFor(tower: Tower, from: FlyCam): FlyCam {
  const dx = from.pos[0] - tower.x;
  const dz = from.pos[2] - tower.z;
  const alongX = Math.abs(dx) > Math.abs(dz);
  const sign = (alongX ? dx : dz) >= 0 ? 1 : -1;
  const out = tower.side / 2 + 9;
  const eye = Math.max(1.5, Math.min(tower.height * 0.6, 10));
  const pos: Vec3 = alongX ? [tower.x + sign * out, eye, tower.z] : [tower.x, eye, tower.z + sign * out];
  return aimed(pos, [tower.x, eye, tower.z]);
}

/** Seconds a whole tour takes before it starts again. */
export const TOUR_SECONDS = 90;

/**
 * The idle tour, the camera for time `t` (seconds): from high over the home block it descends onto a street,
 * flies down it at eye height 6..10 between the towers, rises and turns, and comes round again on another street.
 * A pure function of `t`, so any moment can be asked for, and continuous across the loop.
 */
export function tourCam(t: number, extent: number): FlyCam {
  const e = Math.max(24, extent);
  const cycle = Math.floor(t / TOUR_SECONDS);
  const u = (((t % TOUR_SECONDS) + TOUR_SECONDS) % TOUR_SECONDS) / TOUR_SECONDS;
  // The street of this lap: x = 16 k + 8, k cycling over the ones inside the city.
  const reach = Math.max(1, Math.floor(e / BLOCK_PITCH));
  const k = (cycle % (2 * reach)) - reach;
  const sx = BLOCK_PITCH * k + BLOCK_PITCH / 2;
  const high: Vec3 = [0, e * 0.9 + 25, e * 1.1 + 10];
  const keys: Array<{ at: number; pos: Vec3; look: Vec3 }> = [
    { at: 0, pos: high, look: [0, 0, 0] },
    { at: 0.22, pos: [sx, 8, e], look: [sx, 6, e - 24] },
    { at: 0.62, pos: [sx, 7, -e], look: [sx, 6, -e - 24] },
    { at: 0.85, pos: [sx * 0.5, e * 0.7 + 15, -e], look: [0, 0, 0] },
    { at: 1, pos: high, look: [0, 0, 0] },
  ];
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].at) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const s = smooth((u - a.at) / (b.at - a.at));
  const mixv = (p: Vec3, q: Vec3): Vec3 => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s];
  // Along the street the eye keeps moving even between keys: the street key's look target runs ahead of it.
  const pos = mixv(a.pos, b.pos);
  const look = mixv(a.look, b.look);
  return aimed(pos, look);
}

// ---------------------------------------------------------------------------------------------------------------
// Picking

/** The ray through a point of the canvas (NDC, -1..1), from the inverse of the view-projection. */
export function rayThrough(invViewProj: Mat4, ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
  const at = (z: number): Vec3 => {
    const x = invViewProj[0] * ndcX + invViewProj[4] * ndcY + invViewProj[8] * z + invViewProj[12];
    const y = invViewProj[1] * ndcX + invViewProj[5] * ndcY + invViewProj[9] * z + invViewProj[13];
    const zz = invViewProj[2] * ndcX + invViewProj[6] * ndcY + invViewProj[10] * z + invViewProj[14];
    const w = invViewProj[3] * ndcX + invViewProj[7] * ndcY + invViewProj[11] * z + invViewProj[15];
    return [x / w, y / w, zz / w];
  };
  const near = at(-1);
  const far = at(1);
  return { origin: near, dir: norm([far[0] - near[0], far[1] - near[1], far[2] - near[2]]) };
}

/** The distance along the ray at which it enters a box, or null (a slab test per axis). */
function enters(origin: Vec3, dir: Vec3, lo: Vec3, hi: Vec3): number | null {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dir[i]) < 1e-9) {
      if (origin[i] < lo[i] || origin[i] > hi[i]) return null;
      continue;
    }
    let t1 = (lo[i] - origin[i]) / dir[i];
    let t2 = (hi[i] - origin[i]) / dir[i];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** The nearest tower the ray enters, or null. */
export function pickTower3d(origin: Vec3, dir: Vec3, towers: readonly Tower[]): Tower | null {
  let best: Tower | null = null;
  let bestT = Infinity;
  for (const t of towers) {
    const a = t.side / 2;
    const hit = enters(origin, dir, [t.x - a, 0, t.z - a], [t.x + a, t.height, t.z + a]);
    if (hit !== null && hit < bestT) { bestT = hit; best = t; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Instances

/** Floats per tower in the instance buffer. */
export const TOWER_STRIDE = 16;
export const FLAG_STRIPES = 1;
export const FLAG_DASHES = 2;
export const FLAG_WINDOWS = 4;
export const FLAG_SELECTED = 8;
/** `open > 0`: the glass pulses. */
export const FLAG_OPEN = 16;
/** Beyond the clock, a tower that is not rising has `riseAt` this far in the past. */
export const NOT_RISING = -1e4;

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * One tower per `TOWER_STRIDE` floats, the shader's per-instance data:
 *
 * `x, z, side, height | glass r g b, brightness | text r g b, page index | cap fraction, flags, page rows, riseAt`
 *
 * `brightness` is the steady part (0.35 quiet to 1 now); the pulse of an open connection and the glow of an
 * arrival are the shader's, from the clock. `riseAt` is the renderer's clock when the tower appeared (a fresh one
 * rises over 1.2 s from then), or `NOT_RISING`. A fresh tower wears the fresh colour, a selected one the highlight.
 * `pages` and `pageRows` are each host's page index and length in `packPages`' texture; a host with none draws no text.
 */
export function packTowers(
  city: City, palette: Palette, selected: string | null,
  pages: ReadonlyMap<string, number>, pageRows: ReadonlyMap<string, number>, riseAt?: ReadonlyMap<string, number>,
): Float32Array {
  const out = new Float32Array(city.towers.length * TOWER_STRIDE);
  city.towers.forEach((t, i) => {
    const sel = t.host === selected;
    const glass = sel ? palette.highlight : t.fresh ? palette.fresh : palette.glass[t.tone];
    const text = sel ? mixRgb(palette.highlight, [1, 1, 1], 0.45) : t.fresh ? palette.fresh : palette.text[t.tone];
    let flags = 0;
    if (palette.marks && t.tone === 'blocked') flags |= FLAG_STRIPES;
    if (palette.marks && t.tone === 'untunnelled') flags |= FLAG_DASHES;
    if (palette.windows) flags |= FLAG_WINDOWS;
    if (sel) flags |= FLAG_SELECTED;
    if (t.row.open > 0) flags |= FLAG_OPEN;
    const cap = t.blockedFraction > 0 && t.blockedFraction < 1 ? Math.min(1, Math.max(t.blockedFraction, 0.5 / t.height)) : 0;
    const o = i * TOWER_STRIDE;
    out.set([
      t.x, t.z, t.side, t.height,
      glass[0], glass[1], glass[2], 0.35 + 0.65 * t.activity,
      text[0], text[1], text[2], pages.get(t.host) ?? -1,
      cap, flags, pageRows.get(t.host) ?? 0, riseAt?.get(t.host) ?? NOT_RISING,
    ], o);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Text pages

/** One R8 texture of 16 × 16 pages, each 24 columns by 64 rows: 384 × 1024. */
export const PAGE_COLS = PAGE_COLUMNS;
export const PAGE_ROWS = 64;
export const PAGES_ACROSS = 16;
export const MAX_PAGES = 256;
export const PAGES_W = PAGE_COLS * PAGES_ACROSS;
export const PAGES_H = PAGE_ROWS * (MAX_PAGES / PAGES_ACROSS);

/** The glyph for a character: `_` when the set has none for it, else blank. */
function glyphOf(ch: string): number {
  const g = glyphIndex(ch);
  return g !== 0 || ch === ' ' ? g : glyphIndex('_');
}

/** Glyph indices for every page (lines beyond 64 are dropped, pages beyond 256 too), and each page's length. */
export function packPages(pages: readonly string[][]): { data: Uint8Array; rows: number[] } {
  const data = new Uint8Array(PAGES_W * PAGES_H);
  const rows: number[] = [];
  pages.slice(0, MAX_PAGES).forEach((lines, p) => {
    const x0 = (p % PAGES_ACROSS) * PAGE_COLS;
    const y0 = Math.floor(p / PAGES_ACROSS) * PAGE_ROWS;
    const n = Math.min(lines.length, PAGE_ROWS);
    rows.push(n);
    for (let r = 0; r < n; r++) {
      const line = lines[r].toUpperCase();
      for (let c = 0; c < Math.min(line.length, PAGE_COLS); c++) data[(y0 + r) * PAGES_W + x0 + c] = glyphOf(line[c]);
    }
  });
  return { data, rows };
}

/**
 * The key that says the city's GPU data must be rewritten: every field the instance buffer and the pages are
 * made of, rounded to what they show. A host's age is not in it except through `activity`, in tenths, so a
 * quiet host's poll (its `last_seen_ago` ticking on) rewrites nothing.
 */
export function cityKey(city: City, selected: string | null, logLength: number, schemeKey: string): string {
  const parts: string[] = [schemeKey, selected ?? '', String(logLength), String(city.chips.length)];
  for (const t of city.towers) {
    parts.push([
      t.host, t.x, t.z, t.side.toFixed(2), t.height.toFixed(1), t.tone, t.blockedFraction.toFixed(2), Math.round(t.activity * 10),
      t.fresh ? 1 : 0, t.row.open > 0 ? 1 : 0, t.row.count, t.row.sent, t.row.received, t.row.blocked,
    ].join(','));
  }
  for (const c of city.chips) parts.push(`${c.source},${c.x},${c.z}`);
  return parts.join('|');
}

// ---------------------------------------------------------------------------------------------------------------
// Labels

export interface Label { host: string; x: number; y: number; opacity: number }

/** The host name above a tower is shown for the 12 busiest, the selected, and every tower within this far. */
export const LABEL_NEAR = 60;
export const LABEL_BUSIEST = 12;

/** Labels to show: the 12 busiest, the selected, and every tower within 60 units; screen position (CSS px) and opacity. */
export function labelsOf(city: City, cam: FlyCam, viewProj: Mat4, width: number, height: number, selected: string | null): Label[] {
  const busiest = new Set([...city.towers].sort((a, b) => b.row.count - a.row.count || (a.host < b.host ? -1 : 1)).slice(0, LABEL_BUSIEST).map((t) => t.host));
  const out: Label[] = [];
  for (const t of city.towers) {
    const d = Math.hypot(t.x - cam.pos[0], t.height - cam.pos[1], t.z - cam.pos[2]);
    const wanted = t.host === selected || busiest.has(t.host) || d < LABEL_NEAR;
    if (!wanted) continue;
    // Above the tower's top, clip space by hand.
    const px = t.x, py = t.height + 1.2, pz = t.z;
    const cx = viewProj[0] * px + viewProj[4] * py + viewProj[8] * pz + viewProj[12];
    const cy = viewProj[1] * px + viewProj[5] * py + viewProj[9] * pz + viewProj[13];
    const cw = viewProj[3] * px + viewProj[7] * py + viewProj[11] * pz + viewProj[15];
    if (cw <= 0.1) continue;
    const nx = cx / cw;
    const ny = cy / cw;
    if (nx < -1.05 || nx > 1.05 || ny < -1.05 || ny > 1.05) continue;
    // Fades in over the near range for the ones only wanted for being near, and out with a long distance.
    const fade = 1 - smooth((d - LABEL_NEAR * 0.7) / (LABEL_NEAR * 1.6));
    const opacity = t.host === selected ? 1 : busiest.has(t.host) ? Math.max(0.55, fade) : fade;
    if (opacity <= 0.02) continue;
    out.push({ host: t.host, x: ((nx + 1) / 2) * width, y: ((1 - ny) / 2) * height, opacity });
  }
  return out;
}

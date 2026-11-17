/**
 * What Gibson 2D paints. Functions of (context, model): no state, no DOM beyond the context they are given, no
 * colour literal (every colour is the palette's). `drawCity` paints the whole city canvas and is called only
 * when something changed; `drawCars` paints the traffic canvas and is called every frame while motion is full.
 * The geometry is `lib/gibson-2d.ts` and the content `lib/gibson-city.ts`; this decides only how it looks.
 */
import { BLOCK_PITCH, CAR_TAIL, routeOf, sendsCars, spiral, type Car, type City, type Placement, type Tower } from '../../lib/gibson-city.js';
import { drawOrder, project, type Cam } from '../../lib/gibson-2d.js';
import { mix, rgbCss, type Palette, type Rgb } from '../../lib/gibson-schemes.js';
import type { LinkRow } from '../../lib/gibson-feed.js';
import { hash01 } from '../../lib/matrix-rain.js';

/** A fresh tower rises over this long (seconds). */
export const RISE_S = 1.2;
/** A host stays `fresh` this long (ms). */
export const FRESH_MS = 6000;
/** A tower a car reached brightens for this long (ms). */
export const ARRIVAL_MS = 600;
/** The text space of a face: 24 cells of 8 × 12. */
const TEXT_W = 192;
const CELL_W = 8;
const CELL_H = 12;
const BLACK: Rgb = [0, 0, 0];

export interface CityDraw {
  /** The canvas's CSS size and its pixel ratio. */
  width: number;
  height: number;
  dpr: number;
  cam: Cam;
  city: City;
  placement: Placement;
  links: readonly LinkRow[];
  pal: Palette;
  font: string;
  selected: string | null;
  /** Host → the lines its faces show. */
  pages: ReadonlyMap<string, readonly string[]>;
  now: number;
  /** Host → when it was first seen here (ms): it rises from that moment. */
  freshAt: ReadonlyMap<string, number>;
  /** Host → when a car last reached it (ms). */
  arrivedAt: ReadonlyMap<string, number>;
  /** Motion is full: towers rise, and routes are the traffic's, not dashed lines. */
  full: boolean;
}

type Pt = readonly [number, number];

function poly(ctx: CanvasRenderingContext2D, pts: readonly Pt[]): void {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

/** How tall a tower stands now, 0..1 of its height: a fresh one rises, an old one is whole. */
export function riseOf(a: Pick<CityDraw, 'now' | 'freshAt' | 'full'>, host: string): number {
  const at = a.freshAt.get(host);
  if (!a.full || at === undefined) return 1;
  return Math.max(0, Math.min(1, (a.now - at) / 1000 / RISE_S));
}

/** 1 just after a car reached the tower, falling to 0. */
export function arrivalOf(a: Pick<CityDraw, 'now' | 'arrivedAt'>, host: string): number {
  const at = a.arrivedAt.get(host);
  return at === undefined ? 0 : Math.max(0, 1 - (a.now - at) / ARRIVAL_MS);
}

/** On-screen height of one text cell of a tower's face, in px. */
export const cellPx = (cam: Cam, t: Pick<Tower, 'side'>): number => (CELL_H * (t.side / TEXT_W) * cam.scale);

function streets(ctx: CanvasRenderingContext2D, a: CityDraw): void {
  const { cam, pal } = a;
  const e = a.city.extent + BLOCK_PITCH;
  const k0 = Math.ceil((-e - BLOCK_PITCH / 2) / BLOCK_PITCH);
  const k1 = Math.floor((e - BLOCK_PITCH / 2) / BLOCK_PITCH);
  const offsets = [-1.6, -0.8, 0, 0.8, 1.6];
  for (const [which, colour] of [[0, pal.traceA], [1, pal.traceB]] as const) {
    ctx.beginPath();
    for (let k = k0; k <= k1; k++) {
      const c = k * BLOCK_PITCH + BLOCK_PITCH / 2;
      offsets.forEach((o, i) => {
        if (i % 2 !== which) return;
        const [ax, ay] = project(cam, -e, 0, c + o);
        const [bx, by] = project(cam, e, 0, c + o);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        const [cx, cy] = project(cam, c + o, 0, -e);
        const [dx, dy] = project(cam, c + o, 0, e);
        ctx.moveTo(cx, cy);
        ctx.lineTo(dx, dy);
      });
    }
    // Night's streets are lines of lit points, not lines.
    if (pal.windows) ctx.setLineDash([1, 6]);
    ctx.strokeStyle = rgbCss(colour, pal.windows ? 0.8 : 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

const snap = (v: number): number => Math.round(v * 2) / 2;
const within = (v: number): number => Math.max(-6, Math.min(6, v));

/**
 * The decoration of a block with towers (and of home): twelve short right-angle traces and four pads, all from
 * a hash of the block's id, so it is the same at every redraw and for every viewer.
 */
function blockTraces(ctx: CanvasRenderingContext2D, a: CityDraw): void {
  const { cam, pal } = a;
  const blocks: Array<[string, number]> = [['home', 0], ...a.placement.blocks];
  for (const [which, colour] of [[0, pal.traceA], [1, pal.traceB]] as const) {
    ctx.beginPath();
    for (const [id, slot] of blocks) {
      const [bx, bz] = spiral(slot);
      const ox = bx * BLOCK_PITCH;
      const oz = bz * BLOCK_PITCH;
      const h = (n: number, part: string): number => hash01(`${id}:${n}:${part}`);
      const at = (x: number, z: number): [number, number] => project(cam, ox + x, 0, oz + z);
      for (let n = 0; n < 12; n++) {
        if (n % 2 !== which) continue;
        const x0 = snap((h(n, 'x') - 0.5) * 10);
        const z0 = snap((h(n, 'z') - 0.5) * 10);
        const l1 = snap(1 + h(n, 'a') * 4) * (h(n, 'sa') < 0.5 ? -1 : 1);
        const l2 = snap(1 + h(n, 'b') * 4) * (h(n, 'sb') < 0.5 ? -1 : 1);
        const alongX = h(n, 'o') < 0.5;
        const p1: [number, number] = alongX ? [within(x0 + l1), z0] : [x0, within(z0 + l1)];
        const p2: [number, number] = alongX ? [p1[0], within(p1[1] + l2)] : [within(p1[0] + l2), p1[1]];
        const s0 = at(x0, z0);
        const s1 = at(p1[0], p1[1]);
        const s2 = at(p2[0], p2[1]);
        ctx.moveTo(s0[0], s0[1]);
        ctx.lineTo(s1[0], s1[1]);
        ctx.lineTo(s2[0], s2[1]);
      }
      for (let n = 12; n < 16; n++) {
        if (n % 2 !== which) continue;
        const px = snap((h(n, 'x') - 0.5) * 10);
        const pz = snap((h(n, 'z') - 0.5) * 10);
        poly(ctx, [at(px, pz), at(px + 0.5, pz), at(px + 0.5, pz + 0.3), at(px, pz + 0.3)]);
      }
    }
    ctx.strokeStyle = rgbCss(colour, 0.35);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Each active link's route as a dashed line: what stands in for the cars when nothing moves. */
function routes(ctx: CanvasRenderingContext2D, a: CityDraw): void {
  const towers = new Map(a.city.towers.map((t) => [t.host, t]));
  const chips = new Map(a.city.chips.map((c) => [c.source, c]));
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const l of a.links) {
    const tower = towers.get(l.target);
    const chip = chips.get(l.source);
    if (!tower || !chip || !sendsCars(l)) continue;
    const pts = routeOf([chip.x, chip.z], [tower.x, tower.z]).map(([x, z]) => project(a.cam, x, 0, z));
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = rgbCss(a.pal.traffic ?? a.pal.glass[tower.tone], 0.4);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

function chips(ctx: CanvasRenderingContext2D, a: CityDraw): void {
  const { cam, pal } = a;
  const fill = rgbCss(mix(pal.board, BLACK, 0.55));
  for (const c of a.city.chips) {
    const h = 0.6;
    const at = (dx: number, dz: number, y: number): Pt => project(cam, c.x + dx, y, c.z + dz);
    const [A0, B0, C0] = [at(-1, 1, 0), at(1, 1, 0), at(1, -1, 0)];
    const [A1, B1, C1, D1] = [at(-1, 1, h), at(1, 1, h), at(1, -1, h), at(-1, -1, h)];
    ctx.fillStyle = fill;
    ctx.beginPath();
    poly(ctx, [A0, B0, B1, A1]);
    poly(ctx, [B0, C0, C1, B1]);
    poly(ctx, [A1, B1, C1, D1]);
    ctx.fill();
    ctx.strokeStyle = rgbCss(pal.homeRim, 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    poly(ctx, [A1, B1, C1, D1]);
    ctx.moveTo(A0[0], A0[1]); ctx.lineTo(A1[0], A1[1]);
    ctx.moveTo(B0[0], B0[1]); ctx.lineTo(B1[0], B1[1]);
    ctx.moveTo(C0[0], C0[1]); ctx.lineTo(C1[0], C1[1]);
    ctx.stroke();
    // Pins: four short ticks along each of the two near base edges.
    ctx.strokeStyle = rgbCss(pal.homeRim, 0.7);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = at(-0.75 + 0.5 * i, 1, 0);
      const [bx, by] = at(-0.75 + 0.5 * i, 1.5, 0);
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
      const [cx, cy] = at(1, 0.75 - 0.5 * i, 0);
      const [dx, dy] = at(1.5, 0.75 - 0.5 * i, 0);
      ctx.moveTo(cx, cy); ctx.lineTo(dx, dy);
    }
    ctx.stroke();
  }
}

/** Diagonal stripes, 6 px apart, over `shapes` only (the film schemes' mark for a refused tower). */
function stripes(ctx: CanvasRenderingContext2D, shapes: readonly (readonly Pt[])[], colour: string): void {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const s of shapes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  ctx.save();
  ctx.beginPath();
  for (const s of shapes) poly(ctx, s);
  ctx.clip();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = x0 - (y1 - y0); d < x1; d += 6) { ctx.moveTo(d, y1); ctx.lineTo(d + (y1 - y0), y0); }
  ctx.stroke();
  ctx.restore();
}

/** One face's text: the page, or one bar a line when a cell is too small to read, or lit windows (Night). */
function faceText(
  ctx: CanvasRenderingContext2D, a: CityDraw, t: Tower, h: number, p0: readonly [number, number], p1: readonly [number, number],
  lines: readonly string[], colour: Rgb, alpha: number, faceId: string,
): void {
  const { cam, dpr, pal } = a;
  const px = cellPx(cam, t);
  const k = t.side / TEXT_W;
  const [x0, y0] = project(cam, p0[0], h, p0[1]);
  const [x1, y1] = project(cam, p1[0], h, p1[1]);
  const rows = Math.min(Math.ceil(h / (CELL_H * k)), 4000);
  // The rows that can be on screen: row r starts at y0 + r · px and the face's slant adds up to (y1 - y0).
  const slant = y1 - y0;
  const first = Math.max(0, Math.floor((-px - y0 - Math.max(0, slant)) / px));
  const last = Math.min(rows - 1, Math.ceil((a.height - y0 - Math.min(0, slant)) / px));
  if (last < first) return;
  ctx.setTransform(dpr * (x1 - x0) / TEXT_W, dpr * (y1 - y0) / TEXT_W, 0, dpr * cam.scale * k, dpr * x0, dpr * y0);
  ctx.fillStyle = rgbCss(colour, alpha);
  const readable = px >= 6;
  if (readable) { ctx.font = `11px ${a.font}`; ctx.textBaseline = 'top'; }
  // Night's lit windows stand in for text at every zoom that cannot read it: grouped, so they stay a few px apart.
  const rowStep = pal.windows && !readable ? Math.max(1, Math.ceil(4 / px)) : 1;
  const colPx = (Math.hypot(x1 - x0, y1 - y0) / TEXT_W) * CELL_W;
  const colStep = pal.windows && !readable ? Math.max(1, Math.ceil(3 / Math.max(colPx, 0.01))) : 1;
  for (let r = first - (first % rowStep); r <= last; r += rowStep) {
    if (pal.windows && !readable) {
      for (let c = 0; c < TEXT_W / CELL_W; c += colStep) {
        if (hash01(`${t.host}:${faceId}:${r}:${c}`) < 0.3) ctx.fillRect(c * CELL_W + 1, r * CELL_H + 3, 5 * colStep, 6 * rowStep);
      }
      continue;
    }
    const line = lines[r % lines.length];
    if (!line) continue;
    if (readable) ctx.fillText(line, 0, r * CELL_H);
    else ctx.fillRect(0, r * CELL_H + 3, line.length * CELL_W, 6);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function towerOf(ctx: CanvasRenderingContext2D, a: CityDraw, t: Tower): void {
  const { cam, pal } = a;
  const rise = riseOf(a, t.host);
  const h = t.height * rise;
  if (h < 0.05) return;
  const shown: Tower = h === t.height ? t : { ...t, height: h };
  const half = t.side / 2;
  /** The four corners (A, B, C, D) at height `y`. */
  const ring = (y: number): Pt[] => [
    project(cam, t.x - half, y, t.z + half), project(cam, t.x + half, y, t.z + half),
    project(cam, t.x + half, y, t.z - half), project(cam, t.x - half, y, t.z - half),
  ];
  const base = ring(0);
  const top = ring(h);
  // Off screen: nothing to paint.
  const xs = [...base, ...top].map((p) => p[0]);
  const ys = [...base, ...top].map((p) => p[1]);
  if (Math.max(...xs) < 0 || Math.min(...xs) > a.width || Math.max(...ys) < 0 || Math.min(...ys) > a.height) return;

  const sel = t.host === a.selected;
  const lit = Math.max(t.activity, arrivalOf(a, t.host));
  const glass = sel ? pal.highlight : t.fresh ? pal.fresh : pal.glass[t.tone];
  // Night's glass is nearly black, so its edges are drawn halfway to the window colour or the tower would vanish.
  const edge = sel ? pal.highlight : t.fresh ? pal.fresh : pal.windows ? mix(pal.glass[t.tone], pal.text[t.tone], 0.5) : pal.glass[t.tone];
  const boost = pal.light ? 1.6 : 1;
  const [A0, B0, C0] = base;

  // The body, then (when part of its connections were refused) a cap in the blocked colour.
  const split = t.tone !== 'blocked' && t.blockedFraction > 0 ? h * (1 - t.blockedFraction) : h;
  const segments: Array<{ y0: number; y1: number; colour: Rgb; last: boolean }> = [{ y0: 0, y1: split, colour: glass, last: split === h }];
  if (split < h) segments.push({ y0: split, y1: h, colour: sel ? glass : pal.glass.blocked, last: true });
  ctx.globalCompositeOperation = pal.light ? 'source-over' : 'lighter';
  for (const s of segments) {
    const [a0, b0, c0] = ring(s.y0);
    const [a1, b1, c1, d1] = ring(s.y1);
    ctx.fillStyle = rgbCss(s.colour, Math.min(1, (0.1 + 0.14 * lit) * boost));
    ctx.beginPath();
    poly(ctx, [a0, b0, b1, a1]);
    poly(ctx, [b0, c0, c1, b1]);
    ctx.fill();
    if (s.last) {
      ctx.fillStyle = rgbCss(s.colour, Math.min(1, (0.2 + 0.28 * lit) * boost));
      ctx.beginPath();
      poly(ctx, [a1, b1, c1, d1]);
      ctx.fill();
    }
    if (pal.marks && s.colour === pal.glass.blocked && s.y0 > 0) stripes(ctx, [[a0, b0, b1, a1], [b0, c0, c1, b1]], rgbCss(s.colour, 0.6));
  }
  ctx.globalCompositeOperation = 'source-over';

  // Face text, or stripes on a refused tower where the scheme speaks in marks.
  const faceA: [[number, number], [number, number]] = [[t.x - half, t.z + half], [t.x + half, t.z + half]];
  const faceB: [[number, number], [number, number]] = [[t.x + half, t.z + half], [t.x + half, t.z - half]];
  const refused = pal.marks && t.tone === 'blocked';
  if (refused) {
    stripes(ctx, [[A0, B0, top[1], top[0]], [B0, C0, top[2], top[1]]], rgbCss(pal.glass.blocked, 0.7));
  } else if (cellPx(cam, t) >= 3 || pal.windows) {
    const textColour = pal.text[t.tone];
    const alpha = 0.5 + 0.4 * lit;
    const lines = a.pages.get(t.host) ?? [];
    if (lines.length > 0 || pal.windows) {
      faceText(ctx, a, shown, h, faceA[0], faceA[1], lines, textColour, alpha, 'A');
      faceText(ctx, a, shown, h, faceB[0], faceB[1], lines, textColour, alpha, 'B');
    }
  }

  // Edges.
  ctx.strokeStyle = rgbCss(edge, sel ? 1 : 0.5 + 0.5 * lit);
  ctx.lineWidth = sel ? 1.5 : 1;
  if (pal.marks && t.tone === 'untunnelled') ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(A0[0], A0[1]); ctx.lineTo(B0[0], B0[1]); ctx.lineTo(C0[0], C0[1]);
  for (let i = 0; i < 3; i++) { ctx.moveTo(base[i][0], base[i][1]); ctx.lineTo(top[i][0], top[i][1]); }
  poly(ctx, top);
  if (split < h) { const m = ring(split); ctx.moveTo(m[0][0], m[0][1]); ctx.lineTo(m[1][0], m[1][1]); ctx.lineTo(m[2][0], m[2][1]); }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** The place a glow sits and its size: a circle on the board is an axis-aligned ellipse in this projection. */
function glow(ctx: CanvasRenderingContext2D, a: CityDraw, t: Tower): void {
  const [sx, sy] = project(a.cam, t.x, 0, t.z);
  const r = t.side * 1.2;
  ctx.fillStyle = rgbCss(a.pal.glass[t.tone], 0.18);
  ctx.beginPath();
  ctx.ellipse(sx, sy, r * 1.2247 * a.cam.scale, r * 0.7071 * a.cam.scale, 0, 0, Math.PI * 2);
  ctx.fill();
}

interface Box { x0: number; y0: number; x1: number; y1: number }
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** The host above each tower, upper-case: the busiest 12, the selected one, and all of them once close enough to read. */
function labels(ctx: CanvasRenderingContext2D, a: CityDraw): void {
  const { cam, pal } = a;
  ctx.font = `10px ${a.font}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '1px';
  const drawn: Box[] = [];
  const put = (text: string, x: number, y: number, colour: Rgb): void => {
    const w = ctx.measureText(text).width;
    const box: Box = { x0: x - w / 2 - 2, y0: y - 12, x1: x + w / 2 + 2, y1: y + 2 };
    if (box.x1 < 0 || box.x0 > a.width || box.y1 < 0 || box.y0 > a.height) return;
    if (drawn.some((b) => overlaps(b, box))) return;
    drawn.push(box);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgbCss(pal.board, 0.8);
    ctx.strokeText(text, x, y);
    ctx.fillStyle = rgbCss(colour, 1);
    ctx.fillText(text, x, y);
  };
  const clip = (s: string): string => (s.length > 28 ? `${s.slice(0, 27)}…` : s);
  const labelColour = (t: Tower): Rgb => (t.host === a.selected ? pal.highlight : pal.text[t.tone]);
  const byBusiest = [...a.city.towers].sort((x, y) => y.row.count - x.row.count || (x.host < y.host ? -1 : 1));
  const top = new Set(byBusiest.slice(0, 12).map((t) => t.host));
  const sel = a.city.towers.find((t) => t.host === a.selected);
  const place = (t: Tower): void => {
    const [sx, sy] = project(cam, t.x, t.height * riseOf(a, t.host), t.z);
    put(clip(t.host.toUpperCase()), sx, sy - 5, labelColour(t));
  };
  if (sel) place(sel);
  for (const c of a.city.chips) {
    const [sx, sy] = project(cam, c.x, 0.6, c.z);
    put(clip(c.source.toUpperCase()), sx, sy - 5, pal.homeRim);
  }
  for (const t of byBusiest) if (t !== sel && (top.has(t.host) || cellPx(cam, t) >= 3)) place(t);
  ctx.textAlign = 'start';
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
}

/** The whole city canvas. */
export function drawCity(ctx: CanvasRenderingContext2D, a: CityDraw): void {
  const { pal } = a;
  ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.fillStyle = rgbCss(pal.board);
  ctx.fillRect(0, 0, a.width, a.height);
  streets(ctx, a);
  blockTraces(ctx, a);
  if (!a.full) routes(ctx, a);
  ctx.globalCompositeOperation = pal.light ? 'source-over' : 'lighter';
  for (const t of a.city.towers) glow(ctx, a, t);
  ctx.globalCompositeOperation = 'source-over';
  chips(ctx, a);
  for (const t of drawOrder(a.city.towers)) towerOf(ctx, a, t);
  labels(ctx, a);
}

/** The traffic canvas: each car a short streak that fades behind it; a refused one flashes where it stops. */
export function drawCars(
  ctx: CanvasRenderingContext2D,
  a: { width: number; height: number; dpr: number; cam: Cam; pal: Palette; cars: readonly Car[] },
): void {
  const { cam, pal } = a;
  ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
  ctx.clearRect(0, 0, a.width, a.height);
  ctx.globalCompositeOperation = pal.light ? 'source-over' : 'lighter';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (const c of a.cars) {
    const [hx, hy] = project(cam, c.x, 0.15, c.z);
    const [tx, ty] = project(cam, c.x - c.dx * CAR_TAIL, 0.15, c.z - c.dz * CAR_TAIL);
    if ((hx < 0 && tx < 0) || (hx > a.width && tx > a.width) || (hy < 0 && ty < 0) || (hy > a.height && ty > a.height)) continue;
    const colour = pal.traffic ?? pal.glass[c.tone];
    const g = ctx.createLinearGradient(hx, hy, tx, ty);
    g.addColorStop(0, rgbCss(colour, 1));
    g.addColorStop(1, rgbCss(colour, 0));
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    if (c.flash > 0) {
      ctx.fillStyle = rgbCss(pal.marks ? pal.fresh : pal.glass.blocked, c.flash);
      ctx.beginPath();
      ctx.arc(hx, hy, 3 + 6 * (1 - c.flash), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * The Map's geometry, pure so it is tested
 * in node: the projection, great-circle arcs, city clusters, the trunk from the
 * sandbox card to the exit, what goes to "Unknown location", and the 60 s
 * ribbon's lanes. `components/network/WorldMap.tsx` only draws.
 *
 * Everything placed on the map came from the user's own offline database
 * (`DestinationAggregate.geo`) or from exit.ndjson; nothing here looks anything
 * up. The sandbox is deliberately not a place: it is a card in a corner, so the
 * map never implies where the operator is.
 */
import { geoInterpolate, geoMercator, type GeoProjection } from 'd3-geo';
import type { DestinationAggregate, ExitRecord, FlowView, NetGateView } from './netobs-types.js';
import { BLOCK_STATES } from './net-format.js';

/** Mercator is useless near the poles: clip to about 84°N–58°S. */
export const LAT_MAX = 84;
export const LAT_MIN = -58;
/** With nothing to fit, a North-Atlantic view. */
const DEFAULT_BOUNDS: [[number, number], [number, number]] = [[-100, 20], [35, 62]];
/** The smallest span fitted, so one destination does not zoom to street level. */
const MIN_SPAN: [number, number] = [50, 25];

export type LonLat = [number, number];

/** The bounding box of the points, widened to at least MIN_SPAN, or the default view. */
export function fitBounds(points: readonly LonLat[]): [[number, number], [number, number]] {
  if (!points.length) return DEFAULT_BOUNDS;
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of points) {
    w = Math.min(w, lon); e = Math.max(e, lon);
    s = Math.min(s, lat); n = Math.max(n, lat);
  }
  const grow = (lo: number, hi: number, min: number): [number, number] => {
    const span = hi - lo;
    if (span >= min) return [lo, hi];
    const pad = (min - span) / 2;
    return [lo - pad, hi + pad];
  };
  [w, e] = grow(w, e, MIN_SPAN[0]);
  [s, n] = grow(s, n, MIN_SPAN[1]);
  return [[Math.max(-180, w), Math.max(LAT_MIN, s)], [Math.min(180, e), Math.min(LAT_MAX, n)]];
}

export interface Insets { top: number; right: number; bottom: number; left: number }

/**
 * A Mercator projection fitted to `bounds` inside a width × height box, less
 * `pad` — a number, or per-side insets so the fit avoids the cards floating
 * over the map.
 */
export function makeProjection(width: number, height: number, bounds: [[number, number], [number, number]], pad: number | Insets = 48): GeoProjection {
  const i = typeof pad === 'number' ? { top: pad, right: pad, bottom: pad, left: pad } : pad;
  const [[w, s], [e, n]] = bounds;
  // Corner points, not a polygon: d3-geo reads a ring's winding as which side is inside, and a
  // counter-clockwise box would mean "the whole globe but this box".
  const box = { type: 'MultiPoint' as const, coordinates: [[w, s], [e, s], [e, n], [w, n], [(w + e) / 2, n], [(w + e) / 2, s]] };
  // Never let the insets squeeze the fit to nothing on a narrow window.
  const left = Math.min(i.left, width * 0.35);
  const right = Math.min(i.right, width * 0.35);
  const top = Math.min(i.top, height * 0.35);
  const bottom = Math.min(i.bottom, height * 0.35);
  const p = geoMercator().fitExtent([[left, top], [Math.max(left + 1, width - right), Math.max(top + 1, height - bottom)]], box);
  return p;
}

/**
 * A great circle from `a` to `b` as an SVG path, `samples` segments long, split
 * where it crosses the antimeridian (a jump of more than half the map width)
 * rather than drawn back across the whole map.
 */
export function arcPath(project: (p: LonLat) => [number, number] | null, a: LonLat, b: LonLat, width: number, samples = 48): string {
  const interp = geoInterpolate(a, b);
  let d = '';
  let prev: [number, number] | null = null;
  for (let i = 0; i <= samples; i++) {
    const pt = project(interp(i / samples) as LonLat);
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) { prev = null; continue; }
    const jump = prev && Math.abs(pt[0] - prev[0]) > width / 2;
    d += `${!prev || jump ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`;
    prev = pt;
  }
  return d;
}

/** A quadratic curve from a screen point (the sandbox card) to one on the map, bowed upward like the design's trunk. */
export function screenCurve(from: [number, number], to: [number, number], bow = 0.25): string {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const cx = (x1 + x2) / 2;
  const cy = Math.min(y1, y2) - Math.abs(x2 - x1) * bow;
  return `M${x1.toFixed(1)},${y1.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
}

/** Arc width by the square root of bytes, relative to the busiest destination: 1–3.5 px. */
export function strokeWidth(bytes: number, maxBytes: number): number {
  if (maxBytes <= 0 || bytes <= 0) return 1;
  return 1 + 2.5 * Math.sqrt(bytes / maxBytes);
}

/** On the map: has a location, is not a local link, and was not refused before it left. */
export function isMappable(d: DestinationAggregate): boolean {
  return d.geo !== null && d.scope !== 'local' && !BLOCK_STATES.has(d.state);
}

/**
 * "Unknown location": destinations that left the sandbox but cannot be placed —
 * no IP from glove, or no database, or not in it. Never looked up elsewhere.
 */
export function unknownLocation(dests: Iterable<DestinationAggregate>): DestinationAggregate[] {
  return [...dests].filter((d) => d.scope !== 'local' && !BLOCK_STATES.has(d.state) && d.host !== null && d.geo === null)
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export interface Cluster {
  key: string;
  lon: number;
  lat: number;
  /** City, else country. */
  label: string;
  dests: DestinationAggregate[];
  bytes: number;
  live: boolean;
  direct: boolean;
}

/** Destinations in the same city (or at the same point) share one pin with a count. */
export function clusterDestinations(dests: Iterable<DestinationAggregate>): Cluster[] {
  const m = new Map<string, Cluster>();
  for (const d of dests) {
    if (!isMappable(d)) continue;
    const g = d.geo!;
    const key = g.city ? `${g.city}|${g.countryCode ?? ''}` : `${g.lat.toFixed(1)}|${g.lon.toFixed(1)}`;
    const c = m.get(key) ?? { key, lon: g.lon, lat: g.lat, label: g.city ?? g.country ?? `${g.lat.toFixed(1)}, ${g.lon.toFixed(1)}`, dests: [], bytes: 0, live: false, direct: false };
    c.dests.push(d);
    c.bytes += d.bytesUp + d.bytesDown;
    c.live ||= d.state === 'active';
    c.direct ||= d.scope === 'direct';
    m.set(key, c);
  }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes);
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export interface LabelSpot {
  key: string;
  /** The pin, in screen pixels. */
  x: number;
  y: number;
  text: string;
}

/** Where a label pill goes: `left` is its left edge, `top` its vertical centre (the pill is translated −50%). */
export interface PlacedLabel { left: number; top: number }

const LABEL_H = 17;
/** An estimate of the pill's width at 10.5 px: close enough to keep neighbours apart. */
const labelWidth = (text: string) => text.length * 6 + 16;

/**
 * Keeps nearby cities' labels (Ashburn and Virginia, London, Roubaix and Frankfurt at a
 * fitted zoom) from overlapping. Greedy, in the order given (the biggest cluster first):
 * each tries right of its pin, then above right, left, above left, and is hidden when all
 * four collide; its pin's tooltip still names it. `reserved` boxes (the exit's label) are
 * taken first. Pure, so it is tested without a browser.
 */
export function placeLabels(spots: LabelSpot[], reserved: Array<[number, number, number, number]> = []): Map<string, PlacedLabel | null> {
  const taken = [...reserved];
  const hits = (b: [number, number, number, number]) => taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
  const out = new Map<string, PlacedLabel | null>();
  for (const s of spots) {
    const w = labelWidth(s.text);
    const tries: PlacedLabel[] = [
      { left: s.x + 10, top: s.y + 6 }, { left: s.x + 10, top: s.y - 12 },
      { left: s.x - 10 - w, top: s.y + 6 }, { left: s.x - 10 - w, top: s.y - 12 },
    ];
    const fit = tries.find((p) => !hits(labelBox(p, s.text))) ?? null;
    if (fit) taken.push(labelBox(fit, s.text));
    out.set(s.key, fit);
  }
  return out;
}

/** The box `placeLabels` reserves for a label placed at `p`. */
export function labelBox(p: PlacedLabel, text: string): [number, number, number, number] {
  return [p.left, p.top - LABEL_H / 2, p.left + labelWidth(text), p.top + LABEL_H / 2];
}

export type TrunkKind = 'verified' | 'declared' | 'none';

export interface Trunk {
  kind: TrunkKind;
  /** The apparent origin; null when there is no exit to pin (declared-only, or exit identity off). */
  exit: LonLat | null;
  label: string | null;
}

/**
 * The trunk from the sandbox card to the exit: solid when the exit is verified,
 * dashed "declared, not verified" otherwise, and none for a direct or
 * point-to-point route (there is no tunnel to draw).
 */
export function trunkFor(gate: NetGateView, exit: ExitRecord | null): Trunk {
  const kind = gate.route.kind;
  if (kind === 'direct' || kind === 'tcp' || kind === null) return { kind: 'none', exit: null, label: null };
  const placed = exit && exit.healthy && exit.lat !== null && exit.lon !== null;
  return {
    kind: gate.route.verified && placed ? 'verified' : 'declared',
    exit: placed ? [exit!.lon!, exit!.lat!] : null,
    label: placed ? `Exit · ${exit!.city ?? exit!.country ?? exit!.ip ?? ''}`.trim() : null,
  };
}

// ─── The 60 s ribbon ──────────────────────────────────────────────────────────

export const RIBBON_MS = 60_000;

export interface Lane {
  id: string;
  /** 0–1 across the window. */
  x0: number;
  x1: number;
  open: boolean;
  state: FlowView['state'];
  label: string;
  direct: boolean;
}

/** One lane per flow that overlaps the last 60 s before `anchor`, oldest first, at most `max`. */
export function ribbonLanes(flows: Iterable<FlowView>, anchor: number, max = 24): { lanes: Lane[]; more: number } {
  const from = anchor - RIBBON_MS;
  const x = (t: number) => Math.min(1, Math.max(0, (t - from) / RIBBON_MS));
  const inWindow = [...flows]
    .filter((f) => (f.tClose ?? f.lastT) >= from && f.tOpen <= anchor)
    .sort((a, b) => a.tOpen - b.tOpen);
  const lanes = inWindow.slice(-max).map((f) => ({
    id: f.id,
    x0: x(f.tOpen),
    x1: f.phase === 'close' ? Math.max(x(f.tClose ?? f.lastT), x(f.tOpen) + 0.004) : 1,
    open: f.phase !== 'close',
    state: f.state,
    label: f.dest.host ?? f.service,
    direct: f.flags.scope === 'direct',
  }));
  return { lanes, more: Math.max(0, inWindow.length - max) };
}

/**
 * The activity map's geometry, pure so it is tested in node; `components/activity/` only draws.
 *
 * The stations sit on an ellipse around a core (the agent), the first at the top and the rest
 * clockwise in the order given, so the order of `STATION_IDS` puts the person at the top and the
 * network across from them. Any number of stations: a gloved session's are its sandbox's services.
 * A spoke runs from the core's rim to a station's rim and wears wider with use, by the log of its
 * count so a busy station never swamps the rest. A leg of the route curves through the room between
 * the core and the ring, never through the core or across the labels outside the ring. Pulses that
 * share a spoke and a moment fly side by side in lanes.
 */

export interface Point { x: number; y: number }

export interface MapStation {
  id: string;
  /** Where the station's node is centred. */
  x: number;
  y: number;
  /** Its angle, clockwise from the top, in radians. */
  angle: number;
  /** Where its label goes, outside the ring, and which way the text runs from there. */
  label: Point & { anchor: 'start' | 'middle' | 'end' };
}

export interface MapLayout {
  width: number;
  height: number;
  core: Point;
  /** The ring's radii. */
  rx: number;
  ry: number;
  /** The core's radius and a node's. */
  hub: number;
  node: number;
  stations: MapStation[];
}

/** The smallest map that still has room for its labels; a smaller box is drawn at this size, scaled. */
export const MIN_SIZE = { width: 320, height: 260 } as const;
const HUB = 18;
const NODE = 13;
/** Room outside the ring for a label: its height above and below, its width at the sides. */
const LABEL_ROOM = { x: 74, y: 30 } as const;
/** How far a label sits from its node's centre. */
const LABEL_GAP = NODE + 9;
/** A count at which a spoke is fully worn (2^7 - 1). */
const WEAR_LOG = 7;
/** The width of an unused spoke, and how much use adds at most. */
const SPOKE_MIN = 1;
const SPOKE_GAIN = 2.6;
/** From one pulse's lane to the next. */
export const LANE_GAP = 5;

const round = (v: number): number => Math.round(v * 10) / 10;

/** The stations placed on the ring for a box of the given size. */
export function layoutMap(ids: readonly string[], size: { width: number; height: number }): MapLayout {
  const width = Math.max(MIN_SIZE.width, size.width);
  const height = Math.max(MIN_SIZE.height, size.height);
  const core = { x: width / 2, y: height / 2 };
  const rx = width / 2 - LABEL_ROOM.x;
  const ry = height / 2 - LABEL_ROOM.y;
  const n = ids.length;
  const stations = ids.map((id, i): MapStation => {
    const angle = n === 0 ? 0 : (i * 2 * Math.PI) / n;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const x = core.x + rx * sin;
    const y = core.y - ry * cos;
    // Above and below a node the label is centred; at the sides it runs away from the ring.
    const anchor: MapStation['label']['anchor'] = Math.abs(sin) < 0.3 ? 'middle' : sin > 0 ? 'start' : 'end';
    const label = anchor === 'middle'
      ? { x: round(x), y: round(y + (cos > 0 ? -LABEL_GAP : LABEL_GAP + 8)), anchor }
      : { x: round(x + (sin > 0 ? LABEL_GAP : -LABEL_GAP)), y: round(y + 4), anchor };
    return { id, x: round(x), y: round(y), angle, label };
  });
  return { width, height, core, rx, ry, hub: HUB, node: NODE, stations };
}

/** How worn a spoke is by `count` uses, 0..1, by the log so the busiest station does not swamp the rest. */
export function wear(count: number): number {
  return count <= 0 ? 0 : Math.min(1, Math.log2(1 + count) / WEAR_LOG);
}

/** A spoke's stroke width for `count` uses. */
export function spokeWidth(count: number): number {
  return round(SPOKE_MIN + SPOKE_GAIN * wear(count));
}

/** Where a straight line from `from` towards `to` leaves the circle of radius `r` around `from`. */
export function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: round(from.x + ((to.x - from.x) * r) / d), y: round(from.y + ((to.y - from.y) * r) / d) };
}

const find = (layout: MapLayout, id: string): MapStation | undefined => layout.stations.find((s) => s.id === id);

/** A spoke: from the core's rim to the station's rim. Undefined for a station not on the map. */
export function spoke(layout: MapLayout, id: string): { from: Point; to: Point } | undefined {
  const s = find(layout, id);
  if (!s) return undefined;
  return { from: edge(layout.core, s, layout.hub), to: edge(s, layout.core, layout.node) };
}

/**
 * How far out from the core a leg bends, as a share of the ring, by how many stations apart its ends
 * are: a leg between neighbours bends halfway in (clear of the labels outside), a leg across the map
 * bends further out so it does not cut through the core.
 */
function bendShare(steps: number, n: number): number {
  const across = n <= 1 ? 0 : Math.abs(steps) / (n / 2); // 0 = same, 1 = opposite
  return across <= 0.5 ? 0.5 - 0.1 * across * 2 : 0.4 + 0.35 * (across - 0.5) * 2;
}

/**
 * A leg of the route from one station to another: a quadratic curve through the room between the
 * core and the ring, ending on the target node's rim. Undefined when either is not on the map or
 * they are the same station.
 */
export function legPath(layout: MapLayout, fromId: string, toId: string): { d: string; bend: Point; start: Point; end: Point } | undefined {
  const i = layout.stations.findIndex((s) => s.id === fromId);
  const j = layout.stations.findIndex((s) => s.id === toId);
  if (i < 0 || j < 0 || i === j) return undefined;
  const n = layout.stations.length;
  let steps = (((j - i) % n) + n) % n;
  if (steps > n / 2) steps -= n;
  const angle = ((i + steps / 2) * 2 * Math.PI) / n;
  const share = bendShare(steps, n);
  const bend = {
    x: round(layout.core.x + layout.rx * share * Math.sin(angle)),
    y: round(layout.core.y - layout.ry * share * Math.cos(angle)),
  };
  const start = edge(layout.stations[i], bend, layout.node + 4);
  const end = edge(layout.stations[j], bend, layout.node + 4);
  return { d: `M${start.x} ${start.y}Q${bend.x} ${bend.y} ${end.x} ${end.y}`, bend, start, end };
}

/** Sideways offsets for `n` pulses on one spoke at one moment, centred on the spoke. */
export function lanes(n: number, gap = LANE_GAP): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, k) => round((k - (n - 1) / 2) * gap));
}

/** The line from `a` to `b` moved `off` to its side, for a pulse flying in a lane. */
export function aside(a: Point, b: Point, off: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const dx = (-(b.y - a.y) * off) / d;
  const dy = ((b.x - a.x) * off) / d;
  return [{ x: round(a.x + dx), y: round(a.y + dy) }, { x: round(b.x + dx), y: round(b.y + dy) }];
}

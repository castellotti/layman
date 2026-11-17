/**
 * The Gibson city: the model both renderers share (docs/extensions/styx.md → "Gibson"). Pure: rows in,
 * geometry and text out; nothing here draws, reads the DOM or asks the network. The one stateful rule is
 * `place` (who stands where is remembered), and its state is its argument; the traffic's is held in the
 * object `createTraffic` returns.
 */
import type { HostRow, LinkRow, LogRow } from './gibson-feed.js';
import { hash01 } from './matrix-rain.js';

export const LOT = 3;
export const BLOCK_LOTS = 4;
export const STREET = 4;
export const BLOCK_PITCH = 16;
/** A tower's text page is 24 columns wide. */
export const PAGE_COLUMNS = 24;
const LOTS_PER_BLOCK = BLOCK_LOTS * BLOCK_LOTS;
const MAX_HOME_SOURCES = 16;
/** The home block's lot for the one chip of a city with no links, and for a 17th source onward. */
const LOCAL_LOT = 5;
const OVERFLOW_LOT = 15;
export const MENU_ITEMS = 12;
export const MENU_BOXES = 4;
export const LOG_LINES = 40;
export const MAX_CARS = 96;
export const CAR_SPEED = 40;
export const CAR_TAIL = 3;
const FLASH_S = 0.3;

/** Slot index → block coordinates, a square spiral out from the centre. */
export function spiral(i: number): [number, number] {
  if (i <= 0) return [0, 0];
  const r = Math.ceil((Math.sqrt(i + 1) - 1) / 2);
  const side = 2 * r;
  const k = i - (2 * r - 1) ** 2;
  const edge = Math.floor(k / side);
  const o = k % side;
  switch (edge) {
    case 0: return [r, -r + 1 + o];
    case 1: return [r - 1 - o, r];
    case 2: return [-r, r - 1 - o];
    default: return [-r + 1 + o, -r];
  }
}

export type Tone = 'normal' | 'blocked' | 'untunnelled' | 'local';

/** What a tower's state is: blocked, then untunnelled, then local, else normal. */
export function toneOf(row: HostRow): Tone {
  if (row.count > 0 && row.blocked >= row.count) return 'blocked';
  if (row.untunnelled) return 'untunnelled';
  if (row.scope === 'local' || row.scope === 'lan') return 'local';
  return 'normal';
}

/** Who stands where. Never mutated: `place` returns a new one. */
export interface Placement {
  /** Block id (`github.com`, `github.com#2`) → slot index (≥ 1). */
  blocks: ReadonlyMap<string, number>;
  /** Host → its block id and lot (0..15). */
  lots: ReadonlyMap<string, { block: string; lot: number }>;
  /** Link source → its lot in the home block. */
  home: ReadonlyMap<string, number>;
}

export const EMPTY_PLACEMENT: Placement = { blocks: new Map(), lots: new Map(), home: new Map() };

/** `block`, `block#2`, `block#3`… */
const blockId = (block: string, n: number): string => (n === 1 ? block : `${block}#${n}`);

/**
 * Placement is remembered, so a city that refreshes does not reshuffle: a host already placed and still in the
 * answer keeps its lot; one that left frees it; a new one takes the first block of its `block` with a free lot
 * (a block holds 16, then `<block>#2`…) and the lowest free lot in it; a new block takes the lowest free slot
 * from 1 (slot 0 is home). The first answer is busiest first, so the busiest domains end up nearest the centre.
 * Home: each distinct link source takes the lowest free lot of slot 0, in the order the links arrive; with no
 * links the one chip, LOCAL, stands on lot 5. Forgetting everything is `EMPTY_PLACEMENT`: the caller resets it
 * when the session, window or source changes.
 */
export function place(prev: Placement, hosts: readonly HostRow[], links: readonly LinkRow[]): Placement {
  // Home.
  const home = new Map<string, number>();
  const sources = [...new Set(links.map((l) => l.source))];
  if (sources.length === 0) {
    home.set('LOCAL', LOCAL_LOT);
  } else {
    const used = new Set<number>();
    for (const s of sources) {
      const lot = prev.home.get(s);
      if (lot !== undefined) { home.set(s, lot); used.add(lot); }
    }
    for (const s of sources) {
      if (home.has(s)) continue;
      let lot = 0;
      while (lot < MAX_HOME_SOURCES && used.has(lot)) lot++;
      if (lot >= MAX_HOME_SOURCES) lot = OVERFLOW_LOT;
      used.add(lot);
      home.set(s, lot);
    }
  }

  // Hosts that stay keep their lot.
  const lots = new Map<string, { block: string; lot: number }>();
  const taken = new Map<string, Set<number>>();
  for (const h of hosts) {
    const was = prev.lots.get(h.host);
    if (!was) continue;
    lots.set(h.host, was);
    const set = taken.get(was.block) ?? new Set<number>();
    set.add(was.lot);
    taken.set(was.block, set);
  }
  // A block with no hosts left gives up its slot.
  const blocks = new Map<string, number>();
  for (const [id, slot] of prev.blocks) if (taken.has(id)) blocks.set(id, slot);
  const slots = new Set(blocks.values());
  const freeSlot = (): number => {
    let s = 1;
    while (slots.has(s)) s++;
    slots.add(s);
    return s;
  };

  for (const h of hosts) {
    if (lots.has(h.host)) continue;
    for (let n = 1; ; n++) {
      const id = blockId(h.block, n);
      let set = taken.get(id);
      if (!set) {
        set = new Set();
        taken.set(id, set);
        blocks.set(id, freeSlot());
      }
      if (set.size >= LOTS_PER_BLOCK) continue;
      let lot = 0;
      while (set.has(lot)) lot++;
      set.add(lot);
      lots.set(h.host, { block: id, lot });
      break;
    }
  }
  return { blocks, lots, home };
}

export interface Tower {
  host: string;
  row: HostRow;
  /** The centre of its plot. */
  x: number;
  z: number;
  /** The side of its square footprint. */
  side: number;
  height: number;
  tone: Tone;
  /** The part of its connections glove refused, 0..1. */
  blockedFraction: number;
  /** 1 now, 0 after 30 s without a connection. */
  activity: number;
  fresh: boolean;
}
export interface Chip { source: string; x: number; z: number }
export interface City {
  towers: Tower[];
  chips: Chip[];
  /** Half the side of the square holding every block, at least 24. */
  extent: number;
}

/** The centre of lot `lot` of the block at slot `slot`. */
function lotCentre(slot: number, lot: number): [number, number] {
  const [bx, bz] = spiral(slot);
  return [bx * BLOCK_PITCH + ((lot % BLOCK_LOTS) - 1.5) * LOT, bz * BLOCK_PITCH + (Math.floor(lot / BLOCK_LOTS) - 1.5) * LOT];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * The geometry of the answer: a tower for each host with a lot, a chip for each home source. Heights go by
 * bytes (by count when no host has any), the footprint by count, both on a log scale against the answer's own
 * largest, so the busiest is the tallest.
 */
export function buildCity(placement: Placement, hosts: readonly HostRow[], links: readonly LinkRow[], fresh: ReadonlySet<string>): City {
  const bytes = hosts.some((h) => h.sent + h.received > 0);
  const size = (h: HostRow): number => (bytes ? h.sent + h.received : h.count);
  const vmax = hosts.reduce((m, h) => Math.max(m, size(h)), 0);
  const countmax = hosts.reduce((m, h) => Math.max(m, h.count), 0);
  const towers: Tower[] = [];
  let ring = 0;
  for (const row of hosts) {
    const at = placement.lots.get(row.host);
    const slot = at ? placement.blocks.get(at.block) : undefined;
    if (!at || slot === undefined) continue;
    const [x, z] = lotCentre(slot, at.lot);
    const [bx, bz] = spiral(slot);
    ring = Math.max(ring, Math.abs(bx), Math.abs(bz));
    const norm = vmax > 0 ? Math.log(1 + size(row)) / Math.log(1 + vmax) : 0;
    towers.push({
      host: row.host, row, x, z,
      side: 1.2 + (countmax > 0 ? 0.8 * Math.log(1 + row.count) / Math.log(1 + countmax) : 0),
      height: 2 + 34 * norm,
      tone: toneOf(row),
      blockedFraction: row.count > 0 ? clamp(row.blocked / row.count, 0, 1) : 0,
      activity: clamp(1 - row.last_seen_ago / 30, 0, 1),
      fresh: fresh.has(row.host),
    });
  }
  const chips: Chip[] = [];
  const homeSources = new Map(placement.home);
  for (const l of links) if (!homeSources.has(l.source)) homeSources.set(l.source, OVERFLOW_LOT);
  for (const [source, lot] of homeSources) {
    const [x, z] = lotCentre(0, lot);
    chips.push({ source, x, z });
  }
  return { towers, chips, extent: Math.max(24, ring * BLOCK_PITCH + BLOCK_PITCH / 2) };
}

/** The street centre line nearest `v` (streets run at `16 k + 8`). */
const street = (v: number): number => BLOCK_PITCH * Math.round((v - BLOCK_PITCH / 2) / BLOCK_PITCH) + BLOCK_PITCH / 2;

/**
 * The way from `from` to `to` along the streets' centre lines (under a tower where it must): out along x to the
 * nearest street across, along that street, down the street nearest the target, then in. Every segment is
 * axis-aligned; a point equal to the one before it is dropped.
 */
export function routeOf(from: readonly [number, number], to: readonly [number, number]): Array<[number, number]> {
  const [x0, z0] = from;
  const [x1, z1] = to;
  const zs = street(z0);
  const xs = street(x1);
  const zt = street(z1);
  const points: Array<[number, number]> = [[x0, z0], [x0, zs], [xs, zs], [xs, zt], [x1, zt], [x1, z1]];
  return points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
}

/** `512B`, `5.1K`, `2.0M`, `1.0G`: powers of 1024, one decimal from K up. */
export function formatBytesShort(n: number): string {
  if (!(n > 0)) return '0B';
  if (n < 1024) return `${Math.round(n)}B`;
  const units = ['K', 'M', 'G'];
  let v = n / 1024;
  let i = 0;
  while (i < units.length - 1 && Number(v.toFixed(1)) >= 1024) { v /= 1024; i++; }
  return `${v.toFixed(1)}${units[i]}`;
}

/** `3S`, `4M`, `2H`, `5D`. */
export function formatAgoShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}S`;
  if (s < 3600) return `${Math.floor(s / 60)}M`;
  if (s < 86400) return `${Math.floor(s / 3600)}H`;
  return `${Math.floor(s / 86400)}D`;
}

/** `HH:MM:SS`, 24-hour, in the viewer's zone: the one place the model reads it. */
function clockOf(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** What a log row's state is called in the scene. */
function stateWord(row: LogRow): string {
  if (row.blocked) return 'REFUSED';
  if (row.state === 'finished') return 'OK';
  if (row.state === 'active' || row.state === 'pooled') return 'LIVE';
  return row.state.toUpperCase();
}

const cut = (s: string): string => s.slice(0, PAGE_COLUMNS);

/**
 * The lines a tower's faces show, upper-case, each at most 24 characters, ending in the two blank lines after
 * which the page repeats. The selected tower's `log` continues the page after `SEEN`, newest first.
 */
export function pageOf(row: HostRow, log?: readonly LogRow[]): string[] {
  const host = row.host.toUpperCase();
  const lines: string[] = [];
  for (let i = 0; i < host.length; i += PAGE_COLUMNS) lines.push(host.slice(i, i + PAGE_COLUMNS));
  lines.push('');
  if (row.ports.length > 0) lines.push(cut(`PORT ${row.ports.join(' ')}`));
  lines.push(`COUNT ${row.count}`);
  if (row.open > 0) lines.push(`OPEN ${row.open}`);
  lines.push(cut(`UP ${formatBytesShort(row.sent)}`), cut(`DOWN ${formatBytesShort(row.received)}`));
  if (row.scope) lines.push(cut(`SCOPE ${row.scope.toUpperCase()}`));
  if (row.blocked > 0) lines.push(`REFUSED ${row.blocked}`);
  for (const s of row.services) lines.push(cut(`VIA ${s.toUpperCase()}`));
  for (const t of row.tools) lines.push(cut(`TOOL ${t.toUpperCase()}`));
  for (const c of row.clients) lines.push(cut(`FROM ${c.toUpperCase()}`));
  lines.push(`SEEN ${formatAgoShort(row.last_seen_ago)} AGO`);
  for (const l of (log ?? []).slice(0, LOG_LINES)) lines.push(cut(`${clockOf(l.time)} ${l.port ?? '-'} ${stateWord(l)}`));
  lines.push('', '');
  return lines;
}

export interface MenuItem { key: string; label: string; rows: LogRow[] }

/** The menu of a tower: its log grouped by (port, via or source), the most rows first, at most 12. */
export function menuOf(log: readonly LogRow[]): MenuItem[] {
  const items = new Map<string, MenuItem>();
  for (const r of log) {
    const label = `${r.port ?? '-'} ${r.via || r.source}`.toUpperCase();
    const key = `${r.port ?? '-'}|${r.via || r.source}`;
    const item = items.get(key);
    if (item) item.rows.push(r);
    else items.set(key, { key, label, rows: [r] });
  }
  return [...items.values()]
    .sort((a, b) => b.rows.length - a.rows.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, MENU_ITEMS);
}

const BOX_TITLE = 22;

/** The path of a URL as glove recorded it (no host, no query), or '' when it has none. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*([^?#]*)/i.exec(url)?.[1] ?? '';
  }
}

/** A box's title and caption for one log row. */
export function boxOf(row: LogRow): { title: string; caption: string; blocked: boolean } {
  let title: string;
  if (row.url) title = `${row.method ?? ''} ${pathOf(row.url).slice(0, BOX_TITLE)}`.trim();
  else if (row.label) title = row.label.slice(0, BOX_TITLE);
  else title = clockOf(row.time);
  const caption = row.blocked
    ? (row.rule ? `REFUSED ${row.rule}` : 'REFUSED')
    : `${stateWord(row)} ${formatBytesShort(row.sent)} ${formatBytesShort(row.received)}`;
  return { title: title.toUpperCase(), caption: caption.toUpperCase(), blocked: row.blocked };
}

export interface Car {
  key: string;
  x: number;
  z: number;
  /** Unit direction of travel. */
  dx: number;
  dz: number;
  tone: Tone;
  blocked: boolean;
  /** 0..1, 1 while it flashes at a refusing tower. */
  flash: number;
}

export interface Traffic {
  /** Advance by `dt` seconds and return the cars alive now. */
  step(dt: number, links: readonly LinkRow[], city: City): Car[];
  /** Hosts a car reached during the last step (they brighten). */
  arrivals(): string[];
}

interface Live {
  key: string;
  route: Array<[number, number]>;
  length: number;
  dist: number;
  tone: Tone;
  blocked: boolean;
  /** The tower it runs to, when it runs outbound. */
  reaches: string | null;
  /** Seconds since it reached a refusing tower. */
  flashAge: number | null;
}

/** Seconds between a link's cars: busy links more often, long-quiet ones less. */
export function carInterval(l: LinkRow): number {
  return clamp(6 / (1 + Math.log(1 + l.count)), 0.4, 6) * (1 + l.last_seen_ago / 10);
}

/** A link sends no cars once it has been quiet and has nothing open. */
export const sendsCars = (l: LinkRow): boolean => !(l.last_seen_ago > 60 && l.open === 0);

export const linkKey = (l: Pick<LinkRow, 'source' | 'via' | 'target'>): string => `${l.source}|${l.via}|${l.target}`;

function lengthOf(route: ReadonlyArray<readonly [number, number]>): number {
  let n = 0;
  for (let i = 1; i < route.length; i++) n += Math.abs(route[i][0] - route[i - 1][0]) + Math.abs(route[i][1] - route[i - 1][1]);
  return n;
}

/** The point at `dist` along an axis-aligned route, and the unit direction there. */
function along(route: ReadonlyArray<readonly [number, number]>, dist: number): { x: number; z: number; dx: number; dz: number } {
  let left = Math.max(0, dist);
  let dx = 1;
  let dz = 0;
  for (let i = 1; i < route.length; i++) {
    const [ax, az] = route[i - 1];
    const [bx, bz] = route[i];
    const len = Math.abs(bx - ax) + Math.abs(bz - az);
    if (len === 0) continue;
    dx = Math.sign(bx - ax);
    dz = Math.sign(bz - az);
    if (left <= len) return { x: ax + dx * left, z: az + dz * left, dx, dz };
    left -= len;
  }
  const last = route[route.length - 1] ?? [0, 0];
  return { x: last[0], z: last[1], dx, dz };
}

/**
 * The cars on the streets. Each link keeps the time to its next car and a sequence number; a car's direction
 * comes from a hash of the link and its number (never a random call), so a still frame is repeatable and a
 * step of 0 seconds changes nothing. At most 96 alive: when full, a link's next car is skipped.
 */
export function createTraffic(): Traffic {
  const waits = new Map<string, { wait: number; seq: number }>();
  let cars: Live[] = [];
  let reached: string[] = [];

  /** Move a car on by `dt`; false when it is gone. */
  const advance = (c: Live, dt: number): boolean => {
    if (c.flashAge !== null) {
      c.flashAge += dt;
      return c.flashAge < FLASH_S;
    }
    c.dist += CAR_SPEED * dt;
    if (c.dist < c.length) return true;
    if (c.reaches) reached.push(c.reaches);
    if (!c.blocked) return false;
    c.flashAge = (c.dist - c.length) / CAR_SPEED;
    c.dist = c.length;
    return c.flashAge < FLASH_S;
  };

  return {
    arrivals: () => reached,
    step(dt, links, city) {
      reached = [];
      cars = cars.filter((c) => advance(c, dt));
      const towers = new Map(city.towers.map((t) => [t.host, t]));
      const chips = new Map(city.chips.map((c) => [c.source, c]));
      const seen = new Set<string>();
      for (const l of links) {
        const tower = towers.get(l.target);
        const chip = chips.get(l.source);
        if (!tower || !chip) continue;
        const key = linkKey(l);
        seen.add(key);
        const interval = carInterval(l);
        let st = waits.get(key);
        // A link's first car comes part way into its interval, so links do not all fire together.
        if (!st) { st = { wait: hash01(key) * interval, seq: 0 }; waits.set(key, st); }
        if (!sendsCars(l)) continue;
        st.wait -= dt;
        while (st.wait <= 0) {
          const born = -st.wait; // how long ago, within this step, the car left
          st.wait += interval;
          const seq = st.seq++;
          if (cars.length >= MAX_CARS) continue;
          const blocked = l.count > 0 && l.blocked >= l.count;
          const total = l.sent + l.received;
          const outbound = blocked || total === 0 || hash01(`${key}:${seq}`) < clamp(l.sent / total, 0.2, 0.8);
          const out = routeOf([chip.x, chip.z], [tower.x, tower.z]);
          const route = outbound ? out : [...out].reverse();
          const car: Live = {
            key: `${key}#${seq}`, route, length: lengthOf(route), dist: 0, tone: tower.tone, blocked,
            reaches: outbound ? tower.host : null, flashAge: null,
          };
          if (advance(car, Math.max(0, Math.min(dt, born)))) cars.push(car);
        }
      }
      for (const k of waits.keys()) if (!seen.has(k)) waits.delete(k);
      return cars.map((c) => {
        const p = along(c.route, c.dist);
        return { key: c.key, x: p.x, z: p.z, dx: p.dx, dz: p.dz, tone: c.tone, blocked: c.blocked, flash: c.flashAge === null ? 0 : 1 - c.flashAge / FLASH_S };
      });
    },
  };
}

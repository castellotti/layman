/**
 * What falls in the Matrix tabs, as pure functions of time and the feed's rows (shared by the 2D
 * and 3D renderers). Written from scratch: it derives from no styx-godot shader (docs/extensions/styx.md → Licences).
 *
 * A stream is a position in time: its head is at row `(now - startAt) × speed / 1000`, so a
 * resize or a redraw puts it back where it belongs, and a data refresh never restarts it.
 */
import type { MatrixRow } from './matrix-feed.js';

export type StreamTone = 'normal' | 'blocked' | 'untunnelled';

export interface Stream {
  /** The row's address: the key. */
  address: string;
  /** What falls: the head at row r shows `text[r]`, and the text repeats below after a gap if the screen is taller. */
  text: string;
  column: number;
  /** Rows per second. */
  speed: number;
  /** ms; the head is at row 0 at this time. */
  startAt: number;
  tone: StreamTone;
  /** 0..1, by bytes, for brightness. */
  weight: number;
  /** This address's first fall since it entered the feed. */
  fresh: boolean;
}

export const MAX_TEXT = 48;
export const MIN_SPEED = 6;
export const MAX_SPEED = 26;
export const FRESH_MIN_SPEED = 22;

/** Upper-case; anything outside 0-9 A-Z . - : _ becomes '-'; at most 48 characters. IPv6 brackets go. */
export function streamText(address: string): string {
  return address.replace(/[[\]]/g, '').toUpperCase().replace(/[^0-9A-Z.:_-]/g, '-').slice(0, MAX_TEXT);
}

/** 6 rows/s for the least reached, 26 for the most, linear in count / maxCount. */
export function speedOf(count: number, maxCount: number): number {
  if (maxCount <= 0) return MIN_SPEED;
  const f = Math.min(1, Math.max(0, count / maxCount));
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * f;
}

/** Blocked beats untunnelled beats normal. */
export function toneOf(row: MatrixRow): StreamTone {
  return row.blocked > 0 ? 'blocked' : row.untunnelled ? 'untunnelled' : 'normal';
}

/** Row of the head at `now` (fractional). */
export function headRow(s: Stream, now: number): number {
  return ((now - s.startAt) / 1000) * s.speed;
}

/** True once the last character has left the bottom: headRow - text.length > rows. */
export function streamDone(s: Stream, now: number, rows: number): boolean {
  return headRow(s, now) - s.text.length > rows;
}

/** `log1p(bytes) / log1p(most bytes)`, or count over the largest count when no row moved a byte. */
export function weightsOf(rows: readonly MatrixRow[]): Map<string, number> {
  const maxBytes = Math.max(0, ...rows.map((r) => r.sent + r.received));
  const maxCount = Math.max(0, ...rows.map((r) => r.count));
  const out = new Map<string, number>();
  for (const r of rows) {
    const w = maxBytes > 0 ? Math.log1p(r.sent + r.received) / Math.log1p(maxBytes) : maxCount > 0 ? r.count / maxCount : 0;
    out.set(r.address, Math.min(1, Math.max(0, w)));
  }
  return out;
}

export interface PlanInput {
  rows: readonly MatrixRow[];
  columns: number;
  visibleRows: number;
  now: number;
  current: readonly Stream[];
  lastColumn: ReadonlyMap<string, number>;
  /** Addresses already given to the screen; null on the first plan after a session or window change. */
  known: ReadonlySet<string> | null;
  rand: () => number;
}

/**
 * The streams to show next. Keeps every stream still falling (never restarts one because the data
 * refreshed). Starts a stream for each row that has none, most reached first, in a free column
 * chosen by `rand`, never the column that address used last time while another is free. At most
 * one stream per column; with more rows than columns the least reached wait. A stream whose
 * address left the feed finishes its fall and is not started again.
 *
 * An address not in `known` is new: it starts now, before every other waiting row, with
 * `fresh: true` and at least 22 rows/s, so it is seen within a second. With no column free it takes
 * the column of the least reached stream that is not itself fresh (that stream is dropped and waits
 * its turn again). The caller adds every address it has been given to `known`; with `known` null
 * nothing is fresh, or the whole screen would flash.
 */
export function planStreams(input: PlanInput): Stream[] {
  const { rows, columns, visibleRows, now, lastColumn, known, rand } = input;
  if (columns <= 0) return [];
  const kept = input.current.filter((s) => s.column < columns && !streamDone(s, now, visibleRows));
  const taken = new Map<number, Stream>(kept.map((s) => [s.column, s]));
  const falling = new Set(kept.map((s) => s.address));
  const maxCount = Math.max(0, ...rows.map((r) => r.count));
  const weights = weightsOf(rows);
  const countOf = new Map(rows.map((r) => [r.address, r.count]));
  const isNew = (r: MatrixRow) => known !== null && !known.has(r.address);

  const waiting = rows.filter((r) => !falling.has(r.address));
  // New addresses first (most reached among them first), then the rest; `rows` is already by count.
  const order = [...waiting.filter(isNew), ...waiting.filter((r) => !isNew(r))];

  const freeColumns = (): number[] => {
    const out: number[] = [];
    for (let c = 0; c < columns; c++) if (!taken.has(c)) out.push(c);
    return out;
  };

  for (const r of order) {
    const fresh = isNew(r);
    let free = freeColumns();
    let column: number;
    if (free.length === 0) {
      if (!fresh) break; // the least reached wait
      // The least reached stream that is not itself fresh gives up its column.
      let victim: Stream | null = null;
      for (const s of taken.values()) {
        if (s.fresh) continue;
        if (!victim || (countOf.get(s.address) ?? 0) < (countOf.get(victim.address) ?? 0)) victim = s;
      }
      if (!victim) break;
      taken.delete(victim.column);
      free = [victim.column];
    }
    const last = lastColumn.get(r.address);
    const choices = free.length > 1 ? free.filter((c) => c !== last) : free;
    column = choices[Math.min(choices.length - 1, Math.floor(rand() * choices.length))];
    const speed = speedOf(r.count, maxCount);
    taken.set(column, {
      address: r.address,
      text: streamText(r.address),
      column,
      speed: fresh ? Math.max(FRESH_MIN_SPEED, speed) : speed,
      startAt: now,
      tone: toneOf(r),
      weight: weights.get(r.address) ?? 0,
      fresh,
    });
  }
  return [...taken.values()].sort((a, b) => a.column - b.column);
}

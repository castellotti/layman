/**
 * Words for a network time range (`NetRange`): its span in local time, its length, and what
 * the server could not cover. Pure, so it is tested in node; the components only place it.
 *
 * Times are local, to the second; a component shows UTC on hover (`rangeTitle`).
 */
import type { NetRange, NetRangeInfo } from './netobs-types.js';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 21 00:27:03" in local time. */
export function formatStamp(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "29 h 42 m", "5 m 12 s", "40 s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} m` : `${h} h`;
  if (m) return s % 60 ? `${m} m ${s % 60} s` : `${m} m`;
  return `${s} s`;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "Oct 21 00:27:03 → Oct 22 06:09:02 (29 h 42 m)"; the end's date is left out on the same day; an open range ends "now". */
export function formatRange(r: NetRange, now = Date.now()): string {
  const end = r.to ?? now;
  const to = r.to === null ? 'now' : sameDay(r.from, r.to) ? formatStamp(r.to).split(' ').at(-1)! : formatStamp(r.to);
  return `${formatStamp(r.from)} → ${to} (${formatDuration(end - r.from)})`;
}

/** The same span in UTC, for a hover. */
export function rangeTitle(r: NetRange): string {
  return `${new Date(r.from).toISOString()} → ${r.to === null ? 'now' : new Date(r.to).toISOString()} (UTC)`;
}

/**
 * What a range's figures leave out, worst first, or nothing. `filesFrom` later than `from`
 * means the range starts before the oldest record still on disk: glove has deleted it (or the
 * scan's budget skipped it), so the earlier part is simply not counted.
 */
export function rangeGaps(info: NetRangeInfo): string[] {
  const out: string[] = [];
  if (info.filesFrom === null) out.push('glove keeps no records for this range.');
  else if (info.filesFrom > info.from) {
    out.push(`${info.truncated ? 'Only' : 'glove’s files only'} reach back to ${formatStamp(info.filesFrom)}: traffic before that is not counted.`);
  }
  if (info.truncated) out.push('The range is too long to read in full: its oldest files were skipped.');
  return out;
}

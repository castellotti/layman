/**
 * Words for a network time range (`NetRange`): its span in local time, its length, and what
 * the server could not cover. Pure, so it is tested in node; the components only place it.
 *
 * Times are local, to the second; a component shows UTC on hover (`rangeTitle`).
 */
import type { NetRange, NetRangeInfo } from './netobs-types.js';

const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "00:27:03" in local time. */
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** "Oct 21 00:27:03" in local time. */
export function formatStamp(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${clock(d)}`;
}

/** A range's length in its two largest units: "1 d 5 h", "5 m 12 s", "40 s". */
export function formatSpan(ms: number): string {
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
  const to = r.to === null ? 'now' : sameDay(r.from, r.to) ? clock(new Date(r.to)) : formatStamp(r.to);
  return `${formatStamp(r.from)} → ${to} (${formatSpan(end - r.from)})`;
}

/** The same span in UTC, for a hover. */
export function rangeTitle(r: NetRange): string {
  return `${new Date(r.from).toISOString()} → ${r.to === null ? 'now' : new Date(r.to).toISOString()} (UTC)`;
}

/**
 * Grace for comparing the session's first record with the files' first: a flow's open time can
 * come a little before the first record that names it.
 */
const SAME_START_MS = 60_000;

/**
 * What a range's figures leave out, worst first, or nothing. A range starting before the session
 * did is not missing anything. One starting before the oldest record still on disk, in a session
 * that began earlier still, is: glove deleted the older files. Over the scan's budget the older
 * files were skipped instead, and the message says so.
 */
export function rangeGaps(info: NetRangeInfo): string[] {
  if (info.filesFrom === null) return ['glove keeps no records for this range.'];
  // Over the scan's budget the older files are still there, just not read: say that, not "deleted".
  if (info.truncated) return [`The range is too long to read in full: traffic before ${formatStamp(info.filesFrom)} was skipped.`];
  const deleted = info.filesFrom > info.from && (info.sessionFrom === null || info.filesFrom > info.sessionFrom + SAME_START_MS);
  return deleted ? [`glove’s files only reach back to ${formatStamp(info.filesFrom)}: traffic before that is not counted.`] : [];
}

/** When the session began, if the range starts before it (not a gap: there was nothing yet). */
export function rangeLead(info: NetRangeInfo): string | null {
  return info.sessionFrom !== null && info.sessionFrom > info.from ? `The session began ${formatStamp(info.sessionFrom)}.` : null;
}

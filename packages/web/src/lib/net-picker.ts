/**
 * The range picker's arithmetic (`RangePicker.tsx`): ready-made ranges from a session's
 * segments, presets, the calendar's month grid shaded by activity, the timeline's scale and
 * its brush's snapping, and the `datetime-local` fields. Pure, so it is tested in node.
 *
 * Times are local, like every range shown (`net-range.ts`).
 */
import { sameRange } from './net-state.js';
import type { BurstSegment, HourActivity, NetRange, NetSegments, RunSegment } from './netobs-types.js';

const HOUR = 3_600_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** A local time as a `datetime-local` value, to the second: "2026-10-21T00:27:03". */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A `datetime-local` value as a local time, or null for an empty or malformed one. Seconds are optional. */
export function fromLocalInput(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const t = new Date(y, mo - 1, d, h, mi, se).getTime();
  // Reject what `Date` would roll over (Feb 30 → Mar 2) rather than show another day.
  const back = new Date(t);
  return back.getFullYear() === y && back.getMonth() === mo - 1 && back.getDate() === d ? t : null;
}

/** Local midnight of the day holding `t`. */
export function dayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** The next local midnight after `t`'s day: a day is not always 24 h (daylight saving). */
export function nextDay(t: number): number {
  const d = new Date(dayStart(t));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** A segment as a range: a run still going is open (it grows), the rest are closed. */
export function segmentRange(s: { from: number; to: number | null }): NetRange {
  return { from: s.from, to: s.to };
}

/** Runs are numbered from the first, as `glove up` went: "Run 18". */
export function runNumber(segments: NetSegments, run: RunSegment): number {
  return segments.runs.indexOf(run) + 1;
}

/** What a set range is called, when it is exactly a run: "Run 18". Otherwise null. */
export function rangeName(range: NetRange, segments: NetSegments | null): string | null {
  const run = segments?.runs.find((r) => sameRange(segmentRange(r), range));
  return run ? `Run ${runNumber(segments!, run)}` : null;
}

/**
 * A range picked while its run was up (`{ from: run start, to: null }`) once that run has ended:
 * the run as it ended, or null. Left open, it would grow into the next run while still read as
 * that run's figures.
 */
export function endedRun(range: NetRange, segments: NetSegments | null): NetRange | null {
  if (range.to !== null || !segments) return null;
  const run = segments.runs.find((r) => r.from === range.from);
  return run && run.to !== null ? segmentRange(run) : null;
}

/** How a run ended, in words, or null while it runs. */
export function runEnd(r: RunSegment): string | null {
  switch (r.end) {
    case 'stopped': return 'glove down';
    case 'died': return 'ended (gate died)';
    case 'replaced': return 'ended (next run started)';
    default: return null;
  }
}

/** Newest first, as the lists show them. */
export function newestFirst<T extends { from: number }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => b.from - a.from);
}

/** The run a burst is in, by number, for its label; null for one before any run. */
export function burstRun(segments: NetSegments, b: BurstSegment): number | null {
  const run = b.run === null ? undefined : segments.runs.find((r) => r.run === b.run);
  return run ? runNumber(segments, run) : null;
}

export interface Preset {
  key: string;
  label: string;
  range: NetRange;
}

/** The calendar's presets: the last hour, the last 24 h, today, and the latest run if there is one. */
export function presets(now: number, segments: NetSegments | null): Preset[] {
  const out: Preset[] = [
    { key: 'hour', label: 'Last hour', range: { from: now - HOUR, to: null } },
    { key: 'day', label: 'Last 24 h', range: { from: now - 24 * HOUR, to: null } },
    { key: 'today', label: 'Today', range: { from: dayStart(now), to: null } },
  ];
  const run = segments?.runs.at(-1);
  if (run) out.push({ key: 'run', label: run.to === null ? 'This run' : 'Last run', range: segmentRange(run) });
  return out;
}

export interface DayCell {
  /** Local midnight. */
  day: number;
  /** Day of the month. */
  date: number;
  inMonth: boolean;
  flows: number;
  bytes: number;
  /** 0 for no traffic, else 1–4 by share of the month's busiest day (log scale: one busy day must not blank the rest). */
  level: number;
}

/**
 * A month as weeks of seven days, Monday first, with each day's traffic summed from the
 * session's hours. Days outside the month are included to fill the weeks (`inMonth: false`),
 * shaded too, so a week reads whole.
 */
export function monthGrid(year: number, month: number, hours: readonly HourActivity[]): DayCell[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead).getTime();
  const end = new Date(year, month + 1, 1).getTime();
  const byDay = new Map<number, { flows: number; bytes: number }>();
  for (const h of hours) {
    const d = dayStart(h.hour);
    const a = byDay.get(d) ?? { flows: 0, bytes: 0 };
    a.flows += h.flows;
    a.bytes += h.bytesUp + h.bytesDown;
    byDay.set(d, a);
  }
  const cells: DayCell[] = [];
  for (let day = start, i = 0; i < 42; i++, day = nextDay(day)) {
    if (i % 7 === 0 && day >= end && i > 0) break;
    const a = byDay.get(day) ?? { flows: 0, bytes: 0 };
    cells.push({ day, date: new Date(day).getDate(), inMonth: new Date(day).getMonth() === month, flows: a.flows, bytes: a.bytes, level: 0 });
  }
  const max = Math.max(0, ...cells.map((c) => c.flows));
  for (const c of cells) c.level = c.flows === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((4 * Math.log1p(c.flows)) / Math.log1p(max)));
  const weeks: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** The month (year, month) to open the calendar on: the range's start, else the latest activity, else now. */
export function initialMonth(range: NetRange | null, hours: readonly HourActivity[], now: number): { year: number; month: number } {
  const d = new Date(range?.from ?? hours.at(-1)?.hour ?? now);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** The timeline's span: the session's first activity or run to now (or its last, if it has stopped). */
export function timelineSpan(segments: NetSegments, now: number): { from: number; to: number } | null {
  const starts = [...segments.hours.map((h) => h.first), ...segments.runs.map((r) => r.from)];
  if (!starts.length) return null;
  const from = Math.min(...starts);
  const live = segments.runs.some((r) => r.to === null);
  const ends = [...segments.hours.map((h) => h.last), ...segments.runs.map((r) => r.to ?? now)];
  const to = live ? now : Math.max(...ends);
  return to > from ? { from, to } : { from, to: from + HOUR };
}

/** A position along the timeline (0–`width` px) as a time, clamped to the span. */
export function timeAt(x: number, width: number, span: { from: number; to: number }): number {
  const f = width > 0 ? Math.min(1, Math.max(0, x / width)) : 0;
  return Math.round(span.from + f * (span.to - span.from));
}

/** A time's position along the timeline, in px. */
export function xAt(t: number, width: number, span: { from: number; to: number }): number {
  return span.to === span.from ? 0 : ((t - span.from) / (span.to - span.from)) * width;
}

/** The moments a brush edge snaps to: run starts and ends, and agent sessions' first and last events. */
export function timelineMarks(segments: NetSegments): number[] {
  const out = new Set<number>();
  for (const r of segments.runs) {
    out.add(r.from);
    if (r.to !== null) out.add(r.to);
  }
  for (const a of segments.agentSessions) {
    out.add(a.from);
    out.add(a.to);
  }
  return [...out].sort((a, b) => a - b);
}

/** `t` moved to the nearest mark within `tolerance` ms, or left as it is. */
export function snap(t: number, marks: readonly number[], tolerance: number): number {
  let best = t;
  let gap = tolerance;
  for (const m of marks) {
    const d = Math.abs(m - t);
    if (d <= gap) {
      best = m;
      gap = d;
    }
  }
  return best;
}

/**
 * A brush dragged from `a` to `b` (either way) as a range. One reaching the span's end while
 * the session is live stays open, so it keeps growing like the presets do.
 */
export function brushRange(a: number, b: number, span: { from: number; to: number }, live: boolean): NetRange | null {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  if (to - from < 1000) return null;
  return { from, to: live && to >= span.to ? null : to };
}

import { describe, expect, it } from 'vitest';
import {
  brushRange, burstRun, dayStart, fromLocalInput, initialMonth, monthGrid, newestFirst, nextDay, presets, rangeName, runEnd,
  sameRange, snap, timeAt, timelineMarks, timelineSpan, toLocalInput, xAt,
} from './net-picker.js';
import type { HourActivity, NetSegments, RunSegment } from './netobs-types.js';

// Local-time output depends on the machine's zone, so times are built from local parts.
const at = (month: number, day: number, h = 0, m = 0, s = 0) => new Date(2026, month, day, h, m, s).getTime();
const HOUR = 3_600_000;

const run = (id: string, from: number, to: number | null, end: RunSegment['end'] = to === null ? null : 'stopped'): RunSegment =>
  ({ run: id, from, to, end, bytesUp: 0, bytesDown: 0, flows: 0 });
const hour = (t: number, flows: number): HourActivity =>
  ({ hour: Math.floor(t / HOUR) * HOUR, bytesUp: flows, bytesDown: 0, flows, blocked: 0, first: t, last: t + 60_000, inference: false });
const segments = (over: Partial<NetSegments> = {}): NetSegments =>
  ({ token: 'e', gapMs: 6 * HOUR, burstBasis: 'inference', runs: [], bursts: [], agentSessions: [], hours: [], ...over });

describe('net-picker', () => {
  it('round-trips a datetime-local value to the second, and refuses what Date would roll over', () => {
    const t = at(9, 21, 0, 27, 3);
    expect(toLocalInput(t)).toBe('2026-10-21T00:27:03');
    expect(fromLocalInput('2026-10-21T00:27:03')).toBe(t);
    expect(fromLocalInput('2026-10-21T00:27')).toBe(at(9, 21, 0, 27));
    expect([fromLocalInput(''), fromLocalInput('2026-02-30T00:00'), fromLocalInput('nonsense')]).toEqual([null, null, null]);
  });

  it('finds local days', () => {
    expect(dayStart(at(9, 21, 15, 4))).toBe(at(9, 21));
    expect(nextDay(at(9, 21, 15, 4))).toBe(at(9, 22));
  });

  it('names a range that is exactly a run, numbering runs from the first', () => {
    const s = segments({ runs: [run('g_1', at(9, 20), at(9, 20, 5)), run('g_2', at(9, 21), null)] });
    expect(rangeName({ from: at(9, 21), to: null }, s)).toBe('Run 2');
    expect(rangeName({ from: at(9, 21), to: at(9, 22) }, s)).toBeNull();
    expect(rangeName({ from: at(9, 21), to: null }, null)).toBeNull();
    expect(burstRun(s, { from: 0, to: 1, run: 'g_1', bytesUp: 0, bytesDown: 0, flows: 0 })).toBe(1);
    expect(burstRun(s, { from: 0, to: 1, run: null, bytesUp: 0, bytesDown: 0, flows: 0 })).toBeNull();
  });

  it('says how a run ended', () => {
    expect([run('a', 0, 1, 'stopped'), run('b', 0, 1, 'died'), run('c', 0, 1, 'replaced'), run('d', 0, null)].map(runEnd))
      .toEqual(['glove down', 'ended (gate died)', 'ended (next run started)', null]);
  });

  it('lists newest first, without reordering what it was given', () => {
    const xs = [{ from: 1 }, { from: 3 }, { from: 2 }];
    expect(newestFirst(xs).map((x) => x.from)).toEqual([3, 2, 1]);
    expect(xs.map((x) => x.from)).toEqual([1, 3, 2]);
  });

  it('offers presets that keep growing, and the latest run as it is', () => {
    const now = at(9, 21, 15, 4, 5);
    const live = presets(now, segments({ runs: [run('g_1', at(9, 21, 1), null)] }));
    expect(live.map((p) => [p.key, p.label])).toEqual([['hour', 'Last hour'], ['day', 'Last 24 h'], ['today', 'Today'], ['run', 'This run']]);
    expect(live.map((p) => p.range)).toEqual([
      { from: now - HOUR, to: null }, { from: now - 24 * HOUR, to: null }, { from: at(9, 21), to: null }, { from: at(9, 21, 1), to: null },
    ]);
    expect(presets(now, segments({ runs: [run('g_1', at(9, 20), at(9, 20, 3))] })).at(-1)).toMatchObject({ label: 'Last run', range: { from: at(9, 20), to: at(9, 20, 3) } });
    expect(presets(now, null)).toHaveLength(3);
    expect(sameRange(live[0].range, { from: now - HOUR, to: null })).toBe(true);
  });

  it('lays a month out in Monday-first weeks, shaded by flows on a log scale', () => {
    // October 2026 starts on a Thursday: three days of September lead in.
    const weeks = monthGrid(2026, 9, [hour(at(9, 21, 3), 1000), hour(at(9, 21, 9), 1000), hour(at(9, 22, 1), 3), hour(at(9, 30, 1), 0)]);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks[0].slice(0, 4).map((c) => [c.date, c.inMonth])).toEqual([[28, false], [29, false], [30, false], [1, true]]);
    expect(weeks.at(-1)!.at(-1)!.date).toBe(1); // the week ends on Sunday, Nov 1
    const cell = (d: number) => weeks.flat().find((c) => c.inMonth && c.date === d)!;
    expect(cell(21)).toMatchObject({ flows: 2000, level: 4 });
    // Three flows on a 2000-flow month still show.
    expect(cell(22).level).toBeGreaterThanOrEqual(1);
    expect([cell(20).level, cell(30).level]).toEqual([0, 0]);
  });

  it('opens the calendar on the range, else the latest activity, else now', () => {
    expect(initialMonth({ from: at(7, 3), to: null }, [], at(9, 1))).toEqual({ year: 2026, month: 7 });
    expect(initialMonth(null, [hour(at(8, 3), 1)], at(9, 1))).toEqual({ year: 2026, month: 8 });
    expect(initialMonth(null, [], at(9, 1))).toEqual({ year: 2026, month: 9 });
  });

  it('spans the timeline to now while a run is up, else to the last activity', () => {
    const now = at(9, 21, 12);
    const hours = [hour(at(9, 21, 2), 5)];
    expect(timelineSpan(segments({ hours, runs: [run('g', at(9, 21, 1), null)] }), now)).toEqual({ from: at(9, 21, 1), to: now });
    expect(timelineSpan(segments({ hours, runs: [run('g', at(9, 21, 1), at(9, 21, 3))] }), now)).toEqual({ from: at(9, 21, 1), to: at(9, 21, 3) });
    expect(timelineSpan(segments(), now)).toBeNull();
  });

  it('maps the timeline to px and back, clamped', () => {
    const span = { from: 1000, to: 11_000 };
    expect([timeAt(0, 100, span), timeAt(50, 100, span), timeAt(150, 100, span), timeAt(-5, 100, span)]).toEqual([1000, 6000, 11_000, 1000]);
    expect(xAt(6000, 100, span)).toBe(50);
  });

  it('snaps a brush edge to the nearest run or agent-session edge within reach', () => {
    const s = segments({
      runs: [run('g', 1000, 5000)],
      agentSessions: [{ sessionId: 'a', from: 2000, to: 4000, turns: 2, exact: true }],
    });
    const marks = timelineMarks(s);
    expect(marks).toEqual([1000, 2000, 4000, 5000]);
    expect([snap(2100, marks, 200), snap(2300, marks, 200), snap(3050, marks, 1000)]).toEqual([2000, 2300, 4000]);
  });

  it('makes a brush a range either way round, open when it reaches now on a live session', () => {
    const span = { from: 0, to: 10_000 };
    expect(brushRange(8000, 2000, span, false)).toEqual({ from: 2000, to: 8000 });
    expect(brushRange(2000, 10_000, span, true)).toEqual({ from: 2000, to: null });
    expect(brushRange(2000, 10_000, span, false)).toEqual({ from: 2000, to: 10_000 });
    expect(brushRange(2000, 2500, span, false)).toBeNull();
  });
});

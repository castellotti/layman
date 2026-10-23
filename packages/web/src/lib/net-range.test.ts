import { describe, expect, it } from 'vitest';
import { formatDuration, formatRange, formatStamp, rangeGaps, rangeTitle } from './net-range.js';

// Local-time output depends on the machine's zone, so times are built from local parts.
const at = (month: number, day: number, h: number, m: number, s: number) => new Date(2026, month, day, h, m, s).getTime();

describe('net-range', () => {
  it('stamps local time to the second', () => {
    expect(formatStamp(at(9, 21, 0, 27, 3))).toBe('Oct 21 00:27:03');
  });

  it('says how long, in the two largest units', () => {
    expect([formatDuration(40_000), formatDuration(312_000), formatDuration(29 * 3_600_000 + 42 * 60_000), formatDuration(3 * 86_400_000)])
      .toEqual(['40 s', '5 m 12 s', '1 d 5 h', '3 d']);
    expect(formatDuration(7_200_000)).toBe('2 h');
  });

  it('writes a range, leaving out the end’s date on the same day, and "now" for an open one', () => {
    expect(formatRange({ from: at(9, 21, 0, 27, 3), to: at(9, 22, 6, 9, 2) })).toBe('Oct 21 00:27:03 → Oct 22 06:09:02 (1 d 5 h)');
    expect(formatRange({ from: at(9, 21, 8, 0, 0), to: at(9, 21, 8, 47, 5) })).toBe('Oct 21 08:00:00 → 08:47:05 (47 m 5 s)');
    expect(formatRange({ from: at(9, 21, 8, 0, 0), to: null }, at(9, 21, 9, 0, 0))).toBe('Oct 21 08:00:00 → now (1 h)');
    expect(rangeTitle({ from: Date.UTC(2026, 9, 21, 8), to: null })).toBe('2026-10-21T08:00:00.000Z → now (UTC)');
  });

  it('says what a range leaves out', () => {
    const base = { key: 'k', from: at(9, 16, 0, 0, 0), to: null, scannedBytes: 1, truncated: false };
    expect(rangeGaps({ ...base, filesFrom: base.from - 1000 })).toEqual([]);
    expect(rangeGaps({ ...base, filesFrom: at(9, 16, 6, 13, 36) })).toEqual(['glove’s files only reach back to Oct 16 06:13:36: traffic before that is not counted.']);
    expect(rangeGaps({ ...base, filesFrom: at(9, 18, 0, 0, 0), truncated: true })).toHaveLength(2);
    expect(rangeGaps({ ...base, filesFrom: null })).toEqual(['glove keeps no records for this range.']);
  });
});

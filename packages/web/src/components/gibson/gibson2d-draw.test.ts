import { describe, expect, it } from 'vitest';
import { ARRIVAL_MS, RISE_S, arrivalOf, cellPx, riseOf } from './gibson2d-draw.js';

describe('riseOf', () => {
  const freshAt = new Map([['new.org', 10_000]]);
  it('lifts a fresh tower over RISE_S seconds, and leaves any other whole', () => {
    expect(riseOf({ now: 10_000, freshAt, full: true }, 'new.org')).toBe(0);
    expect(riseOf({ now: 10_000 + (RISE_S * 1000) / 2, freshAt, full: true }, 'new.org')).toBeCloseTo(0.5, 9);
    expect(riseOf({ now: 10_000 + RISE_S * 1000 * 3, freshAt, full: true }, 'new.org')).toBe(1);
    expect(riseOf({ now: 10_500, freshAt, full: true }, 'old.org')).toBe(1);
  });
  it('does not rise at all when motion is not full', () => {
    expect(riseOf({ now: 10_000, freshAt, full: false }, 'new.org')).toBe(1);
  });
});

describe('arrivalOf', () => {
  const arrivedAt = new Map([['a.org', 5_000]]);
  it('is 1 at the arrival, falls to 0 after ARRIVAL_MS, and is 0 for a host no car reached', () => {
    expect(arrivalOf({ now: 5_000, arrivedAt }, 'a.org')).toBe(1);
    expect(arrivalOf({ now: 5_000 + ARRIVAL_MS / 2, arrivedAt }, 'a.org')).toBeCloseTo(0.5, 9);
    expect(arrivalOf({ now: 5_000 + ARRIVAL_MS * 2, arrivedAt }, 'a.org')).toBe(0);
    expect(arrivalOf({ now: 5_000, arrivedAt }, 'b.org')).toBe(0);
  });
});

describe('cellPx', () => {
  it('is a text cell\'s height on screen: 12 text units of a 192-unit face, so side / 16 world units', () => {
    expect(cellPx({ cx: 0, cy: 0, scale: 16 }, { side: 2 })).toBeCloseTo(2, 9);
    expect(cellPx({ cx: 0, cy: 0, scale: 32 }, { side: 2 })).toBeCloseTo(4, 9);
    expect(cellPx({ cx: 0, cy: 0, scale: 16 }, { side: 1 })).toBeCloseTo(1, 9);
  });
});

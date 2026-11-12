import { describe, expect, it } from 'vitest';
import { contrast, deltaE, luminance, oklab, parseHex } from './color.js';

describe('color', () => {
  it('parses #rgb and #rrggbb and refuses anything else', () => {
    expect(parseHex('#fff')).toEqual([1, 1, 1]);
    expect(parseHex('#FF0000')).toEqual([1, 0, 0]);
    for (const bad of ['fff', '#ffff', 'red', 'rgb(0,0,0)', '#gggggg']) expect(() => parseHex(bad)).toThrow();
  });

  it('WCAG contrast: black on white is 21, order does not matter, same is 1', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
    // A known pair: #767676 on white is the classic 4.54:1.
    expect(contrast('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(luminance('#FFFFFF')).toBeCloseTo(1, 6);
  });

  it('OKLab: white is L=1 a=b=0, and ΔE is a metric', () => {
    const [l, a, b] = oklab('#FFFFFF');
    expect(l).toBeCloseTo(1, 3);
    expect(a).toBeCloseTo(0, 3);
    expect(b).toBeCloseTo(0, 3);
    expect(deltaE('#5A9CF8', '#5A9CF8')).toBe(0);
    expect(deltaE('#000', '#fff')).toBeCloseTo(1, 3);
    expect(deltaE('#E5A83B', '#5A9CF8')).toBeCloseTo(deltaE('#5A9CF8', '#E5A83B'), 10);
  });
});

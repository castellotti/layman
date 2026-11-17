import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCHEME, SCHEMES, paletteOf, parseScheme, rgbCss, type Palette } from './gibson-schemes.js';

const TONES = ['normal', 'blocked', 'untunnelled', 'local'] as const;
const isRgb = (c: unknown): boolean => Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && v >= 0 && v <= 1);

function complete(p: Palette): void {
  for (const c of [p.board, p.fresh, p.highlight, p.traceA, p.traceB, p.homeRim, ...Object.values(p.sky)]) expect(isRgb(c)).toBe(true);
  if (p.traffic !== null) expect(isRgb(p.traffic)).toBe(true);
  for (const t of TONES) {
    expect(isRgb(p.glass[t])).toBe(true);
    expect(isRgb(p.text[t])).toBe(true);
  }
  expect(typeof p.marks).toBe('boolean');
  expect(typeof p.light).toBe('boolean');
  expect(typeof p.windows).toBe('boolean');
}

const TOKENS: Record<string, string> = {
  bg: '#101418', ok: '#20c080', error: '#e04050', warn: '#e0a020', accent: '#30a0e0', 'accent-hot': '#8060ff', text: '#e8eef4',
};

describe('schemes', () => {
  it('are State, Green, Cyan, Red, Night, in that order, State the default', () => {
    expect(SCHEMES.map((s) => s.id)).toEqual(['state', 'green', 'cyan', 'red', 'night']);
    expect(DEFAULT_SCHEME).toBe('state');
  });
  it('parse a stored id and nothing else', () => {
    expect(parseScheme('night')).toBe('night');
    expect(parseScheme('purple')).toBeNull();
    expect(parseScheme('')).toBeNull();
  });
  it('each yields a complete palette', () => {
    for (const s of SCHEMES) complete(paletteOf(s.id, (n) => TOKENS[n] ?? ''));
  });
  it('State reads tokens, the film schemes never do', () => {
    const token = vi.fn((n: string) => TOKENS[n] ?? '');
    paletteOf('state', token);
    expect(token).toHaveBeenCalled();
    for (const id of ['green', 'cyan', 'red', 'night'] as const) {
      const other = vi.fn((n: string) => TOKENS[n] ?? '');
      paletteOf(id, other);
      expect(other, id).not.toHaveBeenCalled();
    }
  });
  it('State is hue by state; the film schemes are one glass colour and marks', () => {
    const s = paletteOf('state', (n) => TOKENS[n] ?? '');
    expect(s.marks).toBe(false);
    expect(s.glass.blocked).not.toEqual(s.glass.normal);
    expect(s.traffic).toBeNull();
    for (const id of ['green', 'cyan', 'red', 'night'] as const) {
      const p = paletteOf(id, () => '');
      expect(p.marks, id).toBe(true);
      expect(p.light, id).toBe(false);
      expect(p.glass.blocked).toEqual(p.glass.normal);
      expect(p.traffic).not.toBeNull();
    }
    expect(paletteOf('night', () => '').windows).toBe(true);
    expect(paletteOf('green', () => '').windows).toBe(false);
  });
  it('State follows the theme: a light board is light, a dark one is not, and the traces sit toward the board', () => {
    expect(paletteOf('state', (n) => (n === 'bg' ? '#ffffff' : TOKENS[n] ?? '')).light).toBe(true);
    const dark = paletteOf('state', (n) => TOKENS[n] ?? '');
    expect(dark.light).toBe(false);
    // 55 % of the way from the token to the board: closer to the board than the token is
    const accent: [number, number, number] = [0x30 / 255, 0xa0 / 255, 0xe0 / 255];
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(dist(dark.traceA, dark.board)).toBeCloseTo(dist(accent, dark.board) * 0.45, 5);
    // text is the glass 45 % toward white
    expect(dark.text.normal[0]).toBeCloseTo(dark.glass.normal[0] + (1 - dark.glass.normal[0]) * 0.45, 5);
  });
  it('survive a token that is not a hex colour', () => {
    complete(paletteOf('state', () => 'rgb(1, 2, 3)'));
    complete(paletteOf('state', () => ''));
  });
  it('writes a canvas colour', () => {
    expect(rgbCss([1, 0, 0.5])).toBe('rgb(255 0 128)');
    expect(rgbCss([1, 0, 0], 0.5)).toBe('rgb(255 0 0 / 0.5)');
  });
});

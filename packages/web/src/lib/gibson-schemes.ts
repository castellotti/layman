/**
 * The Gibson colour schemes (docs/extensions/styx.md → "Gibson"). Pure.
 *
 * This is the one file besides `themes.ts` that may hold colour literals (`theme-literals.test.ts`): the four
 * film schemes are fixed looks, chosen to read like the film's stills, so they must not follow the user's
 * theme and always draw on their own dark board. `state` is the one that follows it: its colours are the
 * theme's tokens, read through the `token` function the caller hands in (`readToken`), so this file never
 * touches the DOM and a canvas that uses it redraws on `useThemeVersion()`.
 */
import { HEX_COLOR, luminance, parseHex, rgbOf } from './color.js';
import type { Tone } from './gibson-city.js';

export type SchemeId = 'state' | 'green' | 'cyan' | 'red' | 'night';

/** The picker's choices, in order. */
export const SCHEMES: ReadonlyArray<{ id: SchemeId; label: string }> = [
  { id: 'state', label: 'State' },
  { id: 'green', label: 'Green' },
  { id: 'cyan', label: 'Cyan' },
  { id: 'red', label: 'Red' },
  { id: 'night', label: 'Night' },
];

export const DEFAULT_SCHEME: SchemeId = 'state';

export function parseScheme(raw: string): SchemeId | null {
  return SCHEMES.some((s) => s.id === raw) ? (raw as SchemeId) : null;
}

/** [r, g, b] in 0..1. */
export type Rgb = [number, number, number];

export interface Palette {
  board: Rgb;
  glass: Record<Tone, Rgb>;
  text: Record<Tone, Rgb>;
  fresh: Rgb;
  highlight: Rgb;
  traceA: Rgb;
  traceB: Rgb;
  /** null: the target tower's glass colour. */
  traffic: Rgb | null;
  homeRim: Rgb;
  sky: { base: Rgb; strand: Rgb; arc: Rgb; formula: Rgb; wash: Rgb };
  /** State is shown by marks (stripes, dashes), not hue. */
  marks: boolean;
  /** The board is light: draw by cover, never by adding. Only State on a light theme. */
  light: boolean;
  /** Night: far text rows are lit strips. */
  windows: boolean;
}

const WHITE: Rgb = [1, 1, 1];

/** `a` toward `b` by `t` (0..1). */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** `#rrggbb` → Rgb. Only this file's tables use it. */
const hex = (h: string): Rgb => parseHex(h);

const SKY: Palette['sky'] = {
  base: hex('#04021a'), strand: hex('#5a4de0'), arc: hex('#ffb428'), formula: hex('#ff6a8a'), wash: hex('#b8a8ff'),
};
/** Night's sky is the same, dimmer. */
const dim = (s: Palette['sky'], k: number): Palette['sky'] => ({
  base: mix([0, 0, 0], s.base, k), strand: mix([0, 0, 0], s.strand, k), arc: mix([0, 0, 0], s.arc, k),
  formula: mix([0, 0, 0], s.formula, k), wash: mix([0, 0, 0], s.wash, k),
});

interface Film {
  board: string; glass: string; text: string; fresh: string; highlight: string;
  traceA: string; traceB: string; traffic: string; homeRim: string; skyK: number;
}

const FILM: Record<Exclude<SchemeId, 'state'>, Film> = {
  green: { board: '#010a08', glass: '#1ec98a', text: '#8dffc9', fresh: '#e8fff4', highlight: '#5a4dff', traceA: '#6f5cff', traceB: '#ffb47a', traffic: '#c8fff0', homeRim: '#ff3fd0', skyK: 1 },
  cyan: { board: '#01070c', glass: '#2aa8c4', text: '#a8f0ff', fresh: '#e0fbff', highlight: '#8a5cff', traceA: '#2b3cff', traceB: '#7a5cff', traffic: '#e0fbff', homeRim: '#ff3fd0', skyK: 1 },
  red: { board: '#0a0104', glass: '#c8242e', text: '#ff6a5c', fresh: '#ffe0d8', highlight: '#2f6bff', traceA: '#1f6bff', traceB: '#3aa0ff', traffic: '#19f0e6', homeRim: '#ff3fd0', skyK: 1 },
  night: { board: '#05040a', glass: '#2a2530', text: '#ffd9a0', fresh: '#fff0c8', highlight: '#39d0d8', traceA: '#ffb060', traceB: '#fff0c8', traffic: '#ffe9b8', homeRim: '#ffb060', skyK: 0.4 },
};

const every = (c: Rgb): Record<Tone, Rgb> => ({ normal: c, blocked: c, untunnelled: c, local: c });
/** `f` applied to each tone's entry. */
const eachTone = (r: Record<Tone, Rgb>, f: (c: Rgb) => Rgb): Record<Tone, Rgb> => ({
  normal: f(r.normal), blocked: f(r.blocked), untunnelled: f(r.untunnelled), local: f(r.local),
});

function film(id: Exclude<SchemeId, 'state'>): Palette {
  const f = FILM[id];
  return {
    board: hex(f.board), glass: every(hex(f.glass)), text: every(hex(f.text)), fresh: hex(f.fresh), highlight: hex(f.highlight),
    traceA: hex(f.traceA), traceB: hex(f.traceB), traffic: hex(f.traffic), homeRim: hex(f.homeRim),
    sky: f.skyK === 1 ? SKY : dim(SKY, f.skyK), marks: true, light: false, windows: id === 'night',
  };
}

/**
 * The palette of a scheme. `token` reads a theme token (`readToken`); only `state` calls it. State's colours
 * are the theme's: board `--bg`, glass `--ok` / `--error` / `--warn` / `--accent` by tone, highlight
 * `--accent-hot`, fresh `--text`, the two traces `--accent` and `--warn` mixed 55 % toward the board so they stay
 * behind the towers, the home rim `--accent-hot`; the text is the glass 45 % toward white.
 */
export function paletteOf(id: SchemeId, token: (name: string) => string): Palette {
  if (id !== 'state') return film(id);
  const tok = (name: string): Rgb => rgbOf(token(name), name === 'bg' ? [0, 0, 0] : WHITE);
  const bgCss = token('bg').trim();
  const board = tok('bg');
  const glass: Record<Tone, Rgb> = { normal: tok('ok'), blocked: tok('error'), untunnelled: tok('warn'), local: tok('accent') };
  return {
    board, glass,
    text: eachTone(glass, (c) => mix(c, WHITE, 0.45)),
    fresh: tok('text'), highlight: tok('accent-hot'),
    traceA: mix(tok('accent'), board, 0.55), traceB: mix(tok('warn'), board, 0.55), traffic: null, homeRim: tok('accent-hot'),
    sky: SKY, marks: false, light: HEX_COLOR.test(bgCss) && luminance(bgCss) > 0.5, windows: false,
  };
}

/** An Rgb as a canvas colour: `rgb(r g b / a)`. */
export function rgbCss(c: Rgb, alpha = 1): string {
  const [r, g, b] = c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

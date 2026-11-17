/**
 * What the Matrix 3D renderer puts on the GPU, and the arithmetic it shares with its shader: the glyph
 * order, the two data textures' packing, the layers' transform, and which stream is under the pointer.
 * Pure and tested; the shader (`components/matrix/matrix3d-shaders.ts`) cannot be run in a test, so
 * `layerCell` below and the shader's transform are one rule in two copies: change both or neither.
 * Written from scratch: it derives from no styx-godot shader (docs/extensions/styx.md → Licences).
 */
import type { Stream } from './matrix-rain.js';

export const LAYERS = 4;
/** Columns of data per layer (streams are placed in 0..COLS-1). */
export const COLS = 96;
export const TEXT_LEN = 48;
/** Rows on the nearest layer, top to bottom; a layer of scale s shows ROWS × s. */
export const ROWS = 28;
/** A cell is this wide for each unit of its height. */
export const CELL_ASPECT = 0.58;
/** In units of the screen's height. */
export const CELL_H = 1 / ROWS;
export const CELL_W = CELL_ASPECT * CELL_H;
/** The sideways drift's angular speed, rad/s: one swing in about 90 s. */
export const DRIFT_RATE = 0.07;

export const ATLAS_COLS = 16;
export const ATLAS_ROWS = 8;
export const ATLAS_CELL = 64;

const KATAKANA_FROM = 0xff66;
const KATAKANA_TO = 0xff9d;
const SYMBOLS = '=*+<>|/\\#$%&@?!;,()[]{}~^"\'`×÷±';

/** The atlas, in order: 0 blank, digits, letters, `. - : _`, half-width katakana, symbols to fill 16 × 8. */
export const GLYPHS: readonly string[] = (() => {
  const out = [' '];
  for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-:_') out.push(c);
  for (let u = KATAKANA_FROM; u <= KATAKANA_TO; u++) out.push(String.fromCharCode(u));
  for (const c of SYMBOLS) out.push(c);
  return out.slice(0, ATLAS_COLS * ATLAS_ROWS);
})();

const INDEX = new Map(GLYPHS.map((g, i) => [g, i]));

/** The atlas index of a character; lower case reads as upper, anything the atlas lacks as blank (0). */
export function glyphIndex(ch: string): number {
  return INDEX.get(ch) ?? INDEX.get(ch.toUpperCase()) ?? 0;
}

export interface Layer {
  /** Cells per screen height are ROWS × scale: far layers are larger, so their glyphs are smaller. */
  scale: number;
  /** Multiplies a stream's rows per second. */
  speed: number;
  /** Multiplies brightness. */
  dim: number;
  /** Amplitude of the sideways drift, in screen heights, before `scale`. Nearer layers swing more. */
  drift: number;
}

/** Far to near; the last is the plane that carries the readable data. */
export const LAYER_SPECS: readonly Layer[] = [
  { scale: 2.6, speed: 0.45, dim: 0.3, drift: 0.01 },
  { scale: 1.9, speed: 0.6, dim: 0.5, drift: 0.02 },
  { scale: 1.3, speed: 0.85, dim: 0.8, drift: 0.035 },
  { scale: 1.0, speed: 1.0, dim: 1.0, drift: 0.06 },
];
export const NEAR = LAYERS - 1;

export interface Grid {
  /** Columns that span the screen on this layer. */
  vis: number;
  /** Of those, how many carry data: the middle `data`, at most COLS. */
  data: number;
  /** The first data column's place among the visible ones. */
  offset: number;
}

/** The columns of a layer for a screen of this aspect (width over height). Passed to the shader, not recomputed there. */
export function gridOf(aspect: number, layer: number): Grid {
  const vis = Math.max(1, Math.ceil((aspect * LAYER_SPECS[layer].scale) / CELL_W));
  const data = Math.min(COLS, vis);
  return { vis, data, offset: Math.floor((vis - data) / 2) };
}

/** `uGrid[LAYERS]` as the shader reads it: vis, data, offset per layer. */
export function gridUniform(aspect: number): Float32Array {
  const out = new Float32Array(LAYERS * 3);
  for (let l = 0; l < LAYERS; l++) {
    const g = gridOf(aspect, l);
    out.set([g.vis, g.data, g.offset], l * 3);
  }
  return out;
}

/** Rows a layer shows (fractional). */
export const rowsOf = (layer: number): number => ROWS * LAYER_SPECS[layer].scale;

/** The colour-less kind of a stream, as the column texture holds it. */
const TONE = { normal: 0, blocked: 1, untunnelled: 2 } as const;

/**
 * The column texture, `COLS × LAYERS` RGBA32F, row `layer`, texel `column`: r start (s since the
 * epoch), g rows/s, b text length (0: no stream), a = tone + 4 × fresh + weight / 2.
 * `streams[layer]` are that layer's streams; a layer with none is left all zero.
 */
export function packColumns(streams: readonly (readonly Stream[])[], epochMs: number): Float32Array {
  const out = new Float32Array(LAYERS * COLS * 4);
  for (let layer = 0; layer < LAYERS; layer++) {
    for (const s of streams[layer] ?? []) {
      if (s.column < 0 || s.column >= COLS) continue;
      const i = (layer * COLS + s.column) * 4;
      out[i] = (s.startAt - epochMs) / 1000;
      out[i + 1] = s.speed;
      out[i + 2] = Math.min(TEXT_LEN, s.text.length);
      out[i + 3] = TONE[s.tone] + (s.fresh ? 4 : 0) + Math.min(1, Math.max(0, s.weight)) / 2;
    }
  }
  return out;
}

/** The text texture, `TEXT_LEN × (COLS × LAYERS)` R8: row `layer × COLS + column` holds that stream's glyph indices. */
export function packText(streams: readonly (readonly Stream[])[]): Uint8Array {
  const out = new Uint8Array(LAYERS * COLS * TEXT_LEN);
  for (let layer = 0; layer < LAYERS; layer++) {
    for (const s of streams[layer] ?? []) {
      if (s.column < 0 || s.column >= COLS) continue;
      const base = (layer * COLS + s.column) * TEXT_LEN;
      for (let i = 0; i < Math.min(TEXT_LEN, s.text.length); i++) out[base + i] = glyphIndex(s.text[i]);
    }
  }
  return out;
}

/** Changes exactly when a stream starts, ends or moves column: the only time the data textures are rewritten. */
export function streamsKey(streams: readonly (readonly Stream[])[]): string {
  return streams.map((l) => l.map((s) => `${s.column}:${s.address}:${s.startAt}:${s.fresh ? 1 : 0}`).join(',')).join('|');
}

/**
 * Screen position (uv, 0..1, y down) → that layer's cell at `t` seconds: `row` counts from the top,
 * `col` is the stream column (so it is outside 0..COLS-1 where the layer has no data).
 * Mirrors the shader's layer transform.
 */
export function layerCell(uv: readonly [number, number], layer: number, t: number, aspect: number): { col: number; row: number } {
  const spec = LAYER_SPECS[layer];
  const g = gridOf(aspect, layer);
  const px = ((uv[0] - 0.5) * aspect + spec.drift * Math.sin(t * DRIFT_RATE)) * spec.scale;
  const py = (uv[1] - 0.5) * spec.scale;
  return { col: Math.floor(px / CELL_W + g.vis / 2) - g.offset, row: Math.floor(py * ROWS + (ROWS * spec.scale) / 2) };
}

/** The nearest stream under the pointer, or null. `t` is seconds since `epochMs`. */
export function pick(
  uv: readonly [number, number], t: number, aspect: number, streams: readonly (readonly Stream[])[], epochMs: number,
): Stream | null {
  for (let layer = LAYERS - 1; layer >= 0; layer--) {
    const { col, row } = layerCell(uv, layer, t, aspect);
    const s = (streams[layer] ?? []).find((x) => x.column === col);
    if (!s) continue;
    const head = (t - (s.startAt - epochMs) / 1000) * s.speed * LAYER_SPECS[layer].speed;
    const d = head - row;
    if (d >= 0 && d < Math.min(TEXT_LEN, s.text.length)) return s;
  }
  return null;
}

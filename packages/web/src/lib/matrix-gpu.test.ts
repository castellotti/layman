import { describe, expect, it } from 'vitest';
import {
  ATLAS_COLS, ATLAS_ROWS, CELL_W, COLS, GLYPHS, LAYERS, LAYER_SPECS, NEAR, TEXT_LEN,
  SECOND, assignLayers, glyphIndex, gridOf, gridUniform, layerCell, packColumns, packText, pick, rowsOf, streamsKey, visibleRowsFor,
} from './matrix-gpu.js';
import { streamText, type Stream } from './matrix-rain.js';

function stream(address: string, column: number, over: Partial<Stream> = {}): Stream {
  return { address, text: streamText(address), column, speed: 10, startAt: 0, tone: 'normal', weight: 0, fresh: false, ...over };
}
const none = (): Stream[][] => Array.from({ length: LAYERS }, () => []);

describe('glyphs', () => {
  it('the atlas fills its grid with distinct glyphs, blank first', () => {
    expect(GLYPHS).toHaveLength(ATLAS_COLS * ATLAS_ROWS);
    expect(new Set(GLYPHS).size).toBe(GLYPHS.length);
    expect(GLYPHS[0]).toBe(' ');
  });

  it('covers every character streamText can produce, none as blank', () => {
    const text = streamText('Ab0123456789.:_-[::1]:443 api.exämple.com/x~');
    for (const ch of new Set(text)) expect(glyphIndex(ch), ch).toBeGreaterThan(0);
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.:_-') expect(glyphIndex(ch), ch).toBeGreaterThan(0);
  });

  it('reads lower case as upper and an unknown character as blank', () => {
    expect(glyphIndex('a')).toBe(glyphIndex('A'));
    expect(glyphIndex('é')).toBe(0);
    expect(glyphIndex(' ')).toBe(0);
  });
});

describe('packing', () => {
  it('packColumns writes nothing for empty columns, and a stream where it is', () => {
    const s = none();
    s[NEAR] = [stream('a.com:443', 5, { startAt: 3500, speed: 12, tone: 'blocked', fresh: true, weight: 1 })];
    const out = packColumns(s, 1000);
    expect(out).toHaveLength(LAYERS * COLS * 4);
    const i = (NEAR * COLS + 5) * 4;
    expect(Array.from(out.slice(i, i + 4))).toEqual([2.5, 12, 'A.COM:443'.length, 1 + 4 + 0.5]);
    expect(out.slice(0, i).every((v) => v === 0)).toBe(true);
    expect(out[i + 4]).toBe(0);
  });

  it('packColumns encodes tone, fresh and weight so the shader can take them apart', () => {
    for (const tone of ['normal', 'blocked', 'untunnelled'] as const) {
      for (const fresh of [false, true]) {
        for (const weight of [0, 0.3, 1]) {
          const s = none();
          s[0] = [stream('x', 0, { tone, fresh, weight })];
          const a = packColumns(s, 0)[3];
          expect(Math.floor(a) % 4).toBe({ normal: 0, blocked: 1, untunnelled: 2 }[tone]);
          expect(Math.floor(a / 4)).toBe(fresh ? 1 : 0);
          expect(2 * (a - Math.floor(a))).toBeCloseTo(weight, 6);
        }
      }
    }
  });

  it('packColumns ignores a column outside the texture and caps the length', () => {
    const s = none();
    s[1] = [stream('a', COLS), stream('b', -1), stream('c'.repeat(80), 2, { text: 'C'.repeat(80) })];
    const out = packColumns(s, 0);
    expect(out[(1 * COLS + 2) * 4 + 2]).toBe(TEXT_LEN);
    expect(out.filter((v, i) => i % 4 === 2 && v > 0)).toHaveLength(1);
  });

  it('packText puts a stream in its row, in order, padded with 0', () => {
    const s = none();
    s[NEAR] = [stream('ab.c', 7)];
    const out = packText(s);
    const base = (NEAR * COLS + 7) * TEXT_LEN;
    expect(Array.from(out.slice(base, base + 6))).toEqual([glyphIndex('A'), glyphIndex('B'), glyphIndex('.'), glyphIndex('C'), 0, 0]);
    expect(out.slice(0, base).every((v) => v === 0)).toBe(true);
  });

  it('streamsKey changes when a stream starts, ends or moves, not when only time passes', () => {
    const a = none();
    a[NEAR] = [stream('a', 1)];
    const same = none();
    same[NEAR] = [stream('a', 1)];
    expect(streamsKey(a)).toBe(streamsKey(same));
    const moved = none();
    moved[NEAR] = [stream('a', 2)];
    expect(streamsKey(a)).not.toBe(streamsKey(moved));
    expect(streamsKey(a)).not.toBe(streamsKey(none()));
    const later = none();
    later[NEAR] = [stream('a', 1, { startAt: 9 })];
    expect(streamsKey(a)).not.toBe(streamsKey(later));
  });
});

describe('layers', () => {
  it('runs far to near, each nearer layer larger, brighter and faster', () => {
    expect(LAYER_SPECS).toHaveLength(LAYERS);
    for (let i = 1; i < LAYERS; i++) {
      expect(LAYER_SPECS[i].scale).toBeLessThan(LAYER_SPECS[i - 1].scale);
      expect(LAYER_SPECS[i].dim).toBeGreaterThan(LAYER_SPECS[i - 1].dim);
      expect(LAYER_SPECS[i].speed).toBeGreaterThan(LAYER_SPECS[i - 1].speed);
    }
    expect(LAYER_SPECS[NEAR].scale).toBe(1);
  });

  it('gridOf centres the data when the layer has more columns than data', () => {
    const wide = 16 / 9;
    expect(gridOf(wide, NEAR)).toEqual({ vis: Math.ceil(wide / CELL_W), data: Math.min(COLS, Math.ceil(wide / CELL_W)), offset: 0 });
    const far = gridOf(wide, 0);
    expect(far.data).toBe(COLS);
    expect(far.offset).toBe(Math.floor((far.vis - COLS) / 2));
    expect(Array.from(gridUniform(wide).slice(0, 3))).toEqual([far.vis, far.data, far.offset]);
  });

  it('layerCell, hand-computed: the centre and the top-left corner at t = 0', () => {
    const aspect = 16 / 9;
    // Near layer: scale 1, 86 columns across, 28 rows.
    expect(gridOf(aspect, NEAR).vis).toBe(86);
    expect(layerCell([0.5, 0.5], NEAR, 0, aspect)).toEqual({ col: 43, row: 14 });
    expect(layerCell([0, 0], NEAR, 0, aspect)).toEqual({ col: 0, row: 0 });
    expect(layerCell([0.999, 0.999], NEAR, 0, aspect)).toEqual({ col: 85, row: 27 });
    // Farthest: scale 2.6, 224 columns across, 96 of them data from column 64; 72.8 rows.
    expect(gridOf(aspect, 0)).toEqual({ vis: 224, data: 96, offset: 64 });
    expect(layerCell([0.5, 0.5], 0, 0, aspect)).toEqual({ col: 48, row: 36 });
  });

  it('layerCell drifts sideways with time, nearer layers further', () => {
    const aspect = 1.6;
    const at = (layer: number, t: number) => layerCell([0.5, 0.5], layer, t, aspect).col;
    const t = Math.PI / 2 / 0.07; // the swing's peak
    expect(at(NEAR, t)).toBeGreaterThan(at(NEAR, 0));
    expect(at(NEAR, t) - at(NEAR, 0)).toBeGreaterThan(at(0, t) - at(0, 0));
  });
});

describe('pick', () => {
  const aspect = 16 / 9;

  it('finds the stream whose cell is under the pointer, and only inside its text', () => {
    const s = none();
    s[NEAR] = [stream('abcdefgh', 43, { startAt: 0, speed: 10 })];
    // At t = 2 s the head is at row 20; its 8 characters occupy rows 13..20 (d = 20 - row, 0..7).
    expect(pick([0.5, (14 + 0.5) / 28], 2, aspect, s, 0)?.address).toBe('abcdefgh');
    expect(pick([0.5, (20.5) / 28], 2, aspect, s, 0)?.address).toBe('abcdefgh');
    expect(pick([0.5, (12.5) / 28], 2, aspect, s, 0)).toBeNull();
    expect(pick([0.5, (21.5) / 28], 2, aspect, s, 0)).toBeNull();
  });

  it('returns null on empty space and for a column with no stream', () => {
    expect(pick([0.5, 0.5], 1, aspect, none(), 0)).toBeNull();
    const s = none();
    s[NEAR] = [stream('x', 10)];
    expect(pick([0.5, 0.5], 1, aspect, s, 0)).toBeNull();
  });

  it('prefers the nearest layer when two streams are under the pointer', () => {
    const t = 2;
    const far = stream('far', layerCell([0.5, 0.5], 2, t, aspect).col, { text: 'F'.repeat(40), speed: 14 });
    const near = stream('near', layerCell([0.5, 0.5], NEAR, t, aspect).col, { text: 'N'.repeat(40), speed: 10 });
    const both = none();
    both[2] = [far];
    both[NEAR] = [near];
    const onlyFar = none();
    onlyFar[2] = [far];
    expect(pick([0.5, 0.5], t, aspect, onlyFar, 0)?.address).toBe('far');
    expect(pick([0.5, 0.5], t, aspect, both, 0)?.address).toBe('near');
  });
});

describe('assignLayers', () => {
  const row = (address: string, count: number) => ({ address, sent: 0, received: 0, count, blocked: 0, untunnelled: false });
  const rows = [row('a:1', 9), row('b:1', 8), row('c:1', 7), row('d:1', 6), row('e:1', 5)];
  const known = new Set(rows.map((r) => r.address));

  it('puts the most reached half near and the rest behind', () => {
    const { near, second } = assignLayers(rows, known, new Map());
    expect(near.map((r) => r.address)).toEqual(['a:1', 'b:1', 'c:1']);
    expect(second.map((r) => r.address)).toEqual(['d:1', 'e:1']);
  });

  it('a fresh address is always near, whatever its reach', () => {
    const { near } = assignLayers(rows, new Set(['a:1', 'b:1', 'c:1', 'd:1']), new Map());
    expect(near.map((r) => r.address)).toContain('e:1');
  });

  it('nothing is fresh while known is null', () => {
    const { second } = assignLayers(rows, null, new Map());
    expect(second.map((r) => r.address)).toEqual(['d:1', 'e:1']);
  });

  it('a stream already falling stays on its plane', () => {
    const { near, second } = assignLayers(rows, known, new Map([['a:1', SECOND], ['e:1', NEAR]]));
    expect(second.map((r) => r.address)).toContain('a:1');
    expect(near.map((r) => r.address)).toContain('e:1');
  });

  it('every row lands on exactly one plane', () => {
    const { near, second } = assignLayers(rows, known, new Map([['c:1', SECOND]]));
    expect(near.length + second.length).toBe(rows.length);
  });
});

describe('visibleRowsFor', () => {
  it('is the layer\'s rows on the near plane, and grows as a layer slows', () => {
    expect(visibleRowsFor(NEAR)).toBe(Math.ceil(rowsOf(NEAR)));
    expect(visibleRowsFor(SECOND)).toBeGreaterThan(rowsOf(SECOND));
  });

  it('never ends a stream whose last character is still on screen', () => {
    for (const layer of [SECOND, NEAR]) {
      const ls = LAYER_SPECS[layer].speed;
      for (const len of [1, 20, TEXT_LEN]) {
        // planStreams ends a stream when head - len > V; the screen shows it until head × ls - len > rows.
        const headWhenGone = (rowsOf(layer) + len) / ls;
        expect(headWhenGone - len).toBeLessThanOrEqual(visibleRowsFor(layer) + 1e-9);
      }
    }
  });
});

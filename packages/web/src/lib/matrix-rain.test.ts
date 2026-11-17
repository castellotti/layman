import { describe, expect, it } from 'vitest';
import { hash01, headRow, planStreams, speedOf, streamDone, streamText, toneOf, weightsOf, type PlanInput, type Stream } from './matrix-rain.js';
import type { MatrixRow } from './matrix-feed.js';

const row = (address: string, count = 1, over: Partial<MatrixRow> = {}): MatrixRow =>
  ({ address, sent: 0, received: 0, count, blocked: 0, untunnelled: false, ...over });

/** A small seeded generator, so a plan is repeatable. */
function seeded(seed = 7): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const plan = (over: Partial<PlanInput> & Pick<PlanInput, 'rows'>): Stream[] =>
  planStreams({ columns: 10, visibleRows: 30, now: 0, current: [], lastColumn: new Map(), known: null, rand: seeded(), ...over });

describe('streamText', () => {
  it('upper-cases and replaces what the font may lack', () => {
    expect(streamText('api.github.com:443')).toBe('API.GITHUB.COM:443');
    expect(streamText('münchen.example')).toBe('M-NCHEN.EXAMPLE');
  });
  it('reads an IPv6 address without its brackets', () => {
    expect(streamText('[::1]:443')).toBe('::1:443');
  });
  it('keeps at most 48 characters', () => {
    expect(streamText('a'.repeat(65))).toHaveLength(48);
  });
});

describe('speed, tone, weight', () => {
  it('speed runs from 6 to 26 rows a second, linear in the share of the busiest', () => {
    expect(speedOf(1, 100)).toBeCloseTo(6.2);
    expect(speedOf(100, 100)).toBe(26);
    expect(speedOf(50, 100)).toBe(16);
    expect(speedOf(0, 0)).toBe(6);
  });
  it('blocked beats untunnelled beats normal', () => {
    expect(toneOf(row('a', 1, { blocked: 1, untunnelled: true }))).toBe('blocked');
    expect(toneOf(row('a', 1, { untunnelled: true }))).toBe('untunnelled');
    expect(toneOf(row('a'))).toBe('normal');
  });
  it('weight follows bytes, or counts when nothing moved a byte', () => {
    const w = weightsOf([row('a', 1, { received: 1000 }), row('b', 1, { received: 10 })]);
    expect(w.get('a')).toBe(1);
    expect(w.get('b')!).toBeLessThan(1);
    const c = weightsOf([row('a', 4), row('b', 1)]);
    expect([c.get('a'), c.get('b')]).toEqual([1, 0.25]);
  });
});

describe('headRow and streamDone', () => {
  const s: Stream = { address: 'a', text: 'ABCD', column: 0, speed: 10, startAt: 1000, tone: 'normal', weight: 0, fresh: false };
  it('the head is at row 0 when the stream starts and moves at its speed', () => {
    expect(headRow(s, 1000)).toBe(0);
    expect(headRow(s, 2000)).toBe(10);
  });
  it('it is done once the last character has left the bottom', () => {
    expect(streamDone(s, 1000 + 3000, 30)).toBe(false); // head at 30, text 4 behind
    expect(streamDone(s, 1000 + 3500, 30)).toBe(true); // head at 35 > 30 + 4
  });
});

describe('planStreams', () => {
  const rows = ['a.test:443', 'b.test:443', 'c.test:443'].map((a, i) => row(a, 10 - i));

  it('is repeatable with a seeded rand and uses distinct columns', () => {
    const one = plan({ rows });
    const two = plan({ rows });
    expect(one).toEqual(two);
    expect(new Set(one.map((s) => s.column)).size).toBe(one.length);
    expect(one).toHaveLength(3);
  });

  it('makes nothing from no rows or no columns', () => {
    expect(plan({ rows: [] })).toEqual([]);
    expect(plan({ rows, columns: 0 })).toEqual([]);
  });

  it('keeps a falling stream unchanged when the data refreshes', () => {
    const first = plan({ rows });
    const next = plan({ rows: rows.map((r) => ({ ...r, count: r.count + 5 })), current: first, now: 500, rand: seeded(99) });
    expect(next).toEqual(first);
  });

  it('does not restart an address that left the feed, and starts it again once finished', () => {
    const first = plan({ rows });
    const gone = rows.filter((r) => r.address !== 'a.test:443');
    const mid = plan({ rows: gone, current: first, now: 500 });
    expect(mid.map((s) => s.address).sort()).toEqual(['a.test:443', 'b.test:443', 'c.test:443']);
    const late = plan({ rows: gone, current: first, now: 120_000 });
    expect(late.map((s) => s.address)).not.toContain('a.test:443');
  });

  it('lets the least reached wait when there are more rows than columns', () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`h${i}.test`, 100 - i));
    const out = plan({ rows: many, columns: 4 });
    expect(out.map((s) => s.address).sort()).toEqual(['h0.test', 'h1.test', 'h2.test', 'h3.test']);
  });

  it('avoids the column an address used last time while another is free', () => {
    for (let seed = 1; seed < 30; seed++) {
      const out = plan({ rows: [row('a.test')], columns: 4, lastColumn: new Map([['a.test', 2]]), rand: seeded(seed) });
      expect(out[0].column).not.toBe(2);
    }
  });

  it('nothing is fresh when known is null', () => {
    expect(plan({ rows, known: null }).some((s) => s.fresh)).toBe(false);
  });

  it('an address not in known starts at once, fresh and at least 22 rows a second; a known one does not', () => {
    const out = plan({ rows: [row('old.test', 1), row('new.test', 1)], known: new Set(['old.test']) });
    const fresh = out.find((s) => s.address === 'new.test')!;
    expect(fresh).toMatchObject({ fresh: true, startAt: 0 });
    expect(fresh.speed).toBeGreaterThanOrEqual(22);
    expect(out.find((s) => s.address === 'old.test')!.fresh).toBe(false);
  });

  it('a new address takes its place before others when columns are short, and is not fresh on its second fall', () => {
    const known = new Set(['a.test', 'b.test']);
    const out = plan({ rows: [row('a.test', 50), row('b.test', 40), row('new.test', 1)], columns: 2, known });
    expect(out.map((s) => s.address)).toContain('new.test');
    const again = plan({ rows: [row('new.test', 1)], known: new Set(['new.test']) });
    expect(again[0].fresh).toBe(false);
  });

  it('with every column busy, a new address takes the column of the least reached stream that is not fresh', () => {
    const busy = plan({ rows: [row('a.test', 50), row('b.test', 5)], columns: 2, known: new Set(['a.test', 'b.test']) });
    const out = plan({ rows: [row('a.test', 50), row('b.test', 5), row('new.test', 1)], columns: 2, current: busy, now: 100, known: new Set(['a.test', 'b.test']) });
    expect(out.map((s) => s.address).sort()).toEqual(['a.test', 'new.test']);
    const bColumn = busy.find((s) => s.address === 'b.test')!.column;
    expect(out.find((s) => s.address === 'new.test')!.column).toBe(bColumn);
  });

  it('never drops a fresh stream to make room for another new one', () => {
    const first = plan({ rows: [row('n1.test')], columns: 1, known: new Set() });
    const out = plan({ rows: [row('n1.test'), row('n2.test')], columns: 1, current: first, now: 50, known: new Set(['n1.test']) });
    expect(out.map((s) => s.address)).toEqual(['n1.test']);
  });
});

describe('hash01', () => {
  it('is stable and within 0..1', () => {
    expect(hash01('a.com:443')).toBe(hash01('a.com:443'));
    for (const a of ['', 'a', 'api.github.com:443']) expect(hash01(a)).toBeGreaterThanOrEqual(0), expect(hash01(a)).toBeLessThan(1);
    expect(hash01('a')).not.toBe(hash01('b'));
  });
});

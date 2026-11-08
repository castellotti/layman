import { describe, expect, it } from 'vitest';
import { isLlmDestination, tokenTiles } from './net-tokens.js';

describe('net-tokens', () => {
  it('gives the tiles to the LLM path only', () => {
    expect(isLlmDestination({ tools: ['llm'] })).toBe(true);
    expect(isLlmDestination({ tools: ['web_fetch', 'search'] })).toBe(false);
  });

  it('makes five tiles, thinking with its share of output', () => {
    const tiles = tokenTiles({ input: 51070, output: 2786, cacheRead: 0, cacheWrite: 0, reasoning: 1355 });
    expect(tiles.map((t) => [t.label, t.value])).toEqual([
      ['INPUT', '51.1k'], ['OUTPUT', '2.8k'], ['CACHE READ', '0'], ['CACHE WRITE', '0'], ['THINKING', '1.4k'],
    ]);
    expect(tiles[4].sub).toBe('49% of output');
    expect(tiles[0].exact).toBe('51,070 tokens');
    expect(tokenTiles({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })[4].sub).toBeUndefined();
  });

  it('leaves out the optional kinds the session never reported', () => {
    const t = { input: 156, output: 100, cacheRead: 179603, cacheWrite: 0, reasoning: 67 };
    expect(tokenTiles(t, ['cacheRead', 'reasoning']).map((x) => x.label)).toEqual(['INPUT', 'OUTPUT', 'CACHE READ', 'THINKING']);
    expect(tokenTiles(t, []).map((x) => x.label)).toEqual(['INPUT', 'OUTPUT']);
    // reported in the session but 0 in this range: still shown, as 0
    expect(tokenTiles(t, ['cacheWrite']).find((x) => x.label === 'CACHE WRITE')?.exact).toBe('0 tokens');
  });
});

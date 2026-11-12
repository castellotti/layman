import { describe, expect, it } from 'vitest';
import { contrast, parseHex } from '../../lib/color.js';
import { THEMES, type TokenMap } from '../../lib/themes.js';
import type { Token } from '../../lib/tokens.js';
import { ALARM } from './netui.js';

/** `color-mix(in srgb, var(--a) N%, var(--b))` in a theme, as `#rrggbb` (sRGB mixes gamma-encoded values). */
function resolve(mix: string, tokens: TokenMap): string {
  const m = /^color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--([\w-]+)\)\)$/.exec(mix);
  if (!m) throw new Error(`not a two-token mix: ${mix}`);
  const [a, b] = [parseHex(tokens[m[1] as Token]), parseHex(tokens[m[3] as Token])];
  const p = Number(m[2]) / 100;
  return '#' + a.map((x, i) => Math.round((x * p + b[i] * (1 - p)) * 255).toString(16).padStart(2, '0')).join('');
}

describe('the untunnelled alarm', () => {
  // Its colours are mixes, which `themeProblems` cannot see, so they are checked here per theme.
  it.each(THEMES.map((t) => [t.id, t.tokens] as const))('reads at AA in %s', (_id, tokens) => {
    const ground = resolve(ALARM.ground, tokens);
    for (const key of ['text', 'title', 'body'] as const) {
      expect(contrast(resolve(ALARM[key], tokens), ground), `${key} on the banner`).toBeGreaterThanOrEqual(4.5);
    }
    // ALARM.text also marks an alarming value on the panels' own grounds.
    for (const g of ['bg', 'bg-raised', 'bg-card'] as const) {
      expect(contrast(resolve(ALARM.text, tokens), tokens[g]), `text on ${g}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

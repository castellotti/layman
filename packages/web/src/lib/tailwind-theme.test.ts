import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from '../../tailwind.config.js';
import { TOKENS } from './themes.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('Tailwind follows the theme', () => {
  it('its colours are exactly the theme tokens, each a reference to its variable', () => {
    const colors = config.theme.extend.colors as Record<string, string>;
    expect(Object.keys(colors).sort()).toEqual([...TOKENS].sort());
    for (const [name, value] of Object.entries(colors)) {
      expect(value, name).toBe(`color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`);
    }
  });

  it('its fonts are the theme variables', () => {
    expect(config.theme.extend.fontFamily).toEqual({ ui: ['var(--font-ui)'], mono: ['var(--font-mono)'] });
  });

  it('no class puts an opacity modifier on an arbitrary var(), which Tailwind 3 silently drops', () => {
    const found = sources(SRC).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\[var\(--[\w-]+\)\]\/\d+/g)].map((m) => `${file.slice(SRC.length + 1)}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });
});

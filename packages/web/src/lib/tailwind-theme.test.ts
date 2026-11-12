import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config, { tokenColor } from '../../tailwind.config.js';
import { TOKENS } from './themes.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(SRC, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('Tailwind follows the theme', () => {
  it('its colours are exactly the theme tokens, each its variable at any opacity', () => {
    const colors = config.theme.extend.colors as unknown as Record<string, (o: { opacityValue?: string }) => string>;
    expect(Object.keys(colors).sort()).toEqual([...TOKENS].sort());
    for (const [name, color] of Object.entries(colors)) {
      expect(color({}), name).toBe(`var(--${name})`);
      expect(color({ opacityValue: '0.1' }), name).toContain(`var(--${name})`);
    }
  });

  it('every opacity modifier Tailwind can pass becomes a valid color-mix percentage', () => {
    expect(tokenColor('ok')).toBe('var(--ok)');
    expect(tokenColor('ok', '0.1')).toBe('color-mix(in srgb, var(--ok) calc(0.1 * 100%), transparent)');
    expect(tokenColor('ok', 'var(--tw-bg-opacity, 1)')).toBe(
      'color-mix(in srgb, var(--ok) calc(var(--tw-bg-opacity, 1) * 100%), transparent)',
    );
    expect(tokenColor('ok', '35%')).toBe('color-mix(in srgb, var(--ok) 35%, transparent)');
  });

  it('its fonts are the theme variables', () => {
    expect(config.theme.extend.fontFamily).toEqual({
      ui: ['var(--font-ui)'], sans: ['var(--font-ui)'], mono: ['var(--font-mono)'],
    });
  });

  it('no class puts an opacity modifier on an arbitrary var() (`bg-[var(--ok)]/10`), which Tailwind 3 silently drops', () => {
    const dropped = /\[(?:[\w-]+:)?var\(--[^\]]+\)\]\/(?:\d+|\[[^\]]+\])/g;
    const found = [join(WEB, 'index.html'), ...sources(SRC)].flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(dropped)].map((m) => `${file.slice(WEB.length + 1)}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });
});

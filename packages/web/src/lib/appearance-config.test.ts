import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_APPEARANCE, DENSITIES, FONTS, MOTIONS, THEMES } from './themes.js';

const schema = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../server/src/config/schema.ts'), 'utf8',
);

/** The string array a server constant holds: `export const NAME = ['a', 'b'] as const;`. */
function serverList(name: string): string[] {
  const m = schema.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`));
  if (!m) throw new Error(`${name} not found in the server schema`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** Each AppearanceSchema field's default, from its `.catch('x').default('x')`. */
function serverDefaults(): Record<string, string> {
  const block = schema.slice(schema.indexOf('export const AppearanceSchema'));
  const body = block.slice(0, block.indexOf('});'));
  return Object.fromEntries(
    [...body.matchAll(/^\s+(\w+): [^\n]*\.catch\('([^']+)'\)\.default\('\2'\)/gm)].map((m) => [m[1], m[2]]),
  );
}

describe('the server validates appearance with the web\'s choices', () => {
  it('the same theme ids, fonts, densities and motions', () => {
    expect(serverList('THEME_IDS')).toEqual(THEMES.map((t) => t.id));
    expect(serverList('FONT_CHOICES')).toEqual([...FONTS]);
    expect(serverList('DENSITIES')).toEqual([...DENSITIES]);
    expect(serverList('MOTIONS')).toEqual([...MOTIONS]);
  });

  it('the same defaults', () => {
    const { overrides: _, ...defaults } = DEFAULT_APPEARANCE;
    expect(serverDefaults()).toEqual(defaults);
  });
});

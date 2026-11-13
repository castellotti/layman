import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function components(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return components(p);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [p] : [];
  });
}

/**
 * A component's spacing, corners and lines follow Appearance (density, the theme's radius and
 * stroke): an inline style writes `sp(8)` / `rad(6)` and `var(--stroke)`, never a bare px value,
 * and Tailwind's own classes are scaled in `tailwind.config.ts`. A bare value would stay put
 * when the user picks Comfortable or a square theme.
 */
describe('components follow density and shape', () => {
  const lines = components(SRC).flatMap((file) =>
    readFileSync(file, 'utf8').split('\n').map((text, i) => ({ where: `${file.slice(SRC.length + 1)}:${i + 1}`, text })),
  );
  const found = (pattern: RegExp) => lines.filter((l) => pattern.test(l.text)).map((l) => `${l.where}: ${l.text.trim()}`);

  it('no inline padding, margin or gap in bare px', () => {
    expect(found(/\b(?:padding|margin|gap|rowGap|columnGap)\w*: ?(?:-?\d*[1-9]\d*(?:\.\d+)?|'-?\d*[1-9]\d*(?:\.\d+)?(?:px)?[ '])/)).toEqual([]);
  });

  it('no inline border radius in bare px', () => {
    expect(found(/\bborderRadius: ?(?:[1-9]\d?|'[1-9]\d?px')(?=[,} ])/)).toEqual([]);
  });

  it('no 1px border in an inline style (it is the theme\'s stroke)', () => {
    expect(found(/\b1px solid\b/)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(SRC, '..');
const rel = (file: string) => file.slice(WEB.length + 1);

/**
 * The only source file allowed a colour literal: the theme table, which is where colours come
 * from. `index.css` may hold them only in its `:root` blocks (Classic, and the print palette).
 */
const ALLOWED = new Set(['src/lib/themes.ts']);
const PALETTE_BLOCKS = new Set(['src/index.css']);

function sources(dir: string, ext = /\.tsx?$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p, ext);
    return ext.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** A file's text, with each `:root { … }` block blanked (its lines kept) where palettes are allowed. */
function text(file: string): string {
  const s = readFileSync(file, 'utf8');
  if (!PALETTE_BLOCKS.has(rel(file))) return s;
  return s.replace(/:root\s*\{[^}]*\}/g, (block) => block.replace(/[^\n]/g, ' '));
}

function matches(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    text(file).split('\n').flatMap((line, i) =>
      [...line.matchAll(pattern)].map((m) => `${file.slice(WEB.length + 1)}:${i + 1}: ${m[0]}`),
    ),
  );
}

describe('components follow the theme', () => {
  it('no colour is a hex or rgb() literal in a component or stylesheet, which would stay the same in every theme and in print', () => {
    // `&#8226;` is an HTML entity, not a colour. Black in rgba() is allowed: shadows and scrims are
    // black in every theme.
    const literal = /(?<!&)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b|rgba?\(\s*(?!0\s*,\s*0\s*,\s*0\s*[,)])\d[^)]*\)/gi;
    const files = [...sources(SRC), ...sources(SRC, /\.css$/)].filter((f) => !ALLOWED.has(rel(f)));
    expect(matches(files, literal)).toEqual([]);
  });

  it('the allow-list names files that exist', () => {
    const all = new Set([...sources(SRC), ...sources(SRC, /\.css$/)].map(rel));
    for (const f of [...ALLOWED, ...PALETTE_BLOCKS]) expect(all.has(f), f).toBe(true);
  });

  it('no class puts an opacity modifier on an arbitrary var() (`bg-[var(--ok)]/10`), which Tailwind 3 silently drops', () => {
    const dropped = /\[(?:[\w-]+:)?var\(--[^\]]+\)\]\/(?:\d+|\[[^\]]+\])/g;
    expect(matches([join(WEB, 'index.html'), ...sources(SRC)], dropped)).toEqual([]);
  });
});

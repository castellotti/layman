import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { contrast, deltaE, HEX_COLOR } from './color.js';
import {
  ACCENT_CLEAR_OF, appearanceCss, CONTRAST_GROUNDS, CONTRAST_TEXTS, DEFAULT_APPEARANCE, FONT_MONO,
  FONT_SANS, MIN_ACCENT_DISTANCE, MIN_CONTRAST, resolveAppearance, themeById, THEMES, TOKENS,
} from './themes.js';

const DARK = { prefersDark: true, prefersReducedMotion: false };
const LIGHT = { prefersDark: false, prefersReducedMotion: false };

describe('every theme', () => {
  it('has a unique id and both schemes are offered', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(THEMES.some((t) => t.scheme === 'dark')).toBe(true);
    expect(THEMES.some((t) => t.scheme === 'light')).toBe(true);
  });

  it.each(THEMES.map((t) => [t.id, t] as const))('%s defines every token, as #rgb/#rrggbb, and nothing else', (_, t) => {
    expect(Object.keys(t.tokens).sort()).toEqual([...TOKENS].sort());
    for (const tok of TOKENS) expect(t.tokens[tok], tok).toMatch(HEX_COLOR);
  });

  const contrastCases = THEMES.flatMap((t) =>
    CONTRAST_TEXTS.flatMap((fg) => CONTRAST_GROUNDS.map((bg) => [t.id, fg, bg, t] as const)));
  it.each(contrastCases)(`%s: %s on %s reaches ${MIN_CONTRAST}:1`, (_, fg, bg, t) => {
    expect(contrast(t.tokens[fg], t.tokens[bg])).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  const accentCases = THEMES.flatMap((t) => ACCENT_CLEAR_OF.map((s) => [t.id, s, t] as const));
  it.each(accentCases)(`%s: accent and accent-hot stay ${MIN_ACCENT_DISTANCE} ΔE clear of %s`, (_, s, t) => {
    expect(deltaE(t.tokens.accent, t.tokens[s])).toBeGreaterThanOrEqual(MIN_ACCENT_DISTANCE);
    expect(deltaE(t.tokens['accent-hot'], t.tokens[s])).toBeGreaterThanOrEqual(MIN_ACCENT_DISTANCE);
  });
});

describe('Classic is today', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf8');
  const root = css.match(/^:root\s*\{([\s\S]*?)^\}/m)![1];
  const declared = new Map([...root.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

  it('equals the :root block in index.css, token for token', () => {
    const classic = themeById('classic');
    for (const tok of TOKENS) expect(declared.get(tok)?.toUpperCase(), tok).toBe(classic.tokens[tok]);
    const colours = [...declared].filter(([, v]) => HEX_COLOR.test(v)).map(([k]) => k).sort();
    expect(colours).toEqual([...TOKENS].sort());
  });

  it('keeps the fonts index.css declares', () => {
    expect(declared.get('font-ui')).toBe(FONT_SANS);
    expect(declared.get('font-mono')).toBe(FONT_MONO);
  });

  it('is the default, and the default type is sans', () => {
    const r = resolveAppearance(DEFAULT_APPEARANCE, LIGHT);
    expect(r.theme.id).toBe('classic');
    expect(r.vars['--font-ui']).toBe(FONT_SANS);
    expect(r.vars['--density']).toBe('0.72');
  });
});

describe('resolveAppearance', () => {
  it('system follows the OS between the chosen dark and light themes', () => {
    const a = { ...DEFAULT_APPEARANCE, theme: 'system' as const };
    expect(resolveAppearance(a, DARK).theme.id).toBe('classic');
    expect(resolveAppearance(a, LIGHT).theme.id).toBe('daylight');
    expect(resolveAppearance({ ...a, lightTheme: 'paper' }, LIGHT).theme.id).toBe('paper');
  });

  it('falls back to Classic for a theme this version does not know', () => {
    expect(resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'slate' as never }, DARK).theme.id).toBe('classic');
  });

  it('type: the theme’s own, sans, or mono; a mono-only theme is always mono', () => {
    const ui = (theme: string, font: 'theme' | 'sans' | 'mono') =>
      resolveAppearance({ ...DEFAULT_APPEARANCE, theme: theme as never, font }, DARK).vars['--font-ui'];
    expect(ui('ember', 'theme')).toBe(FONT_MONO);
    expect(ui('ember', 'sans')).toBe(FONT_SANS);
    expect(ui('classic', 'theme')).toBe(FONT_SANS);
    expect(ui('classic', 'mono')).toBe(FONT_MONO);
    expect(ui('phosphor', 'sans')).toBe(FONT_MONO);
  });

  it('density and motion; the OS reduced-motion setting caps motion at reduced', () => {
    const r = (o: Partial<typeof DEFAULT_APPEARANCE>, reduce = false) =>
      resolveAppearance({ ...DEFAULT_APPEARANCE, ...o }, { prefersDark: true, prefersReducedMotion: reduce });
    expect(r({ density: 'comfortable' }).vars['--density']).toBe('1');
    expect(r({ motion: 'full' }).motion).toBe('full');
    expect(r({ motion: 'full' }, true).motion).toBe('reduced');
    expect(r({ motion: 'off' }, true).motion).toBe('off');
    expect(r({ motion: 'reduced' }).vars['--motion']).toBe('1');
    expect(r({ motion: 'off' }).vars['--motion']).toBe('0');
  });

  it('shape comes from the theme', () => {
    const r = resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'contrast' }, DARK);
    expect(r.vars['--stroke']).toBe('2px');
    expect(r.vars['--radius']).toBe('4px');
  });

  it('applies valid overrides on top and ignores unknown tokens and non-hex values', () => {
    const r = resolveAppearance(
      { ...DEFAULT_APPEARANCE, overrides: { accent: '#abc', warn: 'red', nope: '#000000', ok: 'url(x)' } },
      DARK,
    );
    expect(r.vars['--accent']).toBe('#abc');
    expect(r.vars['--warn']).toBe('#E5A83B');
    expect(r.vars['--ok']).toBe('#4CC38A');
    expect(r.vars).not.toHaveProperty('--nope');
  });
});

describe('appearanceCss', () => {
  it('is screen-only, so print keeps its own light palette', () => {
    const css = appearanceCss(resolveAppearance(DEFAULT_APPEARANCE, DARK));
    expect(css.startsWith('@media screen {')).toBe(true);
    expect(css).toContain('--warn: #E5A83B;');
  });
});

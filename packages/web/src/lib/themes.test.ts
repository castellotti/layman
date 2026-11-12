import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { HEX_COLOR } from './color.js';
import {
  appearanceCss, DEFAULT_APPEARANCE, followOsUpdate, TOKEN_GROUPS, FONT_MONO, FONT_SANS, KNOWN_PROBLEMS, normalizeAppearance,
  PRINT_THEME, resolveAppearance, themeById, themeProblems, THEMES, TOKENS,
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

  it.each(THEMES.map((t) => [t.id, t] as const))('%s holds every contrast and accent rule', (id, t) => {
    expect(themeProblems(t.tokens, KNOWN_PROBLEMS[id])).toEqual([]);
  });

  it('every known problem is still a problem (no stale exceptions)', () => {
    for (const [id, allowed] of Object.entries(KNOWN_PROBLEMS)) {
      const found = themeProblems(themeById(id).tokens);
      expect(found.length, id).toBe(allowed!.size);
    }
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

  it('the default appearance writes exactly the fonts, shape and motion index.css declares', () => {
    const { vars } = resolveAppearance(DEFAULT_APPEARANCE, DARK);
    for (const v of ['font-ui', 'font-mono', 'radius', 'stroke', 'density', 'motion']) {
      expect(vars[`--${v}`], v).toBe(declared.get(v));
    }
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
      { ...DEFAULT_APPEARANCE, overrides: { classic: { accent: '#abc', warn: 'red', nope: '#000000', ok: 'url(x)' } } },
      DARK,
    );
    expect(r.vars['--accent']).toBe('#abc');
    expect(r.vars['--warn']).toBe('#E5A83B');
    expect(r.vars['--ok']).toBe('#4CC38A');
    expect(r.vars).not.toHaveProperty('--nope');
  });

  it('a theme draws with its own overrides only, so Follow the OS never mixes them', () => {
    const a = { ...DEFAULT_APPEARANCE, theme: 'system' as const, overrides: { classic: { bg: '#010203' }, daylight: { bg: '#FAFAFA' } } };
    expect(resolveAppearance(a, DARK).vars['--bg']).toBe('#010203');
    expect(resolveAppearance(a, LIGHT).vars['--bg']).toBe('#FAFAFA');
    expect(resolveAppearance({ ...a, theme: 'ember' }, DARK).vars['--bg']).toBe(themeById('ember').tokens.bg);
  });
});

describe('TOKEN_GROUPS', () => {
  it('lists every token exactly once, so Settings can override any of them', () => {
    const listed = TOKEN_GROUPS.flatMap((g) => g.tokens);
    expect([...listed].sort()).toEqual([...TOKENS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});

describe('themeProblems', () => {
  it('flags an override that puts the accent on warn, or muted text that cannot be read', () => {
    const t = themeById('classic').tokens;
    const accentOnWarn = themeProblems({ ...t, accent: t.warn }, KNOWN_PROBLEMS.classic);
    expect(accentOnWarn).toContainEqual(expect.stringMatching(/^accent is 0\.000 ΔE from warn/));
    expect(accentOnWarn.every((p) => p.startsWith('accent is'))).toBe(true);
    expect(themeProblems({ ...t, 'text-muted': '#20242C' }, KNOWN_PROBLEMS.classic)).toHaveLength(3);
  });
});

describe('normalizeAppearance', () => {
  it('fills what is missing and replaces what this version does not know', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ theme: 'paper' })).toEqual({ ...DEFAULT_APPEARANCE, theme: 'paper' });
    expect(normalizeAppearance({
      theme: 'slate', darkTheme: 'nope', lightTheme: 7, font: 'serif', density: 'airy', motion: 'wild',
      overrides: { classic: { accent: '#abc', warn: 'red', nope: '#000000', ok: 3 }, slate: { bg: '#000' }, tide: { ok: 'red' }, paper: 'x' },
    })).toEqual({ ...DEFAULT_APPEARANCE, overrides: { classic: { accent: '#abc' } } });
    expect(normalizeAppearance({ overrides: { accent: '#abc' } }).overrides).toEqual({});
    expect(normalizeAppearance({ theme: 'system' }).theme).toBe('system');
  });

  it('so resolving a partial or stale config never throws', () => {
    expect(() => resolveAppearance({ theme: 'paper' }, DARK)).not.toThrow();
    expect(resolveAppearance({ density: 'airy' }, DARK).vars['--density']).toBe('0.72');
    expect(resolveAppearance(null, DARK).theme.id).toBe('classic');
  });
});

describe('appearanceCss', () => {
  const blocks = (css: string) => Object.fromEntries(
    [...css.matchAll(/@media (\w+) \{\n:root \{\n([\s\S]*?)\n\}\n\}/g)].map((m) => [m[1], m[2]]),
  );

  it('writes the theme for the screen and the print theme (Daylight) for print, every colour token', () => {
    const { screen, print } = blocks(appearanceCss(resolveAppearance(DEFAULT_APPEARANCE, DARK)));
    expect(screen).toContain('--warn: #E5A83B;');
    expect(PRINT_THEME).toBe('daylight');
    const daylight = themeById('daylight').tokens;
    expect(print.split('\n')).toEqual([...TOKENS.map((t) => `  --${t}: ${daylight[t]};`), '  color-scheme: light;']);
  });

  it("sets each block's color-scheme from its theme, so native controls match", () => {
    expect(blocks(appearanceCss(resolveAppearance(DEFAULT_APPEARANCE, DARK))).screen).toMatch(/ {2}color-scheme: dark;$/);
    const paper = { ...DEFAULT_APPEARANCE, theme: 'paper' };
    expect(blocks(appearanceCss(resolveAppearance(paper, DARK))).screen).toMatch(/ {2}color-scheme: light;$/);
    const system = { ...DEFAULT_APPEARANCE, theme: 'system' };
    expect(blocks(appearanceCss(resolveAppearance(system, LIGHT))).screen).toMatch(/ {2}color-scheme: light;$/);
  });

  it('prints the same whatever the screen shows: another theme or overrides do not reach print', () => {
    const plain = blocks(appearanceCss(resolveAppearance(DEFAULT_APPEARANCE, DARK))).print;
    const custom = { ...DEFAULT_APPEARANCE, theme: 'ember', overrides: { ember: { bg: '#123456' } } };
    const { screen, print } = blocks(appearanceCss(resolveAppearance(custom, DARK)));
    expect(screen).toContain('--bg: #123456;');
    expect(print).toBe(plain);
  });
});

describe('followOsUpdate', () => {
  it('turning it on keeps the theme on screen, as its scheme\'s half of the pair', () => {
    expect(followOsUpdate({ ...DEFAULT_APPEARANCE, theme: 'ember' }, themeById('ember'))).toEqual({ theme: 'system', darkTheme: 'ember' });
    expect(followOsUpdate({ ...DEFAULT_APPEARANCE, theme: 'paper' }, themeById('paper'))).toEqual({ theme: 'system', lightTheme: 'paper' });
  });

  it('turning it off keeps whichever half is showing', () => {
    const system = { ...DEFAULT_APPEARANCE, theme: 'system' as const, darkTheme: 'tide' as const };
    expect(followOsUpdate(system, themeById('tide'))).toEqual({ theme: 'tide' });
    expect(followOsUpdate(system, themeById('daylight'))).toEqual({ theme: 'daylight' });
  });
});

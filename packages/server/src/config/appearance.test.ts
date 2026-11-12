import { describe, expect, it } from 'vitest';
import { migrateTheme, setConfig, updateConfig } from './config.js';
import { AppearanceSchema, LaymanConfigSchema } from './schema.js';

const DEFAULT = {
  theme: 'classic', darkTheme: 'classic', lightTheme: 'daylight',
  font: 'sans', density: 'compact', motion: 'full', overrides: {},
};

describe('appearance', () => {
  it('defaults to Classic, Sans UI type, Compact, Full motion, paired with Daylight', () => {
    expect(LaymanConfigSchema.parse({}).appearance).toEqual(DEFAULT);
  });

  it('keeps every valid choice', () => {
    const a = {
      theme: 'system', darkTheme: 'ember', lightTheme: 'paper',
      font: 'mono', density: 'comfortable', motion: 'off', overrides: { accent: '#AABBCC', 'bg-card': '#000000' },
    };
    expect(AppearanceSchema.parse(a)).toEqual(a);
  });

  it('a value this version does not know falls back to its default, field by field, never failing the config', () => {
    const parsed = LaymanConfigSchema.parse({
      appearance: { theme: 'slate', darkTheme: 'daylight', lightTheme: 42, font: 'serif', density: 'cosy', motion: null },
    });
    expect(parsed.appearance).toEqual({ ...DEFAULT, darkTheme: 'daylight' });
    expect(LaymanConfigSchema.parse({ appearance: 'dark' }).appearance).toEqual(DEFAULT);
  });

  it('keeps only hex overrides with token-shaped names', () => {
    expect(AppearanceSchema.parse({
      overrides: { accent: '#123456', ok: 'red', warn: '#fff', 'Bad Name': '#123456', error: 7, 'net-up': '#abcdef' },
    }).overrides).toEqual({ accent: '#123456', 'net-up': '#abcdef' });
    expect(AppearanceSchema.parse({ overrides: ['#123456'] }).overrides).toEqual({});
  });

  it('the schema no longer keeps the old top-level theme', () => {
    expect('theme' in LaymanConfigSchema.parse({ theme: 'light' })).toBe(false);
  });
});

describe('theme → appearance.theme', () => {
  it('maps dark, light and system to Classic, Daylight and the OS pair', () => {
    expect(migrateTheme({ theme: 'dark' })).toEqual({ appearance: { theme: 'classic' } });
    expect(migrateTheme({ theme: 'light', port: 1 })).toEqual({ port: 1, appearance: { theme: 'daylight' } });
    expect(migrateTheme({ theme: 'system', appearance: { density: 'comfortable' } }))
      .toEqual({ appearance: { density: 'comfortable', theme: 'system' } });
  });

  it('an appearance theme already chosen wins; an unknown old value is only dropped', () => {
    expect(migrateTheme({ theme: 'light', appearance: { theme: 'ember' } })).toEqual({ appearance: { theme: 'ember' } });
    expect(migrateTheme({ theme: 'sepia' })).toEqual({});
  });

  it('leaves a config without the old key alone, and never changes its argument', () => {
    const plain = { appearance: { theme: 'tide' } };
    expect(migrateTheme(plain)).toBe(plain);
    const old = { theme: 'light' };
    migrateTheme(old);
    expect(old).toEqual({ theme: 'light' });
  });
});

describe('updateConfig and appearance', () => {
  const start = () => setConfig(LaymanConfigSchema.parse({
    appearance: { theme: 'ember', density: 'comfortable', overrides: { accent: '#111111', ok: '#222222' } },
  }));

  it('an update with one choice keeps the others', () => {
    start();
    const next = updateConfig({ appearance: { motion: 'off' } } as never);
    expect(next.appearance).toMatchObject({ theme: 'ember', density: 'comfortable', motion: 'off' });
    expect(next.appearance.overrides).toEqual({ accent: '#111111', ok: '#222222' });
  });

  it('overrides, when sent, replace the map, so one can be removed', () => {
    start();
    expect(updateConfig({ appearance: { overrides: { ok: '#222222' } } } as never).appearance.overrides).toEqual({ ok: '#222222' });
  });

  it('an update without appearance keeps it whole', () => {
    start();
    expect(updateConfig({ autoScroll: false }).appearance).toMatchObject({ theme: 'ember', density: 'comfortable' });
  });

  it('an update holding a value this version does not know keeps the current choice, and applies the rest', () => {
    start();
    const next = updateConfig({ appearance: { theme: 'slate', motion: 'off', overrides: 'none' } } as never).appearance;
    expect(next).toMatchObject({ theme: 'ember', motion: 'off' });
    expect(next.overrides).toEqual({ accent: '#111111', ok: '#222222' });
  });

  it('an old client sending theme still changes the theme, and keeps the rest', () => {
    start();
    expect(updateConfig({ theme: 'light' } as never).appearance).toMatchObject({ theme: 'daylight', density: 'comfortable' });
  });
});

import { describe, expect, it } from 'vitest';
import { HEX_COLOR } from './color.js';
import { DEFAULT_APPEARANCE, DENSITIES, FONTS, MOTIONS, normalizeAppearance, THEMES } from './themes.js';
import * as server from '../../../server/src/config/schema.js';

describe('the server validates appearance with the web\'s choices', () => {
  it('the same theme ids, fonts, densities and motions', () => {
    expect([...server.THEME_IDS]).toEqual(THEMES.map((t) => t.id));
    expect([...server.FONT_CHOICES]).toEqual([...FONTS]);
    expect([...server.DENSITIES]).toEqual([...DENSITIES]);
    expect([...server.MOTIONS]).toEqual([...MOTIONS]);
  });

  it('the same colour rule for overrides', () => {
    expect(server.HEX_COLOR.source).toBe(HEX_COLOR.source);
    expect(server.HEX_COLOR.flags).toBe(HEX_COLOR.flags);
  });

  it('the same overrides shape: per theme, bad entries and unknown themes dropped', () => {
    const stored = { classic: { accent: '#123456', ok: 'red' }, slate: { bg: '#000' }, paper: { bg: '#fff' } };
    expect(server.cleanOverrides(stored)).toEqual(normalizeAppearance({ overrides: stored }).overrides);
  });

  it('the same defaults', () => {
    expect(server.AppearanceSchema.parse({})).toEqual(DEFAULT_APPEARANCE);
  });
});

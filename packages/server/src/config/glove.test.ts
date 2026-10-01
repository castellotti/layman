import { describe, expect, it } from 'vitest';
import { migrateGloveHome } from './config.js';
import { GloveConfigSchema } from './schema.js';

describe('glove.sessionsDir → glove.home (glove v3)', () => {
  it('takes the home from a v2 sessionsDir once, and drops the old key', () => {
    expect(migrateGloveHome({ enabled: true, sessionsDir: '~/.glove/envs' })).toEqual({ enabled: true, home: '~/.glove' });
    expect(migrateGloveHome({ sessionsDir: '/srv/glove/envs/' })).toEqual({ home: '/srv/glove' });
    expect(migrateGloveHome({ sessionsDir: 'envs' })).toEqual({ home: '~/.glove' });
  });
  it('leaves a config that already has home, or neither key, as it is', () => {
    expect(migrateGloveHome({ home: '/h', sessionsDir: '/x/envs' })).toEqual({ home: '/h', sessionsDir: '/x/envs' });
    expect(migrateGloveHome({ enabled: false })).toEqual({ enabled: false });
    expect(migrateGloveHome(undefined)).toBeUndefined();
  });
  it('the schema defaults home to ~/.glove and does not keep sessionsDir', () => {
    const parsed = GloveConfigSchema.parse({ sessionsDir: '~/.glove/envs' }) as Record<string, unknown>;
    expect(parsed.home).toBe('~/.glove');
    expect('sessionsDir' in parsed).toBe(false);
  });
});

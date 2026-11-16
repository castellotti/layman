import { describe, expect, it } from 'vitest';
import { setConfig, updateConfig } from './config.js';
import { LaymanConfigSchema, StyxConfigSchema, type ConfigUpdate } from './schema.js';

describe('styx config', () => {
  it('is off by default and has no godotDir', () => {
    expect(LaymanConfigSchema.parse({}).styx).toEqual({ enabled: false, godotDir: '' });
    expect(StyxConfigSchema.parse({})).toEqual({ enabled: false, godotDir: '' });
  });

  it('an update carrying only enabled keeps godotDir (deep merge)', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: false, godotDir: '/builds/godot' } }));
    const next = updateConfig({ styx: { enabled: true } } as unknown as ConfigUpdate);
    expect(next.styx).toEqual({ enabled: true, godotDir: '/builds/godot' });
  });

  it('an update carrying only godotDir keeps enabled', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: true } }));
    const next = updateConfig({ styx: { godotDir: '/x' } } as unknown as ConfigUpdate);
    expect(next.styx).toEqual({ enabled: true, godotDir: '/x' });
  });

  it('an update that omits styx leaves it alone', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: true, godotDir: '/x' } }));
    expect(updateConfig({ port: 8881 }).styx).toEqual({ enabled: true, godotDir: '/x' });
  });
});

import { describe, expect, it } from 'vitest';
import { setConfig, updateConfig } from './config.js';
import { LaymanConfigSchema, StyxConfigSchema, type ConfigUpdate } from './schema.js';

const ALL_TABS = { matrix: true, matrix2d: true, matrix3d: true, gibson: true, gibson2d: true, gibson3d: true };
const base = { matrix: true, gibson: true, tabs: ALL_TABS };

describe('styx config', () => {
  it('is off by default, has no godotDir, and shows every tab', () => {
    expect(LaymanConfigSchema.parse({}).styx).toEqual({ enabled: false, godotDir: '', ...base });
    expect(StyxConfigSchema.parse({})).toEqual({ enabled: false, godotDir: '', ...base });
  });

  it('an update carrying one tab keeps the other tabs (deep merge)', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: true, tabs: { gibson3d: false } } }));
    const next = updateConfig({ styx: { tabs: { matrix: false } } } as unknown as ConfigUpdate);
    expect(next.styx.tabs).toEqual({ ...ALL_TABS, matrix: false, gibson3d: false });
  });

  it('an update carrying only matrix keeps gibson and the tabs', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { gibson: false, tabs: { matrix2d: false } } }));
    const next = updateConfig({ styx: { matrix: false } } as unknown as ConfigUpdate);
    expect(next.styx).toMatchObject({ matrix: false, gibson: false, tabs: { matrix2d: false } });
  });

  it('a network tab update keeps the other network tabs and settings', () => {
    setConfig(LaymanConfigSchema.parse({ glove: { network: { vpnDomains: ['corp.example'], tabs: { map: false } } } }));
    const next = updateConfig({ glove: { network: { tabs: { trace: false } } } } as unknown as ConfigUpdate);
    expect(next.glove.network.tabs).toEqual({ network: true, map: false, topology: true, trace: false });
    expect(next.glove.network.vpnDomains).toEqual(['corp.example']);
  });

  it('an update carrying only enabled keeps godotDir (deep merge)', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: false, godotDir: '/builds/godot' } }));
    const next = updateConfig({ styx: { enabled: true } } as unknown as ConfigUpdate);
    expect(next.styx).toMatchObject({ enabled: true, godotDir: '/builds/godot' });
  });

  it('an update carrying only godotDir keeps enabled', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: true } }));
    const next = updateConfig({ styx: { godotDir: '/x' } } as unknown as ConfigUpdate);
    expect(next.styx).toMatchObject({ enabled: true, godotDir: '/x' });
  });

  it('an update that omits styx leaves it alone', () => {
    setConfig(LaymanConfigSchema.parse({ styx: { enabled: true, godotDir: '/x' } }));
    expect(updateConfig({ port: 8881 }).styx).toMatchObject({ enabled: true, godotDir: '/x' });
  });
});

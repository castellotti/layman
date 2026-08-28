import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GloveSource } from './sources.js';

/** Create the glove Vibe log layout for a sandbox: <base>/<name>/home/.vibe/logs/session */
function makeGloveVibeSandbox(base: string, name: string): string {
  const logDir = join(base, name, 'home', '.vibe', 'logs', 'session');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

describe('GloveSource', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'layman-glove-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns no roots when disabled (sessionsDir resolves to null)', () => {
    const source = new GloveSource(() => null);
    expect(source.roots()).toEqual([]);
  });

  it('returns no roots when the sessions dir does not exist', () => {
    const source = new GloveSource(() => join(root, 'nonexistent'));
    expect(source.roots()).toEqual([]);
  });

  it('discovers a sandbox with Vibe logs and labels it with the sandbox name', () => {
    const base = join(root, 'sessions');
    const logDir = makeGloveVibeSandbox(base, 'vibe-local');

    const source = new GloveSource(() => base);
    expect(source.roots()).toEqual([
      { path: logDir, agentType: 'mistral-vibe', label: 'vibe-local' },
    ]);
  });

  it('ignores sandboxes that have no Vibe log layout', () => {
    const base = join(root, 'sessions');
    makeGloveVibeSandbox(base, 'vibe-local');
    // pi-local has a home but no .vibe/logs/session — nothing to tail passively.
    mkdirSync(join(base, 'pi-local', 'home', '.pi', 'agent'), { recursive: true });

    const labels = new GloveSource(() => base).roots().map((r) => r.label);
    expect(labels).toEqual(['vibe-local']);
  });

  it('re-globs on each call so sandboxes appearing later are picked up', () => {
    const base = join(root, 'sessions');
    mkdirSync(base, { recursive: true });
    const source = new GloveSource(() => base);
    expect(source.roots()).toEqual([]);

    makeGloveVibeSandbox(base, 'vibe-local');
    expect(source.roots().map((r) => r.label)).toEqual(['vibe-local']);
  });
});

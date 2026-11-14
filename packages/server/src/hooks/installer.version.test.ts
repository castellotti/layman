import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

function transcript(version: string): void {
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
  writeFileSync(join(home, '.claude', 'projects', 'p', 's.jsonl'), `{"type":"user","version":"${version}"}\n`);
}

async function installedEvents(): Promise<string[]> {
  vi.resetModules();
  const { HookInstaller } = await import('./installer.js');
  new HookInstaller({ serverUrl: 'http://localhost:8880', hookTimeout: 300 }).install();
  return Object.keys(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf-8')).hooks);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'layman-ver-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('newer hook events', () => {
  it('are registered on a build that ignores unknown events', async () => {
    transcript('2.1.322');
    const events = await installedEvents();
    expect(events).toContain('PermissionDenied');
    expect(events).toContain('PostModelSwitch');
  });
  it('are not registered on an older build', async () => {
    transcript('2.1.99');
    const events = await installedEvents();
    expect(events).not.toContain('PermissionDenied');
    expect(events).not.toContain('PostModelSwitch');
  });
  it('are not registered when the version is unknown', async () => {
    expect(await installedEvents()).not.toContain('PostModelSwitch');
  });
});

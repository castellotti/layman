import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HookInstaller as HookInstallerType } from './installer.js';

/**
 * `OPTIONAL_CLIENTS` resolves every path through `homedir()` at module-evaluation
 * time, so a test that wants a throwaway home has to redirect `os.homedir` before
 * the module is first imported — hence the mock plus a dynamic import after
 * `vi.resetModules()` in `beforeEach`.
 */
let home: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const SERVER_URL = 'http://localhost:8880';

let HookInstaller: typeof HookInstallerType;

function piExtensionPath(): string {
  return join(home, '.pi', 'agent', 'extensions', 'layman', 'index.ts');
}

/** Mark pi as genuinely installed: `~/.pi/agent` is its `signalFiles` entry. */
function markPiInstalled(): void {
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
}

function newInstaller(serverUrl = SERVER_URL): HookInstallerType {
  return new HookInstaller({ serverUrl, hookTimeout: 300 });
}

function piStatus(installer: HookInstallerType) {
  const status = installer.getStatus();
  const pi = status.optionalClients.find((c) => c.id === 'pi');
  if (!pi) throw new Error('pi is missing from optionalClients');
  return pi;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'layman-pi-home-'));
  vi.resetModules();
  ({ HookInstaller } = await import('./installer.js'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('pi detection', () => {
  it('is not detected when ~/.pi does not exist', () => {
    expect(piStatus(newInstaller()).detected).toBe(false);
  });

  it('is not detected when ~/.pi exists but is empty', () => {
    // This is the shape a Docker bind mount creates on a machine that has never
    // run pi: the directory exists, but nothing inside it does.
    mkdirSync(join(home, '.pi'), { recursive: true });
    expect(piStatus(newInstaller()).detected).toBe(false);
  });

  it('is detected once ~/.pi/agent exists', () => {
    markPiInstalled();
    expect(piStatus(newInstaller()).detected).toBe(true);
  });
});

describe('pi extension install', () => {
  it('writes the extension where pi auto-discovers it', () => {
    markPiInstalled();
    newInstaller().installClient('pi');

    expect(existsSync(piExtensionPath())).toBe(true);
    const content = readFileSync(piExtensionPath(), 'utf-8');
    expect(content).toContain('export default function laymanExtension');
  });

  it('tags the file with a line comment, not an HTML comment', () => {
    // An HTML comment is a syntax error in TypeScript; pi would fail to load it.
    markPiInstalled();
    newInstaller().installClient('pi');

    const lines = readFileSync(piExtensionPath(), 'utf-8').trimEnd().split('\n');
    expect(lines[lines.length - 1]).toMatch(/^\/\/ layman:[0-9a-f]+$/);
    expect(readFileSync(piExtensionPath(), 'utf-8')).not.toContain('<!--');
  });

  it('substitutes the configured server URL', () => {
    markPiInstalled();
    newInstaller('http://host.docker.internal:9999').installClient('pi');

    const content = readFileSync(piExtensionPath(), 'utf-8');
    expect(content).toContain('http://host.docker.internal:9999');
    expect(content).not.toContain('__LAYMAN_URL__');
  });

  it('reports up to date immediately after install', () => {
    markPiInstalled();
    const installer = newInstaller();
    installer.installClient('pi');

    const pi = piStatus(installer);
    expect(pi.commandInstalled).toBe(true);
    expect(pi.commandUpToDate).toBe(true);
  });

  it('reports stale when the installed file no longer matches', () => {
    markPiInstalled();
    const installer = newInstaller();
    installer.installClient('pi');

    writeFileSync(piExtensionPath(), '// edited by hand\n', 'utf-8');

    expect(piStatus(installer).commandUpToDate).toBe(false);
  });

  it('reports stale when the server URL changes, and reinstalling clears it', () => {
    // The URL is baked into the extension, so an install pointing at the old URL
    // is genuinely stale — showing it as green would leave pi posting into the void.
    markPiInstalled();
    newInstaller('http://localhost:8880').installClient('pi');

    const moved = newInstaller('http://localhost:9999');
    expect(piStatus(moved).commandUpToDate).toBe(false);

    moved.installClient('pi');
    expect(piStatus(moved).commandUpToDate).toBe(true);
  });

  it('is idempotent across repeated installs', () => {
    // The duplicate-hook class of bug: reinstalling must converge, not accumulate.
    markPiInstalled();
    const installer = newInstaller();
    installer.installClient('pi');
    const first = readFileSync(piExtensionPath(), 'utf-8');

    installer.installClient('pi');
    installer.installClient('pi');

    expect(readFileSync(piExtensionPath(), 'utf-8')).toBe(first);
    expect(first.match(/\/\/ layman:/g)).toHaveLength(1);
  });

  it('removes the extension on uninstall', () => {
    markPiInstalled();
    const installer = newInstaller();
    installer.installClient('pi');
    installer.uninstallClient('pi');

    expect(existsSync(piExtensionPath())).toBe(false);
    expect(piStatus(installer).commandInstalled).toBe(false);
  });

  it('does not install when pi was never set up', () => {
    // No ~/.pi at all — installOptionalClientCommands skips a missing configDir.
    newInstaller().installClient('pi');
    expect(existsSync(piExtensionPath())).toBe(false);
  });
});

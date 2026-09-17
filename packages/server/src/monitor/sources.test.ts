import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  GloveSource,
  GLOVE_ROOTS_TTL_MS,
  rebaseGloveHome,
  shouldActivateWatchedSession,
} from './sources.js';

/**
 * Current glove Vibe layout: a per-session home under
 * `<base>/<env>/sessions/<session>/home/.vibe/logs/session`. `session` defaults
 * to the env id (the default unnamed session).
 */
function makeGloveVibeSandbox(base: string, env: string, session = env): string {
  const logDir = join(base, env, 'sessions', session, 'home', '.vibe', 'logs', 'session');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

/** Current glove pi layout: `<base>/<env>/sessions/<session>/home/.pi/agent/sessions`. */
function makeGlovePiSandbox(base: string, env: string, session = env): string {
  const logDir = join(base, env, 'sessions', session, 'home', '.pi', 'agent', 'sessions');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

/** Legacy glove layout: a single env-level home at `<base>/<env>/home/...`. */
function makeLegacyGloveVibeSandbox(base: string, env: string): string {
  const logDir = join(base, env, 'home', '.vibe', 'logs', 'session');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

/** Legacy glove pi layout: a single env-level home at `<base>/<env>/home/.pi/...`. */
function makeLegacyGlovePiSandbox(base: string, env: string): string {
  const logDir = join(base, env, 'home', '.pi', 'agent', 'sessions');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

/** Create a pi sessions dir under an arbitrary home root (a relocated home). */
function makePiHome(home: string): string {
  const logDir = join(home, '.pi', 'agent', 'sessions');
  mkdirSync(logDir, { recursive: true });
  return logDir;
}

/** Write glove's registry.json as a sibling of the sessions dir (`<root>/registry.json`). */
function writeRegistry(root: string, entries: unknown[]): void {
  writeFileSync(join(root, 'registry.json'), JSON.stringify(entries), 'utf8');
}

describe('GloveSource', () => {
  let root: string;
  let savedHostHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'layman-glove-'));
    // Isolate from any ambient HOST_HOME so registry host paths aren't rebased
    // out from under the test's temp dirs.
    savedHostHome = process.env.HOST_HOME;
    delete process.env.HOST_HOME;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedHostHome === undefined) delete process.env.HOST_HOME;
    else process.env.HOST_HOME = savedHostHome;
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

  it('discovers a sandbox with pi logs and tags it agentType "pi"', () => {
    const base = join(root, 'sessions');
    const piDir = makeGlovePiSandbox(base, 'pi-local');

    const source = new GloveSource(() => base);
    expect(source.roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-local' },
    ]);
  });

  it('emits both a vibe and a pi root for a sandbox that runs both', () => {
    const base = join(root, 'sessions');
    const vibeDir = makeGloveVibeSandbox(base, 'both');
    const piDir = makeGlovePiSandbox(base, 'both');

    const roots = new GloveSource(() => base).roots();
    // Order within a sandbox is vibe then pi; both carry the same env-id label.
    expect(roots).toEqual([
      { path: vibeDir, agentType: 'mistral-vibe', label: 'both' },
      { path: piDir, agentType: 'pi', label: 'both' },
    ]);
  });

  it('re-globs once the cache TTL elapses so sandboxes appearing later are picked up', () => {
    const base = join(root, 'sessions');
    mkdirSync(base, { recursive: true });
    let now = 1000;
    const source = new GloveSource(() => base, () => now);
    expect(source.roots()).toEqual([]);

    makeGloveVibeSandbox(base, 'vibe-local');
    now += GLOVE_ROOTS_TTL_MS; // advance past the memo window
    expect(source.roots().map((r) => r.label)).toEqual(['vibe-local']);
  });

  it('follows a registry-recorded home relocated outside the sessions dir', () => {
    const base = join(root, 'sessions');
    // The env dir exists but has no home/ (config_home_source relocated it).
    mkdirSync(join(base, 'pi-search'), { recursive: true });
    const relocated = join(root, 'relocated-home');
    const piDir = makePiHome(relocated);
    writeRegistry(root, [{ env_id: 'pi-search', harness: 'pi', home: relocated }]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-search' },
    ]);
  });

  it('ignores a registry home that points inside the sessions dir (enumeration owns it)', () => {
    const base = join(root, 'sessions');
    // Enumeration already discovers this per-session home; a registry entry naming
    // the very same tree must not add a second root and double-tail it.
    const piDir = makeGlovePiSandbox(base, 'pi-local');
    writeRegistry(root, [
      { env_id: 'pi-local', home: join(base, 'pi-local', 'sessions', 'pi-local', 'home') },
    ]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-local' },
    ]);
  });

  it('a relocated registry home wins over a stale env-level copy (no double-tail)', () => {
    const base = join(root, 'sessions');
    // A glove-upgraded, config_home_source-relocated env: a stale env-level home
    // still lingers under base, and the registry records the canonical relocated
    // home outside base. Only the relocated home is tailed — never both.
    makeLegacyGlovePiSandbox(base, 'pi-search');
    const relocated = join(root, 'relocated-home');
    const piDir = makePiHome(relocated);
    writeRegistry(root, [{ env_id: 'pi-search', home: relocated }]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-search' },
    ]);
  });

  it('still resolves a registry home that is not under a set HOST_HOME (no-op translation)', () => {
    const base = join(root, 'sessions');
    mkdirSync(join(base, 'pi-search'), { recursive: true });
    // Docker sets HOST_HOME; a home outside it must translate to a no-op, not vanish.
    // (Active rebasing math is covered by the rebaseGloveHome unit tests below —
    // homedir() can't be redirected in-process to make a rebased path exist.)
    process.env.HOST_HOME = join(root, 'host');
    const relocated = join(root, 'elsewhere');
    const piDir = makePiHome(relocated);
    writeRegistry(root, [{ env_id: 'pi-search', home: relocated }]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-search' },
    ]);
  });

  it('falls back to enumeration when the registry is missing or malformed', () => {
    const base = join(root, 'sessions');
    const piDir = makeGlovePiSandbox(base, 'pi-local');
    // Malformed registry must not throw or suppress enumeration-based discovery.
    writeFileSync(join(root, 'registry.json'), '{ not json', 'utf8');

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-local' },
    ]);
  });

  it('ignores a registry entry whose recorded home does not exist', () => {
    const base = join(root, 'sessions');
    mkdirSync(base, { recursive: true });
    writeRegistry(root, [{ env_id: 'ghost', home: join(root, 'never-created') }]);

    expect(new GloveSource(() => base).roots()).toEqual([]);
  });

  it('keeps enumerating past a null (or non-object) registry element', () => {
    const base = join(root, 'sessions');
    const piDir = makeGlovePiSandbox(base, 'pi-local');
    // A stray null / primitive in the array must not throw on entry.env_id;
    // discovery degrades to enumeration for the valid parts.
    writeRegistry(root, [null, 'oops', 42, { env_id: 'pi-local', home: join(base, 'pi-local', 'home') }]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-local' },
    ]);
  });

  it('does not let a nonexistent relocated registry home clobber a discovered home', () => {
    const base = join(root, 'sessions');
    // The per-session home exists and has pi sessions...
    const piDir = makeGlovePiSandbox(base, 'pi-local');
    // ...but the registry records a relocated home (outside base) that is not
    // present here (stale / not mounted). The enumerated home must still show.
    writeRegistry(root, [{ env_id: 'pi-local', home: join(root, 'not-mounted', 'home') }]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-local' },
    ]);
  });

  it('reads the registry even when the sessions dir does not exist', () => {
    // Registry-only relocation: `envs/` was never created, yet the registry
    // records a home living entirely outside it. The early return must not
    // skip the registry.
    const base = join(root, 'sessions'); // never created
    const relocated = join(root, 'relocated-home');
    const piDir = makePiHome(relocated);
    writeRegistry(root, [{ env_id: 'pi-search', home: relocated }]);

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-search' },
    ]);
  });
});

describe('rebaseGloveHome', () => {
  it('returns the path unchanged when HOST_HOME is unset or equals the container home', () => {
    expect(rebaseGloveHome('/Users/sc/.glove/homes/pi-search', undefined, '/root')).toBe(
      '/Users/sc/.glove/homes/pi-search',
    );
    expect(rebaseGloveHome('/root/.glove/x', '/root', '/root')).toBe('/root/.glove/x');
  });

  it('rebases a host path under HOST_HOME onto the container home', () => {
    expect(rebaseGloveHome('/Users/sc/.glove/homes/pi-search', '/Users/sc', '/root')).toBe(
      '/root/.glove/homes/pi-search',
    );
    // Exact-home match maps to the container home itself.
    expect(rebaseGloveHome('/Users/sc', '/Users/sc', '/root')).toBe('/root');
  });

  it('does not treat a sibling that merely shares a prefix as being under HOST_HOME', () => {
    // `/Users/sc-other` starts with the string `/Users/sc` but is not under it.
    expect(rebaseGloveHome('/Users/sc-other/x', '/Users/sc', '/root')).toBe(
      '/Users/sc-other/x',
    );
  });

  it('normalizes a trailing separator on HOST_HOME so rebasing still works', () => {
    expect(rebaseGloveHome('/Users/sc/.glove/homes/pi-search', '/Users/sc/', '/root')).toBe(
      '/root/.glove/homes/pi-search',
    );
    expect(rebaseGloveHome('/Users/sc', '/Users/sc/', '/root')).toBe('/root');
    // A trailing-separator HOST_HOME equal to the container home is still a no-op.
    expect(rebaseGloveHome('/root/.glove/x', '/root/', '/root')).toBe('/root/.glove/x');
  });
});

describe('GloveSource cache and layout', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'layman-glove-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serves repeated calls within the TTL from cache (one walk for both watchers)', () => {
    const base = join(root, 'sessions');
    makeGloveVibeSandbox(base, 'vibe-local');
    let now = 1000;
    const source = new GloveSource(() => base, () => now);
    expect(source.roots().map((r) => r.label)).toEqual(['vibe-local']);

    // A sandbox that vanishes within the TTL is still reported until the memo expires.
    rmSync(join(base, 'vibe-local'), { recursive: true, force: true });
    now += GLOVE_ROOTS_TTL_MS - 1;
    expect(source.roots().map((r) => r.label)).toEqual(['vibe-local']);
    now += 1;
    expect(source.roots()).toEqual([]);
  });

  it('labels a named (non-default) session with glove\'s <env>-<name> token', () => {
    const base = join(root, 'sessions');
    // pi-local env with a named session `pi-esde-favorites` (not the default).
    const piDir = makeGlovePiSandbox(base, 'pi-local', 'pi-esde-favorites');

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: piDir, agentType: 'pi', label: 'pi-local-pi-esde-favorites' },
    ]);
  });

  it('falls back to the legacy env-level home when there is no per-session home', () => {
    const base = join(root, 'sessions');
    const legacyDir = makeLegacyGloveVibeSandbox(base, 'vibe-local');

    expect(new GloveSource(() => base).roots()).toEqual([
      { path: legacyDir, agentType: 'mistral-vibe', label: 'vibe-local' },
    ]);
  });

  it('still falls back to the env-level home when a per-session home exists but is empty', () => {
    const base = join(root, 'sessions');
    // A glove-upgraded env: older transcripts under the env-level home, plus a
    // freshly-created per-session home that has no `.pi`/`.vibe` dir yet.
    const legacyDir = makeLegacyGlovePiSandbox(base, 'pi-local');
    mkdirSync(join(base, 'pi-local', 'sessions', 'pi-esde-favorites', 'home'), { recursive: true });

    // The empty per-session home must not suppress the env-level transcripts.
    expect(new GloveSource(() => base).roots()).toEqual([
      { path: legacyDir, agentType: 'pi', label: 'pi-local' },
    ]);
  });

  it('prefers the per-session home and does not also tail a stale env-level copy', () => {
    const base = join(root, 'sessions');
    // A glove-upgraded env: a stale env-level pi home AND the live per-session one.
    makeLegacyGlovePiSandbox(base, 'pi-local');
    const liveDir = makeGlovePiSandbox(base, 'pi-local', 'pi-esde-favorites');

    // Only the per-session root — never both, or every turn records twice.
    expect(new GloveSource(() => base).roots()).toEqual([
      { path: liveDir, agentType: 'pi', label: 'pi-local-pi-esde-favorites' },
    ]);
  });
});

describe('shouldActivateWatchedSession', () => {
  it('always activates a labelled (glove-sandboxed) session, regardless of opt-in', () => {
    expect(shouldActivateWatchedSession('pi', 'pi-local', [])).toBe(true);
    expect(shouldActivateWatchedSession('mistral-vibe', 'myrepo-1a2b3c', [])).toBe(true);
  });

  it('gates a native (unlabelled) session on autoActivateClients', () => {
    expect(shouldActivateWatchedSession('pi', undefined, [])).toBe(false);
    expect(shouldActivateWatchedSession('pi', undefined, ['pi'])).toBe(true);
    expect(shouldActivateWatchedSession('mistral-vibe', undefined, ['pi'])).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GloveSource, GLOVE_ROOTS_TTL_MS, shouldActivateWatchedSession } from './sources.js';

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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { GloveSource, GLOVE_ROOTS_TTL_MS, shouldActivateWatchedSession } from './sources.js';
import { rebaseGloveHome } from '../glove/registry.js';
import { addGloveSession, registerRow } from '../netobs/testing/glove-home.js';

/** glove's grant-state fixtures (`netobs/__scenarios_v3__/`), one `~/.glove` per scenario. */
const V3 = join(dirname(fileURLToPath(import.meta.url)), '..', 'netobs', '__scenarios_v3__');

describe('GloveSource (glove v3)', () => {
  let root: string;
  /** A copy of one fixture's glove home, so a test may change it. */
  const scenario = (name: string): string => {
    const home = join(root, name);
    cpSync(join(V3, name, 'home'), home, { recursive: true });
    return home;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'layman-glove-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns no roots when disabled, or when the home does not exist', () => {
    expect(new GloveSource(() => null).roots()).toEqual([]);
    expect(new GloveSource(() => join(root, 'nonexistent')).roots()).toEqual([]);
  });

  it('tails the observe export\'s transcripts/, labelled with the session id (observe-only)', () => {
    const home = scenario('observe-only');
    expect(new GloveSource(() => home).roots()).toEqual([
      { path: join(home, 'observe', 'observe-only-0f1a2b', 'transcripts'), agentType: 'pi', label: 'observe-only-0f1a2b' },
    ]);
  });

  it.each(['observe-filter', 'filter-revoked', 'orphaned'])('reads transcripts whatever the filter grant or registry says (%s)', (name) => {
    const home = scenario(name);
    expect(new GloveSource(() => home).roots().map((r) => r.label)).toEqual([`${name}-0f1a2b`]);
  });

  it('yields nothing without an exported transcripts/ dir (observe-no-transcripts, not-observable)', () => {
    for (const name of ['observe-no-transcripts', 'not-observable']) {
      const home = scenario(name);
      expect(new GloveSource(() => home).roots(), name).toEqual([]);
    }
  });

  it('takes the harness from the registry, then session.json, never from the layout', () => {
    addGloveSession(root, 'vibe-a-000000', { harness: 'vibe', transcripts: true });
    const cc = addGloveSession(root, 'cc-111111', { harness: 'claude-code', transcripts: true });
    const unregistered = addGloveSession(root, 'solo-222222', { transcripts: true, registered: false });
    writeFileSync(join(unregistered.net, 'session.json'), JSON.stringify({ v: 1, harness: 'vibe' }));
    // An unregistered export without session.json: its harness is unknown, so it is not tailed.
    addGloveSession(root, 'mystery-333333', { transcripts: true, registered: false });
    const roots = new GloveSource(() => root).roots();
    expect(roots.map((r) => [r.label, r.agentType])).toEqual([['solo-222222', 'mistral-vibe'], ['vibe-a-000000', 'mistral-vibe']]);
    expect(roots.some((r) => r.path.startsWith(cc.transcripts))).toBe(false); // glove exports no claude-code transcripts
  });

  it('ignores anything under observe/ that is not a glove session id', () => {
    for (const name of ['bad name', 'pi-search', 'UPPER-000000']) mkdirSync(join(root, 'observe', name, 'transcripts'), { recursive: true });
    registerRow(root, { id: 'pi-search', dir: root, harness: 'pi', grants: {} });
    expect(new GloveSource(() => root).roots()).toEqual([]);
  });

  it('never reads a glove v2 home', () => {
    mkdirSync(join(root, 'envs', 'pi-local', 'sessions', 'pi-local', 'home', '.pi', 'agent', 'sessions'), { recursive: true });
    writeFileSync(join(root, 'registry.json'), JSON.stringify([{ env_id: 'pi-local', harness: 'pi', home: join(root, 'homes', 'pi-local') }]));
    mkdirSync(join(root, 'homes', 'pi-local', '.pi', 'agent', 'sessions'), { recursive: true });
    expect(new GloveSource(() => root).roots()).toEqual([]);
  });

  it('serves repeated calls within the TTL from cache, and re-reads after it', () => {
    let now = 1_000;
    const source = new GloveSource(() => root, () => now);
    expect(source.roots()).toEqual([]);
    addGloveSession(root, 'late-444444', { transcripts: true });
    expect(source.roots()).toEqual([]);
    now += GLOVE_ROOTS_TTL_MS;
    expect(source.roots().map((r) => r.label)).toEqual(['late-444444']);
  });
});

describe('rebaseGloveHome', () => {
  it('returns the path unchanged when HOST_HOME is unset or equals the container home', () => {
    expect(rebaseGloveHome('/Users/alice/.glove/homes/pi-search', undefined, '/root')).toBe(
      '/Users/alice/.glove/homes/pi-search',
    );
    expect(rebaseGloveHome('/root/.glove/x', '/root', '/root')).toBe('/root/.glove/x');
  });

  it('rebases a host path under HOST_HOME onto the container home', () => {
    expect(rebaseGloveHome('/Users/alice/.glove/homes/pi-search', '/Users/alice', '/root')).toBe(
      '/root/.glove/homes/pi-search',
    );
    // Exact-home match maps to the container home itself.
    expect(rebaseGloveHome('/Users/alice', '/Users/alice', '/root')).toBe('/root');
  });

  it('does not treat a sibling that merely shares a prefix as being under HOST_HOME', () => {
    // `/Users/alice-other` starts with the string `/Users/alice` but is not under it.
    expect(rebaseGloveHome('/Users/alice-other/x', '/Users/alice', '/root')).toBe(
      '/Users/alice-other/x',
    );
  });

  it('normalizes a trailing separator on HOST_HOME so rebasing still works', () => {
    expect(rebaseGloveHome('/Users/alice/.glove/homes/pi-search', '/Users/alice/', '/root')).toBe(
      '/root/.glove/homes/pi-search',
    );
    expect(rebaseGloveHome('/Users/alice', '/Users/alice/', '/root')).toBe('/root');
    // A trailing-separator HOST_HOME equal to the container home is still a no-op.
    expect(rebaseGloveHome('/root/.glove/x', '/root/', '/root')).toBe('/root/.glove/x');
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

import { describe, it, expect } from 'vitest';
import {
  buildPath,
  buildUrl,
  parsePath,
  resolveInstanceUrl,
  type LaymanRoute,
  type RouteOptions,
} from './layman-url.js';

const ROUTES: LaymanRoute[] = [
  { kind: 'dashboard' },
  { kind: 'session', sessionId: 'sess-1' },
  { kind: 'turn', sessionId: 'sess-1', promptEventId: 'prompt-1' },
  { kind: 'event', sessionId: 'sess-1', eventId: 'evt-1' },
  { kind: 'highlight', highlightId: 'hl-1' },
  { kind: 'bookmark', bookmarkId: 'bm-1' },
  { kind: 'folder', folderId: 'fold-1' },
];

const OPTION_SETS: RouteOptions[] = [
  {},
  { view: 'logs' },
  { play: true },
  { t: 1712345678901 },
  { view: 'prompts', play: true, t: 42 },
];

describe('URL round-trip', () => {
  // The cheapest guard against the server and web copies of this grammar drifting.
  for (const route of ROUTES) {
    for (const opts of OPTION_SETS) {
      it(`survives ${route.kind} + ${JSON.stringify(opts)}`, () => {
        const parsed = parsePath(buildPath(route, opts));
        expect(parsed).not.toBeNull();
        expect(parsed!.route).toEqual(route);
        expect(parsed!.opts).toEqual(opts);
      });
    }
  }
});

describe('buildPath', () => {
  it('emits the documented shapes', () => {
    expect(buildPath({ kind: 'dashboard' })).toBe('/');
    expect(buildPath({ kind: 'session', sessionId: 'a' })).toBe('/s/a');
    expect(buildPath({ kind: 'turn', sessionId: 'a', promptEventId: 'b' })).toBe('/s/a/t/b');
    expect(buildPath({ kind: 'event', sessionId: 'a', eventId: 'b' })).toBe('/s/a/e/b');
    expect(buildPath({ kind: 'highlight', highlightId: 'a' })).toBe('/h/a');
    expect(buildPath({ kind: 'bookmark', bookmarkId: 'a' })).toBe('/b/a');
    expect(buildPath({ kind: 'folder', folderId: 'a' })).toBe('/f/a');
  });

  it('omits falsy options rather than emitting empty parameters', () => {
    expect(buildPath({ kind: 'dashboard' }, { play: false })).toBe('/');
    expect(buildPath({ kind: 'session', sessionId: 'a' }, {})).toBe('/s/a');
  });

  it('percent-encodes ids', () => {
    expect(buildPath({ kind: 'session', sessionId: 'a b/c' })).toBe('/s/a%20b%2Fc');
    expect(parsePath('/s/a%20b%2Fc')!.route).toEqual({ kind: 'session', sessionId: 'a b/c' });
  });
});

describe('buildUrl', () => {
  it('joins instance and path without doubling the slash', () => {
    const route: LaymanRoute = { kind: 'turn', sessionId: 's', promptEventId: 'p' };
    expect(buildUrl('http://nyx.local:8880', route)).toBe('http://nyx.local:8880/s/s/t/p');
    expect(buildUrl('http://nyx.local:8880/', route)).toBe('http://nyx.local:8880/s/s/t/p');
  });

  it('carries options through', () => {
    expect(buildUrl('http://h:1', { kind: 'turn', sessionId: 's', promptEventId: 'p' }, { play: true }))
      .toBe('http://h:1/s/s/t/p?play=1');
  });
});

describe('parsePath', () => {
  it('treats the root as the dashboard', () => {
    expect(parsePath('/')!.route).toEqual({ kind: 'dashboard' });
    expect(parsePath('')!.route).toEqual({ kind: 'dashboard' });
  });

  it('accepts a query passed separately or inline', () => {
    expect(parsePath('/s/a', '?view=logs')!.opts).toEqual({ view: 'logs' });
    expect(parsePath('/s/a?view=logs')!.opts).toEqual({ view: 'logs' });
  });

  it('returns null for paths outside the grammar', () => {
    expect(parsePath('/nope')).toBeNull();
    expect(parsePath('/s')).toBeNull();
    expect(parsePath('/s/a/x/b')).toBeNull();
    expect(parsePath('/s/a/t')).toBeNull();
    expect(parsePath('/s/a/t/b/c')).toBeNull();
    expect(parsePath('/h/a/b')).toBeNull();
  });

  it('ignores unknown and malformed query parameters', () => {
    expect(parsePath('/s/a', '?bogus=1&view=nonsense&t=abc')!.opts).toEqual({});
  });

  it('accepts play=true as well as play=1', () => {
    expect(parsePath('/s/a', '?play=true')!.opts).toEqual({ play: true });
  });

  it('tolerates trailing and duplicate slashes', () => {
    expect(parsePath('/s/a/')!.route).toEqual({ kind: 'session', sessionId: 'a' });
    expect(parsePath('//s//a//')!.route).toEqual({ kind: 'session', sessionId: 'a' });
  });
});

describe('resolveInstanceUrl', () => {
  it('prefers publicUrl, then hookUrl, then host:port', () => {
    const base = { host: 'localhost', port: 8880 };
    expect(resolveInstanceUrl({ ...base, publicUrl: 'http://nyx.local:8880', hookUrl: 'http://x' }))
      .toBe('http://nyx.local:8880');
    expect(resolveInstanceUrl({ ...base, hookUrl: 'http://host.docker.internal:8880' }))
      .toBe('http://host.docker.internal:8880');
    expect(resolveInstanceUrl(base)).toBe('http://localhost:8880');
  });

  it('strips trailing slashes', () => {
    expect(resolveInstanceUrl({ host: 'h', port: 1, publicUrl: 'http://nyx.local:8880/' }))
      .toBe('http://nyx.local:8880');
  });
});

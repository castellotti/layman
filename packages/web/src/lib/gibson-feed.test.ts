import { describe, expect, it } from 'vitest';
import { MATRIX_WINDOWS } from './matrix-feed.js';
import { gibsonLogUrl, gibsonUrls } from './gibson-feed.js';

describe('gibsonUrls', () => {
  it('asks for hosts and links the way the Matrix asks', () => {
    expect(gibsonUrls({ sessionId: 'abc', window: '15m' })).toEqual({
      hosts: '/api/styx/v1/hosts?session=abc&relative=15m',
      links: '/api/styx/v1/links?session=abc&relative=15m',
    });
    expect(gibsonUrls({ sessionId: 'abc', window: 'all' }).hosts).toBe('/api/styx/v1/hosts?session=abc');
    expect(gibsonUrls({ sessionId: null, window: 'all' }).links).toBe('/api/styx/v1/links?relative=1d');
    expect(gibsonUrls({ sessionId: null, window: '1m' }).hosts).toBe('/api/styx/v1/hosts?relative=60s');
  });
});

describe('gibsonLogUrl', () => {
  it('adds the host and a limit', () => {
    expect(gibsonLogUrl({ sessionId: 'abc', window: '1h', host: 'github.com' }))
      .toBe('/api/styx/v1/flows?session=abc&relative=1h&host=github.com&limit=100');
    expect(gibsonLogUrl({ sessionId: null, window: 'all', host: 'a.b', limit: 5 }))
      .toBe('/api/styx/v1/flows?relative=1d&host=a.b&limit=5');
  });
  it('only ever emits a /api/styx/ path, whatever the host or session says', () => {
    for (const w of MATRIX_WINDOWS) {
      for (const host of ['x.org', '../../etc', 'a b&c=d', '1.2.3.4']) {
        for (const sessionId of [null, 'a b&c=d']) {
          const url = gibsonLogUrl({ sessionId, window: w.id, host });
          expect(url.split('?')[0]).toBe('/api/styx/v1/flows');
          expect(new URL(url, 'http://x').searchParams.get('host')).toBe(host);
        }
      }
    }
  });
});

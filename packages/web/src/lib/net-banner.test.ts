import { describe, it, expect } from 'vitest';
import { bannerHosts, isDismissed } from './net-banner.js';

describe('the Map banner dismissal', () => {
  it('names each host once, sorted, falling back to the endpoint', () => {
    expect(bannerHosts([
      { host: 'b.com', endpoint: null, key: 'b.com:443' },
      { host: 'a.com', endpoint: null, key: 'a.com:443' },
      { host: 'a.com', endpoint: null, key: 'a.com:80' },
      { host: null, endpoint: 'glove-x-proxy:8888', key: '@proxy' },
    ])).toEqual(['a.com', 'b.com', 'glove-x-proxy:8888']);
  });

  it('stays dismissed for the hosts it covered, and comes back for a new one', () => {
    expect(isDismissed(['a.com'], undefined)).toBe(false);
    expect(isDismissed(['a.com'], ['a.com', 'b.com'])).toBe(true);
    expect(isDismissed(['a.com', 'c.com'], ['a.com', 'b.com'])).toBe(false);
  });
});

/**
 * The rule that must not be relaxed (docs/extensions/glove.md → Network): Layman
 * never makes a network request keyed on gloved flow data — no DNS, geo-IP API,
 * favicon fetch, link unfurl or "prettier label". Crude by design: it exists so
 * a future change to the network views trips over the rule before it ships.
 * The server has the same guard over `netobs/` (which holds the `/gates` route the Activity map reads).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getJson } from '../hooks/useNetTrace.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ...readdirSync(join(src, 'components', 'network')).map((f) => join('components', 'network', f)),
  ...readdirSync(join(src, 'lib')).filter((f) => f.startsWith('net-')).map((f) => join('lib', f)),
  join('stores', 'netStore.ts'),
  join('hooks', 'useNetPanels.ts'),
  // The Activity map reads gloved sessions' gates, so it is held to the same rule.
  ...readdirSync(join(src, 'components', 'activity')).map((f) => join('components', 'activity', f)),
  ...readdirSync(join(src, 'lib')).filter((f) => f.startsWith('activity-')).map((f) => join('lib', f)),
  ...readdirSync(join(src, 'hooks')).filter((f) => /^use(Activity|Glove|StationSetup|NetSegments)/.test(f)).map((f) => join('hooks', f)),
].filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'));

const BANNED: Array<[string, RegExp]> = [
  ['fetch() to anything but /api/', /fetch\(\s*(?!['"`]\/api\/)/],
  ['new WebSocket(', /new WebSocket\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['navigator.sendBeacon', /sendBeacon/],
  ['an <img> or background from outside the bundle', /(src|href)=["'{`]\s*["'`]?(https?:)?\/\//],
  ['url(http…)', /url\(\s*['"]?(https?:)?\/\//],
  ['favicon', /favicon/i],
  ['import from dns/net/http', /from ['"](node:)?(dns|net|https?|tls)['"]/],
];

describe('no-network guard (web network views)', () => {
  it('covers the network views', () => {
    expect(files.length).toBeGreaterThanOrEqual(16);
  });
  it.each(files)('%s makes no network call keyed on flow data', (file) => {
    const text = readFileSync(join(src, file), 'utf8');
    for (const [what, re] of BANNED) expect(re.test(text), `${file}: ${what}`).toBe(false);
  });
  // useNetTrace.ts is not in the list: its `getJson(url)` takes a variable, so it enforces the rule when it runs.
  it('getJson refuses anything but a Layman API path, without making a request', async () => {
    let called = false;
    const real = globalThis.fetch;
    globalThis.fetch = (() => { called = true; return Promise.reject(new Error('no')); }) as typeof fetch;
    try {
      for (const url of ['https://example.com/x', '//example.com/x', 'http://127.0.0.1/api/x', '/other', '/api/../x', '/api/%2e%2e/x', '/api/\\evil.com', '/api//x/../y']) {
        await expect(getJson(url)).rejects.toThrow(/Layman's API only/);
      }
    } finally { globalThis.fetch = real; }
    expect(called).toBe(false);
  });
  it('getJson still requests a Layman API path', async () => {
    const real = globalThis.fetch;
    let asked = '';
    globalThis.fetch = ((u: string) => { asked = u; return Promise.resolve(new Response('{"ok":1}')); }) as typeof fetch;
    try { await expect(getJson('/api/net/sessions/t/gates?x=1')).resolves.toEqual({ ok: 1 }); }
    finally { globalThis.fetch = real; }
    expect(asked).toBe('/api/net/sessions/t/gates?x=1');
  });
});

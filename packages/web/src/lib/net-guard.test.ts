/**
 * The rule that must not be relaxed (docs/extensions/glove.md → Network): Layman
 * never makes a network request keyed on gloved flow data — no DNS, geo-IP API,
 * favicon fetch, link unfurl or "prettier label". Crude by design: it exists so
 * a future change to the network views trips over the rule before it ships.
 * The server has the same guard over `netobs/`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ...readdirSync(join(src, 'components', 'network')).map((f) => join('components', 'network', f)),
  ...readdirSync(join(src, 'lib')).filter((f) => f.startsWith('net-')).map((f) => join('lib', f)),
  join('stores', 'netStore.ts'),
  join('hooks', 'useNetPanels.ts'),
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
    expect(files.length).toBeGreaterThanOrEqual(8);
  });
  it.each(files)('%s makes no network call keyed on flow data', (file) => {
    const text = readFileSync(join(src, file), 'utf8');
    for (const [what, re] of BANNED) expect(re.test(text), `${file}: ${what}`).toBe(false);
  });
});

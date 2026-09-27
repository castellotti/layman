/**
 * The network types are a cross-repo contract (glove → server → web), so the
 * hand-kept mirror gets a guard instead of trust: everything after each file's
 * header comment must match the server's copy exactly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const body = (src: string) => {
  const start = src.indexOf('// ─── glove');
  const end = src.indexOf('// ─── WebSocket frames');
  return src.slice(start, end === -1 ? undefined : end).trim();
};

describe('netobs-types mirror', () => {
  it('matches packages/server/src/netobs/types.ts', () => {
    const server = readFileSync(join(here, '../../../server/src/netobs/types.ts'), 'utf8');
    const web = readFileSync(join(here, 'netobs-types.ts'), 'utf8');
    expect(body(web)).toBe(body(server));
  });

  it('mirrors every net:* frame the server sends', () => {
    const frames = (src: string) => [...new Set([...src.matchAll(/type: '(net:[a-z:]+)'/g)].map((m) => m[1]))].sort();
    const server = readFileSync(join(here, '../../../server/src/netobs/index.ts'), 'utf8');
    const web = readFileSync(join(here, 'netobs-types.ts'), 'utf8');
    expect(frames(web)).toEqual(frames(server));
  });
});

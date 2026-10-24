/**
 * The glove checkout beside this repository, for the cross-checks and fixture drift guards.
 *
 * A fixed `../../../../../glove` only resolves from the main checkout: from a git worktree
 * (`.claude/worktrees/<name>/…`) it named nothing, and every test keyed on it skipped without a
 * word. So: `$GLOVE_DIR` if set (and it must be a glove checkout: a typo would skip them again),
 * else the nearest ancestor's `glove/` that looks like glove's repository (`tests/fixtures/`;
 * Layman's own `src/glove/` has none). The drift guards compare against whatever that checkout
 * has checked out, so keep it on `main`.
 */
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const isGlove = (d: string) => existsSync(join(d, 'tests', 'fixtures'));

function find(): string {
  const env = process.env.GLOVE_DIR;
  if (env) {
    const d = resolve(env);
    if (!isGlove(d)) throw new Error(`GLOVE_DIR=${env} is not a glove checkout (no tests/fixtures/)`);
    return d;
  }
  let d = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (isGlove(join(d, 'glove'))) return join(d, 'glove');
    const up = dirname(d);
    if (up === d) return join(d, 'glove'); // not found: a path that does not exist, so the tests skip
    d = up;
  }
}

export const GLOVE_CHECKOUT = find();

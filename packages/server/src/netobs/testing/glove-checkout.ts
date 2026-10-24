/**
 * The glove checkout beside this repository, for the cross-checks and fixture drift guards.
 *
 * A fixed `../../../../../glove` only resolves from the main checkout: from a git worktree
 * (`.claude/worktrees/<name>/…`) it named nothing, and every test keyed on it skipped without a
 * word. So: `$GLOVE_DIR` if set, else the nearest ancestor's `glove/` that looks like glove's
 * repository (`tests/fixtures/`; Layman's own `src/glove/` has none).
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

function find(): string {
  if (process.env.GLOVE_DIR) return process.env.GLOVE_DIR;
  let d = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(d, 'glove');
    if (existsSync(join(candidate, 'tests', 'fixtures'))) return candidate;
    const up = dirname(d);
    if (up === d) return join(d, 'glove'); // not found: a path that does not exist, so the tests skip
    d = up;
  }
}

export const GLOVE_CHECKOUT = find();

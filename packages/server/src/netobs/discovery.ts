/**
 * Where glove's network records are: a plain glob of
 * `<gloveHome>/envs/*\/sessions/*\/net/`.
 *
 * Deliberately *not* routed through `GloveSource`. That source grew registry and
 * `homes/` handling because a harness home can be relocated out of the session
 * directory; `net/` never is (handoff §1), so none of that applies here and
 * reusing it would only couple two unrelated discovery rules.
 */
import { readdirSync, statSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';

export interface NetSessionLocation {
  /** glove's session token: what flows carry in `session`, and `GloveSource`'s WatchRoot label. */
  token: string;
  env: string;
  /** Directory name under `envs/<env>/sessions/`. Differs from the token for a named session. */
  name: string;
  netDir: string;
  /** `<gloveHome>/control/<env>/<name>/` — keyed by the directory name, not the token. */
  controlDir: string;
  rulesPath: string;
}

/**
 * The only env and session directory names Layman will act on. glove's own ids
 * fit it; anything else (a stray `..`, a name with a separator) is skipped rather
 * than turned into a path, since the same names later address the one directory
 * Layman may write to.
 */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * glove's session token (handoff §1): the env id for the default session, whose
 * directory is named after the env, else `<env>-<name>`.
 */
export function sessionToken(env: string, name: string): string {
  return name === env ? env : `${env}-${name}`;
}

/** `~/.glove` from `~/.glove/envs`: the control dir is a sibling of the sessions dir. */
export function gloveHomeFromSessionsDir(sessionsDir: string): string {
  return dirname(resolve(sessionsDir));
}

/**
 * Where rules.json lives for a session. Uses the **directory name**, while the
 * file's own `session` field is the **token**; for a named session the two
 * differ, and mixing them up makes the gate ignore the file. Returns null for a
 * name that is unsafe, or that would resolve outside `<gloveHome>/control`.
 */
export function controlPaths(
  gloveHome: string,
  env: string,
  name: string,
): { controlDir: string; rulesPath: string } | null {
  if (!SAFE_NAME.test(env) || !SAFE_NAME.test(name)) return null;
  const root = resolve(gloveHome, 'control');
  const controlDir = resolve(root, env, name);
  if (!controlDir.startsWith(root + sep)) return null;
  return { controlDir, rulesPath: join(controlDir, 'rules.json') };
}

function subdirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    try {
      return statSync(join(dir, n)).isDirectory();
    } catch {
      return false;
    }
  });
}

export class NetSessionSource {
  /** @param getSessionsDir the expanded glove sessions dir, or null when network views are off. */
  constructor(private readonly getSessionsDir: () => string | null) {}

  discover(): NetSessionLocation[] {
    const sessionsDir = this.getSessionsDir();
    if (!sessionsDir) return [];
    const gloveHome = gloveHomeFromSessionsDir(sessionsDir);
    const out: NetSessionLocation[] = [];
    for (const env of subdirs(sessionsDir)) {
      if (!SAFE_NAME.test(env)) continue;
      const sessionsRoot = join(sessionsDir, env, 'sessions');
      for (const name of subdirs(sessionsRoot)) {
        const netDir = join(sessionsRoot, name, 'net');
        try {
          if (!statSync(netDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const control = controlPaths(gloveHome, env, name);
        if (!control) continue;
        out.push({ token: sessionToken(env, name), env, name, netDir, ...control });
      }
    }
    return out;
  }
}

/**
 * `GET /api/fs/browse`: the folder listing behind Settings' Browse… buttons.
 *
 * A browser never reveals a real path from a file input, so the picker is drawn by the web app from what
 * Layman's server can see. Names only, read-only, no network: never a file's contents, and nothing is
 * created, chmod'ed or touched (least of all under `~/.glove`). The rule is `resolve` + `realpath`
 * containment in two roots, the home folder and Layman's data folder; a path outside both is clamped to
 * home, and a symlink whose target is outside both is not listed. Do not widen it.
 *
 * Paths go out as the user writes them (`~/…`, or host-absolute) so a pick saved from a Docker Layman,
 * where the home is mounted elsewhere, still reads right on the host and natively.
 */
import { readdirSync, realpathSync, statSync } from 'fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'path';
import { homedir } from 'os';
import type { FastifyInstance } from 'fastify';
import { laymanDataDir } from '../config/paths.js';
import { rebaseGloveHome } from '../glove/registry.js';
import { tildeHostPath } from '../netobs/discovery.js';

export const MAX_ENTRIES = 1000;

export interface BrowseEntry {
  name: string;
  kind: 'dir' | 'file';
}

export interface BrowseResult {
  /** The listed folder. */
  path: string;
  /** Its parent, or null at an allowed root. */
  parent: string | null;
  entries: BrowseEntry[];
  /** The input, in the same form. */
  requested: string;
  requestedExists: boolean;
  truncated: boolean;
  error?: string;
}

export interface BrowseEnv {
  home: string;
  dataDir: string;
  /** `HOST_HOME`: where the home is on the host when it is mounted elsewhere (Docker). */
  hostHome?: string;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

const byName = (a: BrowseEntry, b: BrowseEntry): number => {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const dotA = a.name.startsWith('.');
  const dotB = b.name.startsWith('.');
  if (dotA !== dotB) return dotA ? 1 : -1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
};

export function browse(input: string, ext: string, env: BrowseEnv): BrowseResult {
  const home = realOr(env.home);
  const roots = [home, realOr(env.dataDir)];
  const show = (p: string) => tildeHostPath(p, env.hostHome, home);
  const inRoots = (p: string) => roots.some((r) => within(r, p));

  let raw = input.trim();
  if (raw === '' || raw === '~') raw = home;
  else if (raw.startsWith('~/')) raw = join(home, raw.slice(2));
  else if (!isAbsolute(raw)) raw = join(home, raw);
  else raw = rebaseGloveHome(normalize(raw), env.hostHome, home);
  const asked = resolve(raw);

  // The deepest part of the path that exists, as a real path; a file stands for its folder.
  let cursor = asked;
  let real: string | null = null;
  let exact = true;
  for (;;) {
    try {
      real = realpathSync(cursor);
      break;
    } catch {
      const up = dirname(cursor);
      exact = false;
      if (up === cursor) break;
      cursor = up;
    }
  }
  let dir = real ?? home;
  let requestedExists = exact && real !== null;
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    dir = home;
  }
  if (!inRoots(dir)) {
    dir = home;
    requestedExists = false;
  }

  const wanted = ext.toLowerCase();
  const entries: BrowseEntry[] = [];
  let error: string | undefined;
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      let kind: 'dir' | 'file' | null = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
      if (d.isSymbolicLink()) {
        try {
          const target = realpathSync(join(dir, d.name));
          if (!inRoots(target)) continue;
          const st = statSync(target);
          kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
        } catch {
          continue;
        }
      }
      if (kind === 'dir') entries.push({ name: d.name, kind });
      else if (kind === 'file' && wanted && d.name.toLowerCase().endsWith(wanted)) entries.push({ name: d.name, kind });
    }
  } catch (e) {
    error = (e as NodeJS.ErrnoException).code === 'EACCES' ? 'This folder cannot be read.' : 'This folder cannot be listed.';
  }
  entries.sort(byName);
  const truncated = entries.length > MAX_ENTRIES;
  const up = dirname(dir);
  return {
    path: show(dir),
    parent: up !== dir && inRoots(up) ? show(up) : null,
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    requested: show(asked),
    requestedExists,
    truncated,
    ...(error ? { error } : {}),
  };
}

export function registerFsBrowseRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string; ext?: string } }>('/api/fs/browse', async (req, reply) => {
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const ext = typeof req.query.ext === 'string' && /^\.[A-Za-z0-9]{1,10}$/.test(req.query.ext) ? req.query.ext : '';
    if (path.length > 4096 || path.includes('\0')) return reply.code(400).send({ error: 'Bad path' });
    return browse(path, ext, { home: homedir(), dataDir: laymanDataDir(), hostHome: process.env.HOST_HOME });
  });
}

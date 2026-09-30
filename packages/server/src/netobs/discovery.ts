/**
 * Where glove v3's network records are: `<gloveHome>/observe/<id>/net/`, one per
 * session with the **observe** grant. The id is the token: the directory name
 * under `observe/` and under `control/`, and the `env` and `session` of every
 * record and of `rules.json`.
 *
 * Grants and the orphan state come from glove's own files (`glove/registry.ts`):
 * `session.json` (what the gates were rendered with), else the registry row. A
 * registry row with no observe export is listed as not observable and is never
 * looked for anywhere else.
 */
import { statSync } from 'fs';
import { join, resolve, sep } from 'path';
import { homedir } from 'os';
import {
  observeIds, readRegistry, readSessionFacts, sessionDirState, SESSION_ID,
  type GloveGrants, type RegistryRow, type RegistryState,
} from '../glove/registry.js';

export interface NetSessionLocation {
  /** glove's session id: what flows carry in `session`, and `GloveSource`'s WatchRoot label. */
  token: string;
  netDir: string;
  /** `<gloveHome>/control/<id>/`: exists only while the session has the filter grant. */
  controlDir: string;
  rulesPath: string;
}

/** What glove says about a session with an observe export. */
export interface GloveSessionInfo {
  harness: string | null;
  template: string | null;
  grants: GloveGrants;
  /**
   * glove's orphan rule (`glove gc`): no registry row, or the row's directory is
   * gone or holds another session. Null when it is not an orphan, or when this
   * process cannot see the directory to tell.
   */
  orphaned: 'no-row' | 'missing' | 'stale' | null;
}

/** A registered session Layman may not read: no observe grant, so no export. */
export interface NotObservableSession {
  token: string;
  harness: string;
  template: string | null;
}

export interface NetDiscovery {
  registry: { state: RegistryState; detail: string };
  sessions: Array<{ loc: NetSessionLocation; info: GloveSessionInfo }>;
  notObservable: NotObservableSession[];
}

/** The id pattern Layman acts on (glove's `ID_RE`). Anything else is skipped, never turned into a path. */
export const SAFE_NAME = SESSION_ID;

/**
 * Where rules.json lives for a session: `<gloveHome>/control/<id>/rules.json`.
 * Null for an id that is not a glove id, or that would resolve outside
 * `<gloveHome>/control`.
 */
export function controlPaths(gloveHome: string, id: string): { controlDir: string; rulesPath: string } | null {
  if (!SAFE_NAME.test(id)) return null;
  const root = resolve(gloveHome, 'control');
  const controlDir = resolve(root, id);
  if (!controlDir.startsWith(root + sep)) return null;
  return { controlDir, rulesPath: join(controlDir, 'rules.json') };
}

/**
 * A path as the user sees it on the host. Inside the container the host home is
 * mounted at the container home (`HOST_HOME` names it), so a path Layman shows
 * must be translated back, or "Show file" points at `/root/.glove/…`, which does
 * not exist on the user's machine. The inverse of `rebaseGloveHome`
 * (glove/registry.ts); a no-op for native Layman.
 */
export function toHostPath(p: string, hostHome = process.env.HOST_HOME, containerHome = homedir()): string {
  if (!hostHome || hostHome === containerHome) return p;
  if (p === containerHome) return hostHome;
  return p.startsWith(containerHome + sep) ? join(hostHome, p.slice(containerHome.length + 1)) : p;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const EMPTY: NetDiscovery = { registry: { state: 'absent', detail: '' }, sessions: [], notObservable: [] };

export class NetSessionSource {
  /** @param getGloveHome the expanded glove home (`~/.glove`), or null when network views are off. */
  constructor(private readonly getGloveHome: () => string | null) {}

  discover(): NetDiscovery {
    const home = this.getGloveHome();
    if (!home) return EMPTY;
    const registry = readRegistry(home);
    const rows = new Map<string, RegistryRow>(registry.rows.map((r) => [r.id, r]));
    const sessions: NetDiscovery['sessions'] = [];
    const exported = new Set<string>();
    for (const id of observeIds(home)) {
      const netDir = join(home, 'observe', id, 'net');
      if (!isDir(netDir)) continue;
      const control = controlPaths(home, id);
      if (!control) continue;
      exported.add(id);
      const row = rows.get(id);
      const facts = readSessionFacts(netDir);
      let orphaned: GloveSessionInfo['orphaned'] = null;
      // Only a readable v2 registry can say a row is missing; an unreadable one proves nothing.
      if (!row) orphaned = registry.state === 'ok' ? 'no-row' : null;
      else {
        const dir = sessionDirState(row);
        if (dir === 'missing' || dir === 'stale') orphaned = dir;
      }
      sessions.push({
        loc: { token: id, netDir, ...control },
        info: {
          harness: row?.harness ?? facts?.harness ?? null,
          template: row?.template ?? null,
          grants: facts?.grants ?? row?.grants ?? { observe: null, filter: null },
          orphaned,
        },
      });
    }
    const notObservable = registry.rows
      .filter((r) => !exported.has(r.id) && r.grants.observe === null)
      .map((r) => ({ token: r.id, harness: r.harness, template: r.template }));
    return { registry: { state: registry.state, detail: registry.detail }, sessions, notObservable };
  }
}

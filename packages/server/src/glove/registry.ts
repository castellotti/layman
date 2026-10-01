/**
 * glove v3's home, read-only: `~/.glove/registry.json` (v2) and the observe
 * exports under `~/.glove/observe/<id>/`. The one place Layman reads glove's
 * session list, shared by the passive transcript source (`GloveSource`) and the
 * network views (`netobs/discovery.ts`). See docs/extensions/glove.md.
 *
 * glove v3 is a clean break from v2: a v1 registry (a bare array of
 * environments) is reported as a glove v2 home, never read, exactly as glove
 * itself refuses it. Nothing here writes, creates or stats beyond `~/.glove`,
 * except the orphan check below, which only reads a session directory's
 * `.glove/id` when this process can see that directory.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';

/**
 * A glove v3 session id: `<dirname>-<6 hex>` (glove's `sessiondir.ID_RE`). The
 * id names both `observe/<id>/` and `control/<id>/`, and `glove gc` touches only
 * directories that match it, so anything else under those roots is not glove
 * v3's and is ignored.
 */
export const SESSION_ID = /^[a-z0-9][a-z0-9_-]{0,39}-[0-9a-f]{6}$/;

/** `grants` in `session.json` and in a registry row. `null` means the grant is absent. */
export interface GloveGrants {
  observe: { net: boolean; transcripts: boolean } | null;
  filter: { granted: boolean; since: string | null } | null;
}

export interface RegistryRow {
  id: string;
  /** The session directory as a host path. */
  dir: string;
  harness: string;
  template: string | null;
  created: string | null;
  grants: GloveGrants;
  subnet: string | null;
}

/**
 * What the registry file is. `v2-home` is a glove v2 registry (a bare array),
 * which Layman does not read: the user has to upgrade glove and move it aside.
 */
export type RegistryState = 'ok' | 'absent' | 'v2-home' | 'unsupported' | 'unreadable';

export interface RegistryRead {
  state: RegistryState;
  /** For the UI, when `state` is not `ok`/`absent`. */
  detail: string;
  rows: RegistryRow[];
}

export const REGISTRY_VERSION = 2;

export const NO_GRANTS: GloveGrants = { observe: null, filter: null };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** `grants` from either file, tolerantly: anything malformed reads as not granted. */
export function parseGrants(raw: unknown): GloveGrants {
  const g = obj(raw);
  if (!g) return NO_GRANTS;
  const o = obj(g.observe);
  const f = obj(g.filter);
  return {
    observe: o ? { net: o.net !== false, transcripts: o.transcripts === true } : null,
    filter: f ? { granted: f.granted === true, since: str(f.since) } : null,
  };
}

/** Read `<home>/registry.json`. Rows missing a required key are skipped, as glove itself does. */
export function readRegistry(home: string): RegistryRead {
  const path = join(home, 'registry.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent', detail: '', rows: [] };
    return { state: 'unreadable', detail: `cannot read registry.json (${code})`, rows: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { state: 'unreadable', detail: `registry.json is not valid JSON: ${(e as Error).message}`, rows: [] };
  }
  if (Array.isArray(data)) {
    return {
      state: 'v2-home',
      detail: 'registry.json is a glove v2 registry. Layman supports glove v3 only: upgrade glove, move the old registry aside and recreate sessions with `glove new`.',
      rows: [],
    };
  }
  const d = obj(data);
  if (!d || d.v !== REGISTRY_VERSION) {
    const v = d ? JSON.stringify(d.v) : '?';
    return { state: 'unsupported', detail: `registry.json has version ${v}; this Layman reads version ${REGISTRY_VERSION} (glove v3)`, rows: [] };
  }
  const rows: RegistryRow[] = [];
  for (const raw of Array.isArray(d.sessions) ? d.sessions : []) {
    const r = obj(raw);
    const id = str(r?.id);
    const dir = str(r?.dir);
    const harness = str(r?.harness);
    if (!r || !id || !dir || !harness || !SESSION_ID.test(id)) continue;
    rows.push({
      id, dir, harness,
      template: str(r.template), created: str(r.created), grants: parseGrants(r.grants), subnet: str(r.subnet),
    });
  }
  return { state: 'ok', detail: '', rows };
}

/** Session ids with an observe export: `<home>/observe/<id>/` directories whose name is a glove id. */
export function observeIds(home: string): string[] {
  const root = join(home, 'observe');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((n) => SESSION_ID.test(n) && isDir(join(root, n))).sort();
}

/** An observe export joined to its registry row (absent for an orphan or an unreadable registry). */
export interface GloveExport {
  id: string;
  /** `<home>/observe/<id>`. */
  dir: string;
  row: RegistryRow | undefined;
}

/**
 * Every observe export with its registry row, and the registry read itself: the
 * one join both readers of glove's home use. Each then keeps the exports whose
 * subdirectory it reads (`transcripts/` or `net/`).
 */
export function gloveExports(home: string): { registry: RegistryRead; exports: GloveExport[] } {
  const registry = readRegistry(home);
  const rows = new Map(registry.rows.map((r) => [r.id, r]));
  const exports = observeIds(home).map((id) => ({ id, dir: join(home, 'observe', id), row: rows.get(id) }));
  return { registry, exports };
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The parts of `observe/<id>/net/session.json` discovery needs, or null when it is
 * absent or unreadable. `grants` is null when the file has none (then the registry row decides).
 */
export function readSessionFacts(netDir: string): { harness: string | null; grants: GloveGrants | null } | null {
  try {
    const d = obj(JSON.parse(readFileSync(join(netDir, 'session.json'), 'utf8')));
    if (!d) return null;
    return { harness: str(d.harness), grants: d.grants === undefined ? null : parseGrants(d.grants) };
  } catch {
    return null;
  }
}

/**
 * Whether a registry row's session directory still holds that session: glove's
 * own rule (`glove ls`/`gc`): `missing` when the directory is gone, `stale` when
 * it holds another id. `unknown` when this process cannot see the directory: in
 * the container only `~/.glove` and a few harness folders are mounted, so a
 * missing path proves nothing and is never reported as missing.
 */
export function sessionDirState(
  row: Pick<RegistryRow, 'id' | 'dir'>,
  hostHome = process.env.HOST_HOME,
  containerHome = homedir(),
): 'ok' | 'missing' | 'stale' | 'unknown' {
  const native = !hostHome || normalize(hostHome) === containerHome;
  const dir = rebaseGloveHome(row.dir, hostHome, containerHome);
  if (!existsSync(dir)) return native ? 'missing' : 'unknown';
  try {
    return readFileSync(join(dir, '.glove', 'id'), 'utf8').trim() === row.id ? 'ok' : 'stale';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'stale' : 'unknown';
  }
}

function normalize(p: string): string {
  let s = p;
  while (s.length > 1 && s.endsWith(sep)) s = s.slice(0, -sep.length);
  return s;
}

/**
 * Rebases an absolute host path onto the container home. In Docker the host
 * home (`hostHome`, from `HOST_HOME`) is bind-mounted piecewise at the
 * container home (`containerHome`, `homedir()`). Native Layman (no `HOST_HOME`,
 * or equal to `homedir()`) gets the path unchanged. Path-boundary aware, so
 * `/Users/you-other` is never treated as living under `/Users/you`.
 */
export function rebaseGloveHome(hostPath: string, hostHome: string | undefined, containerHome: string): string {
  if (!hostHome) return hostPath;
  const home = normalize(hostHome);
  if (home === containerHome) return hostPath;
  if (hostPath === home) return containerHome;
  if (hostPath.startsWith(home + sep)) return join(containerHome, hostPath.slice(home.length + 1));
  return hostPath;
}

/**
 * The canonical Layman URL grammar.
 *
 *   /                          dashboard
 *   /s/{sessionId}             a session transcript
 *   /s/{sessionId}/t/{promptEventId}   a TURN — prompt + its final response
 *   /s/{sessionId}/e/{eventId}         a single event
 *   /h/{highlightId}           a saved highlight
 *   /b/{bookmarkId}            a bookmarked session
 *   /f/{folderId}              a bookmark folder
 *
 * Query parameters (orthogonal): ?view=… ?play=1 ?t=<ms>
 *
 * Mirrored in packages/server/src/export/urls.ts — the round-trip test in each
 * package is what keeps the two copies honest.  See CLAUDE.md "Type duplication".
 */

export type ViewName = 'dashboard' | 'logs' | 'prompts' | 'flow' | 'sessions';

export const VIEW_NAMES: readonly ViewName[] = ['dashboard', 'logs', 'prompts', 'flow', 'sessions'];

export type LaymanRoute =
  | { kind: 'dashboard' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'turn'; sessionId: string; promptEventId: string }
  | { kind: 'event'; sessionId: string; eventId: string }
  | { kind: 'highlight'; highlightId: string }
  | { kind: 'bookmark'; bookmarkId: string }
  | { kind: 'folder'; folderId: string };

export interface RouteOptions {
  view?: ViewName;
  /** Auto-speak the addressed turn on arrival (see the TTS workstream). */
  play?: boolean;
  /** Scroll to a timestamp (ms) instead of an id. */
  t?: number;
}

export interface ParsedRoute {
  route: LaymanRoute;
  opts: RouteOptions;
}

/**
 * Ids come from randomUUID() in practice. Slashes are percent-encoded on build
 * and decoded on parse, so the only genuinely invalid id is an empty one.
 */
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0;
}

function seg(id: string): string {
  return encodeURIComponent(id);
}

function buildQuery(opts: RouteOptions | undefined): string {
  if (!opts) return '';
  const params: string[] = [];
  if (opts.view) params.push(`view=${encodeURIComponent(opts.view)}`);
  if (opts.play) params.push('play=1');
  if (opts.t !== undefined && Number.isFinite(opts.t)) params.push(`t=${opts.t}`);
  return params.length > 0 ? `?${params.join('&')}` : '';
}

/** Path + query for a route, e.g. "/s/abc/t/def?play=1". */
export function buildPath(route: LaymanRoute, opts?: RouteOptions): string {
  const query = buildQuery(opts);

  switch (route.kind) {
    case 'dashboard':
      return `/${query}`;
    case 'session':
      return `/s/${seg(route.sessionId)}${query}`;
    case 'turn':
      return `/s/${seg(route.sessionId)}/t/${seg(route.promptEventId)}${query}`;
    case 'event':
      return `/s/${seg(route.sessionId)}/e/${seg(route.eventId)}${query}`;
    case 'highlight':
      return `/h/${seg(route.highlightId)}${query}`;
    case 'bookmark':
      return `/b/${seg(route.bookmarkId)}${query}`;
    case 'folder':
      return `/f/${seg(route.folderId)}${query}`;
  }
}

/** Absolute URL for a route on a given instance. */
export function buildUrl(instanceUrl: string, route: LaymanRoute, opts?: RouteOptions): string {
  return `${instanceUrl.replace(/\/+$/, '')}${buildPath(route, opts)}`;
}

function parseQuery(search: string): RouteOptions {
  const opts: RouteOptions = {};
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return opts;

  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));

    if (key === 'view' && (VIEW_NAMES as readonly string[]).includes(value)) {
      opts.view = value as ViewName;
    } else if (key === 'play' && (value === '1' || value === 'true')) {
      opts.play = true;
    } else if (key === 't') {
      const ms = Number(value);
      if (Number.isFinite(ms)) opts.t = ms;
    }
  }
  return opts;
}

/**
 * Parses a pathname (+ optional query) into a route.
 * Returns null for anything outside the grammar so callers can fall back to a
 * "not found on this instance" state rather than guessing.
 */
export function parsePath(pathname: string, search = ''): ParsedRoute | null {
  const [rawPath, inlineQuery] = pathname.split('?');
  const opts = parseQuery(search || (inlineQuery ? `?${inlineQuery}` : ''));

  const parts = rawPath.split('/').filter((p) => p.length > 0).map((p) => decodeURIComponent(p));

  if (parts.length === 0) return { route: { kind: 'dashboard' }, opts };

  const [head, first, mid, second] = parts;

  if (head === 's' && isValidId(first)) {
    if (parts.length === 2) return { route: { kind: 'session', sessionId: first }, opts };
    if (parts.length === 4 && isValidId(second)) {
      if (mid === 't') return { route: { kind: 'turn', sessionId: first, promptEventId: second }, opts };
      if (mid === 'e') return { route: { kind: 'event', sessionId: first, eventId: second }, opts };
    }
    return null;
  }

  if (parts.length === 2 && isValidId(first)) {
    if (head === 'h') return { route: { kind: 'highlight', highlightId: first }, opts };
    if (head === 'b') return { route: { kind: 'bookmark', bookmarkId: first }, opts };
    if (head === 'f') return { route: { kind: 'folder', folderId: first }, opts };
  }

  return null;
}

/**
 * Resolves the instance URL used when generating outbound links.
 * `publicUrl` wins so a hub browsed over the LAN emits its own name rather than
 * localhost; `hookUrl` is the Docker-aware fallback already used for hooks.
 */
export function resolveInstanceUrl(config: {
  publicUrl?: string;
  hookUrl?: string;
  host: string;
  port: number;
}): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  if (config.hookUrl) return config.hookUrl.replace(/\/+$/, '');
  return `http://${config.host}:${config.port}`;
}

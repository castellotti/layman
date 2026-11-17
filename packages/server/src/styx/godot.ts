/**
 * Serving a local styx-godot web export for the Matrix (Godot) tab (docs/extensions/styx.md).
 *
 * The build is never part of Layman: the user makes it and Layman serves the folder. `resolveGodotFile`
 * is the only path from a URL to a file here, so everything that can escape the folder is refused in it.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { resolve, sep, extname } from 'path';

export const GODOT_PREFIX = '/styx/godot/';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Browsers refuse to stream-compile a .wasm served as anything else.
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

/** The file a request path names inside `dir`, or null: traversal, a dotfile, an unknown type. */
export function resolveGodotFile(dir: string, urlPath: string): { file: string; type: string } | null {
  if (!urlPath.startsWith(GODOT_PREFIX)) return null;
  let rel = urlPath.slice(GODOT_PREFIX.length).split(/[?#]/)[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (rel === '') rel = 'index.html';
  if (rel.includes('\0') || rel.includes('\\')) return null;
  if (rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.'))) return null;
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type) return null;
  const root = resolve(dir);
  const file = resolve(root, rel);
  if (!file.startsWith(root + sep)) return null;
  return { file, type };
}

/** `resolveGodotFile` is lexical; this is the check against symlinks, which may not lead out of the folder. */
export function insideFolder(dir: string, file: string): boolean {
  try {
    const root = realpathSync(dir);
    return realpathSync(file).startsWith(root + sep);
  } catch {
    return false;
  }
}

export interface GodotBuildStatus {
  present: boolean;
  dir: string;
  builtAt: number | null;
  files: number;
  problems: string[];
}

const REQUIRED = ['index.html', 'index.js', 'index.wasm', 'index.pck'];

export function godotBuildStatus(dir: string): GodotBuildStatus {
  const problems: string[] = [];
  const missing = REQUIRED.filter((f) => !existsSync(resolve(dir, f)));
  if (!existsSync(dir)) problems.push('The build folder does not exist.');
  else if (missing.length > 0) problems.push(`Missing from the build folder: ${missing.join(', ')}.`);
  let blocked = false;
  if (!missing.includes('index.html')) {
    try {
      const html = readFileSync(resolve(dir, 'index.html'), 'utf8');
      if (html.includes('jsdelivr') || /<script[^>]*\ssrc=["']?http/i.test(html)) {
        blocked = true;
        problems.push("This build loads scripts from another site; rebuild with the 'Web (Layman)' preset.");
      }
    } catch { /* unreadable: reported by the missing/serving paths */ }
  }
  let builtAt: number | null = null;
  try {
    builtAt = statSync(resolve(dir, 'index.wasm')).mtimeMs;
  } catch { /* no wasm */ }
  let files = 0;
  try {
    files = readdirSync(dir).length;
  } catch { /* no folder */ }
  return { present: missing.length === 0 && !blocked, dir, builtAt, files, problems };
}

/**
 * The policy sent with the build's files. `connect-src 'self'` is the point: the build can talk to Layman
 * and nothing else, which is how "every request goes to Layman" is enforced rather than hoped for. Godot's
 * HTML shell uses inline scripts and styles and its JavaScript bridge uses eval, so those directives carry
 * `unsafe-*`, scoped to these responses only. If a build fails to start, the console names the directive
 * that blocked it: loosen that one, never `connect-src` or `default-src`, and record why here.
 */
export const GODOT_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

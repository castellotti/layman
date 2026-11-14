import { closeSync, openSync, readSync, readdirSync, statSync, fstatSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * The Claude Code version, as far as Layman can tell without running `claude`
 * (the server may be in a container): Claude Code writes its own version on
 * every transcript line, so the newest transcripts under `~/.claude/projects`
 * say which build last ran. Unknown is `null`, and a hook that needs a version
 * is then not registered.
 */
export type Version = readonly [number, number, number];

/**
 * An unrecognised hook event name in settings.json made Claude Code ignore the
 * whole file before this version (changelog 2.1.101), so a newer event is only
 * registered once a build at least this new has been seen.
 */
export const UNKNOWN_HOOK_SAFE: Version = [2, 1, 101];

const TAIL_BYTES = 64 * 1024;
const NEWEST_FILES = 6;
const CACHE_MS = 60_000;

export function parseVersion(text: string): Version | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function atLeast(v: Version | null, min: Version): boolean {
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i]! > min[i]!;
  }
  return true;
}

/** The greatest `"version":"x.y.z"` in a transcript's last lines. */
export function versionInTail(text: string): Version | null {
  let best: Version | null = null;
  for (const m of text.matchAll(/"version":"(\d+\.\d+\.\d+)"/g)) {
    const v = parseVersion(m[1]!);
    if (v && (!best || atLeast(v, best))) best = v;
  }
  return best;
}

function tailOf(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

export function detectClaudeCodeVersion(projectsDir: string): Version | null {
  const files: { path: string; mtime: number }[] = [];
  try {
    for (const dir of readdirSync(projectsDir)) {
      let names: string[];
      try {
        names = readdirSync(join(projectsDir, dir));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(projectsDir, dir, name);
        try {
          files.push({ path, mtime: statSync(path).mtimeMs });
        } catch { /* vanished */ }
      }
    }
  } catch {
    return null;
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let best: Version | null = null;
  for (const f of files.slice(0, NEWEST_FILES)) {
    try {
      const v = versionInTail(tailOf(f.path));
      if (v && (!best || atLeast(v, best))) best = v;
    } catch { /* unreadable */ }
  }
  return best;
}

let cached: { at: number; dir: string; v: Version | null } | null = null;

/** Cached for a minute: the installer's status is polled by Settings. */
export function claudeCodeVersion(projectsDir = join(homedir(), '.claude', 'projects'), now = Date.now()): Version | null {
  if (cached && cached.dir === projectsDir && now - cached.at < CACHE_MS) return cached.v;
  const v = detectClaudeCodeVersion(projectsDir);
  cached = { at: now, dir: projectsDir, v };
  return v;
}

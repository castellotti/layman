/**
 * The only code in Layman that writes into `~/.glove`, and only
 * `control/<env>/<name>/rules.json`. It follows glove's ownership contract
 * (glove's `network-observability-layman-followup-results.md` §3, handoff §3
 * "Ownership") literally, because the gate runs as the user who ran glove and
 * must be able to read what Layman writes:
 *
 *  1. Never create the session's control directory: glove creates it (the
 *     user's, 0700) before any gate starts. No directory → no controls.
 *  2. Write a temp file *in that directory* under a name unique to Layman,
 *     fsync it, chown it to the directory's owner as `stat` reports it, chmod
 *     0600, then rename it onto rules.json. If the chown fails, delete the temp
 *     file, do not rename, and report the error.
 *  3. Put nothing else in the directory.
 *
 * Without step 2's chown, a Layman running as root on a rootful Linux engine
 * leaves a `root:root 0600` file the gate cannot read, and the gate reports
 * `cannot read rules.json: permission denied` (glove verified this on rootful
 * Podman). On Docker Desktop and rootless Podman the chown is a no-op.
 */
import { accessSync, chmodSync, chownSync, closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';

export const TEMP_NAME = 'rules.json.layman.tmp';

export type ControlState = 'ok' | 'disabled' | 'no-dir' | 'read-only';

export interface ControlStatus {
  state: ControlState;
  /** Why, for the read-only toggles' tooltip. */
  detail: string;
}

export class WriteError extends Error {}

/**
 * The session's control directory, checked to be a real directory directly
 * inside `controlRoot` (not a symlink out of it): the writer has one job and
 * one directory.
 */
function checkedDir(controlRoot: string, rulesPath: string): string {
  const dir = dirname(resolve(rulesPath));
  const rel = relative(resolve(controlRoot), dir);
  if (!rel || rel.startsWith('..') || rel.split(sep).length !== 2 || resolve(rulesPath) !== join(dir, 'rules.json')) {
    throw new WriteError(`refusing to write outside ${controlRoot}: ${rulesPath}`);
  }
  return dir;
}

/** Whether Layman may write this session's rules, and if not, why. No files are created to find out. */
export function controlStatus(controlRoot: string, rulesPath: string, enabled: boolean): ControlStatus {
  if (!enabled) {
    return { state: 'disabled', detail: 'Blocking from Layman is off (Settings → Glove → Allow blocking from Layman).' };
  }
  let dir: string;
  try {
    dir = checkedDir(controlRoot, rulesPath);
  } catch (e) {
    return { state: 'no-dir', detail: (e as Error).message };
  }
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    return {
      state: 'no-dir',
      detail: 'This session has no control directory: glove creates it when it renders a session with a gate. Layman never creates it.',
    };
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      state: 'read-only',
      detail: code === 'EROFS'
        ? 'The control directory is mounted read-only. Add the ~/.glove/control mount from docker-compose.yml and recreate the container.'
        : `Layman cannot write the control directory (${code ?? 'access denied'}).`,
    };
  }
  return { state: 'ok', detail: '' };
}

/** Replace rules.json with `bytes`, by the contract above. */
export function writeRules(controlRoot: string, rulesPath: string, bytes: Buffer): void {
  const dir = checkedDir(controlRoot, rulesPath);
  let owner: { uid: number; gid: number };
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory()) throw new WriteError(`${dir} is not a directory`);
    owner = { uid: st.uid, gid: st.gid };
  } catch (e) {
    if (e instanceof WriteError) throw e;
    throw new WriteError(`the control directory is missing (${(e as NodeJS.ErrnoException).code}); glove creates it, Layman does not`);
  }
  const tmp = join(dir, TEMP_NAME);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chownSync(tmp, owner.uid, owner.gid);
    chmodSync(tmp, 0o600);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw new WriteError(`could not hand rules.json to the directory's owner (${owner.uid}:${owner.gid}): ${(e as Error).message}`);
  }
  renameSync(tmp, join(dir, 'rules.json'));
}

/** Remove rules.json: back to default allow with no rules (only a missing file means that). */
export function removeRules(controlRoot: string, rulesPath: string): void {
  const dir = checkedDir(controlRoot, rulesPath);
  try {
    unlinkSync(join(dir, 'rules.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** For tests and diagnostics: the owner and mode rules.json ended up with. */
export function rulesFileMode(rulesPath: string): { uid: number; gid: number; mode: number } {
  const st = statSync(rulesPath);
  return { uid: st.uid, gid: st.gid, mode: st.mode & 0o777 };
}

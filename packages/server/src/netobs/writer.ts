/**
 * The only code in Layman that writes into `~/.glove`, and only
 * `control/<id>/rules.json`, and only while the session has glove's **filter**
 * grant. It follows glove's contract for a second
 * writer (docs/extensions/glove.md → Writing rules) literally:
 *
 *  1. Never create, chmod, chown or relabel any directory under `~/.glove`. The
 *     session's control directory is glove's (the user's, 0700, created before
 *     any gate starts, and only with the filter grant). No directory → no
 *     controls. When the grant is revoked glove moves rules.json into the
 *     session directory and removes this one; Layman must not recreate it.
 *  2. Write a temp file *in that directory* under a name unique to Layman,
 *     fsync it, `chmod 0644` it explicitly, then rename it onto rules.json. On
 *     any failure, delete the temp file.
 *  3. Put nothing else in the directory.
 *
 * Why 0644, and explicitly: the gate runs as the user who ran glove and only
 * needs to read the file. Through the umask a root writer with umask 077 would
 * leave `root:root 0600`, which the gate cannot read (`cannot read rules.json:
 * permission denied`; glove verified this on rootful Podman). 0644 exposes
 * nothing: the directory is 0700 and the user's, so no other user can reach the
 * file. glove's CLI can still replace a root-owned file, because the rename needs
 * write permission on the directory, not on the file. An earlier contract had
 * the writer chown the file to the directory's owner instead; glove dropped
 * that so Layman changes no ownership at all.
 */
import { accessSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import type { ControlState, FilterAccess } from './types.js';

export const TEMP_NAME = 'rules.json.layman.tmp';

/** What glove says about writing this session's rules, decided before any file is looked at. */
export interface ControlAccess {
  filter: FilterAccess;
  /** Session deleted; export retained (glove's orphan rule). */
  orphaned: boolean;
}

/** Until glove's grant is known: nothing may be written. */
export const NO_ACCESS: ControlAccess = { filter: 'not-granted', orphaned: false };

const GRANT_HINT = 'add `filter: {}` under `extensions:` in its glove-session.yml and re-run `glove up`';

export interface ControlStatus {
  state: ControlState;
  /** Why, for the read-only toggles' tooltip. */
  detail: string;
}

export class WriteError extends Error {}

/**
 * The session's control directory, checked to be `controlRoot/<id>` (not a
 * symlink out of it): the writer has one job and one directory.
 */
function checkedDir(controlRoot: string, rulesPath: string): string {
  const dir = dirname(resolve(rulesPath));
  const rel = relative(resolve(controlRoot), dir);
  if (!rel || rel.startsWith('..') || rel.split(sep).length !== 1 || resolve(rulesPath) !== join(dir, 'rules.json')) {
    throw new WriteError(`refusing to write outside ${controlRoot}: ${rulesPath}`);
  }
  return dir;
}

/**
 * Whether Layman may write this session's rules, and if not, why. No files are
 * created to find out. glove's grant comes first: without it no setting or
 * mount could make a write take effect.
 */
export function controlStatus(controlRoot: string, rulesPath: string, enabled: boolean, access: ControlAccess): ControlStatus {
  if (access.orphaned) {
    return { state: 'orphaned', detail: 'Session deleted; export retained. There are no rules to change. `glove gc` removes the export.' };
  }
  if (access.filter === 'revoked') {
    return {
      state: 'revoked',
      detail: `Filter access revoked: glove moved this session's rules into its directory (.glove/ext/filter/rules.revoked.json) and Layman will not recreate them. To grant it again, ${GRANT_HINT}.`,
    };
  }
  if (access.filter === 'not-granted') {
    return { state: 'not-granted', detail: `This session does not grant filter access. To allow blocking, ${GRANT_HINT}.` };
  }
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
      detail: 'This session grants filter access but has no control directory yet: glove creates it on `glove up`. Layman never creates it.',
    };
  }
  try {
    accessSync(dir, constants.W_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      state: 'read-only',
      detail: code === 'EROFS'
        ? 'The control directory is mounted read-only: Layman was started without the ~/.glove/control mount (docker-compose.glove-control.yml), which `make docker-run` adds once glove has created ~/.glove/control. Restart Layman that way.'
        : `Layman cannot write the control directory (${code ?? 'access denied'}).`,
    };
  }
  return { state: 'ok', detail: '' };
}

/** Replace rules.json with `bytes`, by the contract above. */
export function writeRules(controlRoot: string, rulesPath: string, bytes: Buffer): void {
  const dir = checkedDir(controlRoot, rulesPath);
  try {
    if (!lstatSync(dir).isDirectory()) throw new WriteError(`${dir} is not a directory`);
  } catch (e) {
    if (e instanceof WriteError) throw e;
    throw new WriteError(`the control directory is missing (${(e as NodeJS.ErrnoException).code}); glove creates it, Layman does not`);
  }
  const tmp = join(dir, TEMP_NAME);
  try {
    const fd = openSync(tmp, 'w', 0o644);
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
      // Explicitly, not through the umask: a 077 umask would make it unreadable to the gate.
      fchmodSync(fd, 0o644);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, 'rules.json'));
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw new WriteError(`could not write rules.json: ${(e as Error).message}`);
  }
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

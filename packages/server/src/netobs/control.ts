/**
 * rules.json per session: what is on disk, what the gate enforces, and what
 * became of Layman's own last write. The UI only ever claims what the gate
 * confirms, so everything here is decided by glove's hash rule, never by
 * timestamps:
 * `status.json` `rules.sha256` names the bytes the gate enforces, and
 * `rules.last_rejected.sha256` the bytes it last refused.
 *
 * Layman never treats its own last write as the truth. It re-reads the file
 * whenever its signature changes, and applies every operation to a fresh read.
 */
import { createHash, randomBytes } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { parseRulesForDisplay } from './parse.js';
import {
  RulesError, applyOp, asRulesFile, emptyRules, newRuleId, parseRulesBytes, serializeRules, validateRules,
  type RuleSet,
} from './rules.js';
import { controlStatus, removeRules, writeRules } from './writer.js';
import { toHostPath, type NetSessionLocation } from './discovery.js';
import type { RulesFile, RulesOp, RulesView, RulesWriteView, StatusRecord } from './types.js';

/** A write not confirmed within this long is `unconfirmed`: the gate may be stopped. */
export const UNCONFIRMED_MS = 10_000;
/** Valid versions of rules.json remembered by hash, so the enforced set is known after a rejection. */
const CACHE_SIZE = 16;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Known {
  bytes: Buffer;
  file: RulesFile;
  set: RuleSet;
}

interface SessionRules {
  loc: NetSessionLocation;
  sig: string | null;
  exists: boolean;
  bytes: Buffer | null;
  sha256: string | null;
  mtimeMs: number | null;
  readError: string | null;
  display: { file: RulesFile | null; error: string | null };
  /** The disk file as the gate would read it, or why it would refuse it. */
  strict: Known | null;
  invalid: string | null;
  cache: Map<string, Known>;
  write: RulesWriteView | null;
  externalChange: RulesView['externalChange'];
  view: RulesView;
  viewSig: string;
  sets: { enforced: RuleSet | null; written: RuleSet | null };
}

export interface ApplyResult {
  ok: boolean;
  error: string | null;
}

/** The session's `control/` root: two levels above its control directory. */
const controlRoot = (loc: NetSessionLocation) => resolve(loc.controlDir, '..', '..');

function blankView(loc: NetSessionLocation): RulesView {
  return {
    path: loc.rulesPath, displayPath: toHostPath(loc.rulesPath), exists: false, file: null, readError: null, mtimeMs: null,
    sha256: null, invalid: null, enforcement: 'unknown', enforced: null,
    control: { state: 'no-dir', detail: '' }, write: null, externalChange: null,
  };
}

export { blankView as blankRulesView };

/** A read of rules.json: absent, unreadable (a message glove would also print), or its bytes. */
function readRaw(path: string): { exists: boolean; bytes: Buffer | null; error: string | null; sig: string; mtimeMs: number | null } {
  let st;
  try {
    st = statSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false, bytes: null, error: null, sig: 'absent', mtimeMs: null };
    return { exists: true, bytes: null, error: `cannot read rules.json: ${code}`, sig: `error:${code}`, mtimeMs: null };
  }
  const sig = `${st.ino}:${st.mtimeMs}:${st.size}:${st.mode}:${st.uid}:${st.gid}`;
  try {
    return { exists: true, bytes: readFileSync(path), error: null, sig, mtimeMs: st.mtimeMs };
  } catch (e) {
    return { exists: true, bytes: null, error: `cannot read rules.json: ${(e as NodeJS.ErrnoException).code}`, sig, mtimeMs: st.mtimeMs };
  }
}

export class RulesControl {
  private readonly sessions = new Map<string, SessionRules>();
  private readonly controlEnabled: () => boolean;
  private readonly random: (n: number) => Uint8Array;

  constructor(opts: { controlEnabled: () => boolean; random?: (n: number) => Uint8Array }) {
    this.controlEnabled = opts.controlEnabled;
    this.random = opts.random ?? ((n) => randomBytes(n));
  }

  forget(token: string): void {
    this.sessions.delete(token);
  }

  view(token: string): RulesView | null {
    return this.sessions.get(token)?.view ?? null;
  }

  sets(token: string): SessionRules['sets'] {
    return this.sessions.get(token)?.sets ?? { enforced: null, written: null };
  }

  private session(loc: NetSessionLocation): SessionRules {
    let s = this.sessions.get(loc.token);
    if (!s) {
      s = {
        loc, sig: null, exists: false, bytes: null, sha256: null, mtimeMs: null, readError: null,
        display: { file: null, error: null }, strict: null, invalid: null, cache: new Map(),
        write: null, externalChange: null, view: blankView(loc), viewSig: '', sets: { enforced: null, written: null },
      };
      this.sessions.set(loc.token, s);
    }
    return s;
  }

  private remember(s: SessionRules, sha: string, known: Known): void {
    s.cache.delete(sha);
    s.cache.set(sha, known);
    while (s.cache.size > CACHE_SIZE) s.cache.delete(s.cache.keys().next().value!);
  }

  /** Strictly parse bytes for this session, as its gate would. */
  private strict(loc: NetSessionLocation, bytes: Buffer): Known {
    const { set, data } = parseRulesBytes(bytes, { env: loc.env, session: loc.token });
    return { bytes, file: asRulesFile(data), set };
  }

  /** Re-read rules.json if it changed. */
  private readDisk(s: SessionRules, now: number, force = false): void {
    const raw = readRaw(s.loc.rulesPath);
    if (!force && raw.sig === s.sig) return;
    const previousSha = s.sha256;
    const first = s.sig === null;
    s.sig = raw.sig;
    s.exists = raw.exists;
    s.bytes = raw.bytes;
    s.mtimeMs = raw.mtimeMs;
    s.readError = raw.error;
    s.sha256 = raw.bytes ? sha256(raw.bytes) : null;
    s.strict = null;
    s.invalid = null;
    s.display = { file: null, error: raw.error };
    if (raw.bytes) {
      try {
        s.display = parseRulesForDisplay(JSON.parse(raw.bytes.toString('utf8')));
      } catch (e) {
        s.display = { file: null, error: `not valid JSON: ${(e as Error).message}` };
      }
      try {
        s.strict = this.strict(s.loc, raw.bytes);
        this.remember(s, s.sha256!, s.strict);
      } catch (e) {
        s.invalid = (e as Error).message;
      }
    }
    // Someone else wrote it: glove's CLI, an editor, another Layman.
    const ours = s.write && s.write.state !== 'failed' && s.write.sha256 === s.sha256;
    if (!first && previousSha !== s.sha256 && !ours) s.externalChange = { at: now, sha256: s.sha256 };
  }

  /** The gate's view of this file and of Layman's write, by the hash rule. */
  private settle(s: SessionRules, status: StatusRecord | null, now: number): void {
    const r = status?.rules ?? null;
    // No file enforced: the gate reports no hash *and* no source mtime (a pre-follow-up gate reports neither hash, but a mtime).
    const enforcesAbsence = r !== null && r.sha256 === null && r.source_mtime === null;

    let enforcement: RulesView['enforcement'] = 'unknown';
    if (r && !s.readError) {
      if (!s.exists) enforcement = enforcesAbsence ? 'enforced' : 'pending';
      else if (s.sha256 !== null && s.sha256 === r.sha256) enforcement = 'enforced';
      else if (s.sha256 !== null && s.sha256 === r.last_rejected?.sha256) enforcement = 'rejected';
      else enforcement = 'pending';
    }

    let enforced: Known | null = null;
    const empty = (): Known => {
      const file = emptyRules(s.loc.env, s.loc.token);
      return { bytes: Buffer.alloc(0), file, set: validateRules(file) };
    };
    if (r?.sha256) enforced = s.cache.get(r.sha256) ?? null;
    else if (enforcesAbsence) enforced = empty();

    const w = s.write;
    if (w && w.state !== 'failed' && r) {
      if (w.sha256 === null ? enforcesAbsence : w.sha256 === r.sha256) {
        w.state = 'enforced';
        w.error = null;
      } else if (w.sha256 !== s.sha256) {
        w.state = 'superseded';
      } else if (w.sha256 !== null && w.sha256 === r.last_rejected?.sha256) {
        w.state = 'rejected';
        w.error = r.last_rejected?.error ?? r.error;
      } else {
        w.state = now - w.at > UNCONFIRMED_MS ? 'unconfirmed' : 'pending';
      }
    } else if (w && w.state === 'pending' && !r && now - w.at > UNCONFIRMED_MS) {
      w.state = 'unconfirmed';
    }

    s.sets = {
      enforced: enforced?.set ?? null,
      written: s.exists ? s.strict?.set ?? null : empty().set,
    };
    s.view = {
      path: s.loc.rulesPath,
      displayPath: toHostPath(s.loc.rulesPath),
      exists: s.exists,
      file: s.display.file,
      readError: s.display.error,
      mtimeMs: s.mtimeMs,
      sha256: s.sha256,
      invalid: s.invalid,
      enforcement,
      enforced: enforced?.file ?? null,
      control: controlStatus(controlRoot(s.loc), s.loc.rulesPath, this.controlEnabled()),
      write: w ? { ...w } : null,
      externalChange: s.externalChange,
    };
  }

  /** Read and settle; true when the view changed (the caller sends `net:rules`). */
  poll(loc: NetSessionLocation, status: StatusRecord | null, now: number): boolean {
    const s = this.session(loc);
    this.readDisk(s, now);
    this.settle(s, status, now);
    const sig = JSON.stringify({ ...s.view, sets: [s.sets.enforced !== null, s.sets.written !== null] });
    if (sig === s.viewSig) return false;
    s.viewSig = sig;
    return true;
  }

  /**
   * Apply one operation to a fresh read of rules.json and write the result by
   * glove's contract. Refuses — writing nothing — when control is unavailable,
   * when the file on disk is one the gate would reject (someone else's broken
   * write is theirs to fix, or to revert), or when the result would not validate.
   */
  apply(loc: NetSessionLocation, status: StatusRecord | null, op: RulesOp, opId: string, now: number): ApplyResult {
    const s = this.session(loc);
    const control = controlStatus(controlRoot(loc), loc.rulesPath, this.controlEnabled());
    if (control.state !== 'ok') return { ok: false, error: control.detail };

    this.readDisk(s, now, true);
    if (s.readError) return { ok: false, error: `Layman ${s.readError}` };
    const fail = (error: string): ApplyResult => {
      s.write = { opId, kind: op.kind, sha256: null, at: now, state: 'failed', error };
      this.settle(s, status, now);
      return { ok: false, error };
    };

    let bytes: Buffer | null;
    try {
      if (op.kind === 'revert') {
        const r = status?.rules;
        if (!r) return fail('the gate has not reported what it enforces');
        if (r.sha256 === null && r.source_mtime === null) bytes = null; // the gate enforces "no file"
        else {
          const known = r.sha256 ? s.cache.get(r.sha256) : undefined;
          if (!known) return fail('Layman has not seen the file the gate is enforcing, so it cannot put it back');
          bytes = known.bytes;
        }
      } else if (s.exists && s.invalid) {
        return fail(`rules.json is invalid (${s.invalid}). Fix it, or revert to the rules the gate enforces.`);
      } else if (op.kind === 'rewrite') {
        if (!s.bytes) return fail('there is no rules.json to write again');
        bytes = s.bytes;
      } else {
        const current = s.strict?.file ?? emptyRules(loc.env, loc.token);
        const next = applyOp(current, op, {
          env: loc.env, token: loc.token, now, currentSha256: s.sha256,
          newId: () => newRuleId(now, this.random),
        });
        bytes = serializeRules(next);
        // Never write what the gate would refuse.
        this.strict(loc, bytes);
      }
    } catch (e) {
      return fail(e instanceof RulesError ? e.message : `cannot apply: ${(e as Error).message}`);
    }

    try {
      if (bytes === null) removeRules(controlRoot(loc), loc.rulesPath);
      else writeRules(controlRoot(loc), loc.rulesPath, bytes);
    } catch (e) {
      return fail((e as Error).message);
    }
    const sha = bytes ? sha256(bytes) : null;
    if (bytes && sha) this.remember(s, sha, this.strict(loc, bytes));
    s.write = { opId, kind: op.kind, sha256: sha, at: now, state: 'pending', error: null };
    this.readDisk(s, now, true);
    this.settle(s, status, now);
    s.viewSig = '';
    return { ok: true, error: null };
  }
}

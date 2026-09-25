/**
 * The rules writer and its confirmation (plan §8.1 "RulesWriter"), against a
 * temp glove home and a hand-driven status.json standing in for the gate.
 * Confirmation is glove's hash rule: status.json `rules.sha256` /
 * `rules.last_rejected.sha256` against the bytes written.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NetObs } from './index.js';
import { TEMP_NAME, controlStatus, writeRules } from './writer.js';
import type { RulesOp, RulesView } from './types.js';

const TOKEN = 'pi-search';
const T0 = Date.parse('2026-09-25T12:00:00Z');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

let home: string;
let net: string;
let control: string;
let rulesPath: string;
let obs: NetObs;
let controlOn: boolean;

function status(rules: Record<string, unknown> | null) {
  writeFileSync(join(net, 'status.json'), JSON.stringify({
    v: 1, gate: '0.1.0', state: 'running', record: 'metadata', t: new Date(T0).toISOString(),
    rules: rules && { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0, sha256: null, last_rejected: null, ...rules },
  }));
}

/** What a gate reports after reading the file now on disk: accepted, or rejected. */
function gateReads(accept: boolean, error = 'unknown top-level keys') {
  const bytes = readFileSync(rulesPath);
  if (accept) status({ sha256: sha(bytes), source_mtime: 't', loaded_at: 't', active_count: 1 });
  else status({ ok: false, error, sha256: null, last_rejected: { checked_at: 't', source_mtime: 't', sha256: sha(bytes), error } });
}

const rules = (): RulesView => obs.store.rules(TOKEN)!;
const apply = (op: RulesOp, now = T0) => obs.applyRules(TOKEN, op, `op${Math.random()}`, now);
const onDisk = () => JSON.parse(readFileSync(rulesPath, 'utf8'));
const block = (host: string): RulesOp => ({ kind: 'blockHost', host, terminate: false });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'netobs-control-'));
  net = join(home, 'envs', TOKEN, 'sessions', TOKEN, 'net');
  control = join(home, 'control', TOKEN, TOKEN);
  rulesPath = join(control, 'rules.json');
  mkdirSync(net, { recursive: true });
  mkdirSync(control, { recursive: true });
  writeFileSync(join(net, 'flows.ndjson'), '');
  status({});
  controlOn = true;
  obs = new NetObs({ getSessionsDir: () => join(home, 'envs'), controlEnabled: () => controlOn });
  obs.poll(T0);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('writing rules.json', () => {
  it('writes atomically through a Layman-only temp name, 0600, owned like its directory, and leaves nothing behind', () => {
    expect(apply(block('arxiv.org'))).toEqual({ ok: true, error: null });
    expect(readdirSync(control)).toEqual(['rules.json']);
    const st = statSync(rulesPath);
    const dir = statSync(control);
    expect([st.mode & 0o777, st.uid, st.gid]).toEqual([0o600, dir.uid, dir.gid]);
    expect(onDisk()).toMatchObject({ v: 1, env: TOKEN, session: TOKEN, updated_by: 'layman', rules: [{ action: 'block', match: { host: 'arxiv.org' } }] });
  });

  it('a stale temp file from a crash is replaced, not appended to', () => {
    writeFileSync(join(control, TEMP_NAME), 'garbage from a crashed write');
    apply(block('arxiv.org'));
    expect(existsSync(join(control, TEMP_NAME))).toBe(false);
    expect(onDisk().rules).toHaveLength(1);
  });

  it('applies each op to a fresh read, so another writer’s rule survives', () => {
    apply(block('a.com'));
    const other = onDisk();
    other.rules.push({ id: 'r_cli', action: 'block', match: { host: 'cli.com' } });
    writeFileSync(rulesPath, JSON.stringify(other));
    apply(block('b.com'));
    expect(onDisk().rules.map((r: { match: { host: string } }) => r.match.host)).toEqual(['b.com', 'a.com', 'cli.com']);
  });

  it('never creates the control directory: no directory, no controls', () => {
    rmSync(join(home, 'control'), { recursive: true });
    obs.poll(T0);
    expect(rules().control.state).toBe('no-dir');
    expect(apply(block('arxiv.org')).ok).toBe(false);
    expect(existsSync(join(home, 'control'))).toBe(false);
  });

  it('refuses a control directory that is a symlink, and paths outside control/', () => {
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(control, { recursive: true });
    symlinkSync(elsewhere, control);
    expect(apply(block('arxiv.org')).ok).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const p of [join(home, 'control', '..', 'x', 'y', 'rules.json'), join(home, 'control', 'rules.json'), join(home, 'control', 'a', 'b', 'c', 'rules.json'), join(home, 'control', 'a', 'b', 'other.json')]) {
      expect(() => writeRules(join(home, 'control'), p, Buffer.from('{}')), p).toThrow(/refusing to write outside/);
    }
  });

  it('is read-only when switched off, with the reason', () => {
    controlOn = false;
    obs.poll(T0);
    expect(rules().control).toMatchObject({ state: 'disabled', detail: expect.stringContaining('Settings') });
    expect(apply(block('arxiv.org'))).toMatchObject({ ok: false, error: expect.stringContaining('Settings') });
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('refuses to clobber an invalid file someone else wrote, but can revert it', () => {
    writeFileSync(rulesPath, JSON.stringify({ v: 1, env: TOKEN, session: TOKEN, rules: [], exec: 'x' }));
    obs.poll(T0);
    expect(rules().invalid).toMatch(/unknown top-level keys/);
    const r = apply(block('arxiv.org'));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('rules.json is invalid') });
    expect(onDisk().exec).toBe('x'); // untouched
    // The gate enforces "no file" (no hash, no source mtime): reverting removes the broken file.
    expect(apply({ kind: 'revert' }).ok).toBe(true);
    expect(existsSync(rulesPath)).toBe(false);
  });

  it('refuses a file for another session as invalid', () => {
    writeFileSync(rulesPath, JSON.stringify({ v: 1, env: TOKEN, session: 'other', rules: [] }));
    obs.poll(T0);
    expect(rules().invalid).toMatch(/session: file is for 'other'/);
  });

  it('refuses a stale draft rather than overwriting a newer file', () => {
    apply(block('a.com'));
    const base = rules().sha256;
    writeFileSync(rulesPath, JSON.stringify({ ...onDisk(), default: 'block' }));
    obs.poll(T0 + 100);
    const r = apply({ kind: 'saveDraft', baseSha256: base, default: 'allow', rules: [] });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('changed since you started editing') });
    expect(onDisk().default).toBe('block');
  });

  it('cutAll / restoreAll round-trip', () => {
    apply(block('a.com'));
    apply({ kind: 'cutAll', keepLlm: true });
    expect(onDisk().default).toBe('block');
    expect(onDisk().rules).toHaveLength(5);
    apply({ kind: 'restoreAll' });
    expect(onDisk()).toMatchObject({ default: 'allow', rules: [{ match: { host: 'a.com' } }] });
  });
});

describe('confirmation by hash', () => {
  it('pending, then enforced once status.json names the written bytes', () => {
    apply(block('arxiv.org'));
    expect(rules().write).toMatchObject({ state: 'pending', sha256: sha(readFileSync(rulesPath)) });
    expect(rules().enforcement).toBe('pending');
    gateReads(true);
    obs.poll(T0 + 2000);
    expect(rules().write?.state).toBe('enforced');
    expect(rules().enforcement).toBe('enforced');
    expect(rules().enforced?.rules).toHaveLength(1);
  });

  it('rejected when last_rejected names them; the enforced set stays the previous one, and revert restores it', () => {
    apply(block('a.com'));
    gateReads(true);
    obs.poll(T0 + 1000);
    const first = rules().sha256!;
    // A second write the gate refuses (as it would if the port and the gate ever disagreed).
    apply(block('b.com'), T0 + 2000);
    const second = rules().sha256!;
    status({ ok: false, error: 'nope', sha256: first, source_mtime: 't', active_count: 1,
      last_rejected: { checked_at: 't', source_mtime: 't', sha256: second, error: 'nope' } });
    obs.poll(T0 + 3000);
    expect(rules().write).toMatchObject({ state: 'rejected', error: 'nope', sha256: second });
    expect(rules().enforcement).toBe('rejected');
    expect(rules().enforced?.rules.map((r) => r.match.host)).toEqual(['a.com']);
    // "Revert to enforced rules" writes back exactly the enforced bytes.
    expect(apply({ kind: 'revert' }, T0 + 4000).ok).toBe(true);
    expect(sha(readFileSync(rulesPath))).toBe(first);
  });

  it('unconfirmed after 10 s with no word from the gate', () => {
    apply(block('arxiv.org'));
    obs.poll(T0 + 5_000);
    expect(rules().write?.state).toBe('pending');
    obs.poll(T0 + 11_000);
    expect(rules().write?.state).toBe('unconfirmed');
    gateReads(true);
    obs.poll(T0 + 12_000);
    expect(rules().write?.state).toBe('enforced'); // late is still enforced
  });

  it('superseded when another writer replaces the file first, and flagged as an external change', () => {
    apply(block('arxiv.org'));
    writeFileSync(rulesPath, JSON.stringify({ v: 1, env: TOKEN, session: TOKEN, rules: [{ id: 'r_cli', action: 'block', match: { host: 'x.com' } }] }));
    obs.poll(T0 + 1000);
    expect(rules().write?.state).toBe('superseded');
    expect(rules().externalChange).toMatchObject({ at: T0 + 1000, sha256: sha(readFileSync(rulesPath)) });
  });

  it('Layman’s own writes are not external changes', () => {
    apply(block('arxiv.org'));
    obs.poll(T0 + 1000);
    expect(rules().externalChange).toBeNull();
  });

  it('"Try again" rewrites the current file through the ownership contract', () => {
    writeFileSync(rulesPath, JSON.stringify({ v: 1, env: TOKEN, session: TOKEN, rules: [] }));
    obs.poll(T0);
    status({ ok: false, error: 'cannot read rules.json: permission denied', last_rejected: { checked_at: 't', source_mtime: null, sha256: null, error: 'cannot read rules.json: permission denied' } });
    obs.poll(T0 + 1000);
    const before = readFileSync(rulesPath);
    expect(apply({ kind: 'rewrite' }, T0 + 2000).ok).toBe(true);
    expect(readFileSync(rulesPath).equals(before)).toBe(true);
    expect(statSync(rulesPath).mode & 0o777).toBe(0o600);
  });

  it('predicts each destination’s verdict under the enforced and the written rules', () => {
    writeFileSync(join(net, 'flows.ndjson'), JSON.stringify({
      v: 1, type: 'flow', phase: 'open', id: 'f_1', env: TOKEN, session: TOKEN, t: new Date(T0).toISOString(), t_open: new Date(T0).toISOString(),
      t_close: null, service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
      dest: { host: 'arxiv.org', port: 443, ip: '151.101.3.42', resolution: 'in-tunnel' }, scope: 'tunnelled',
      route: { kind: 'vpn', upstream: null }, bytes: { up: 1, down: 1 }, verdict: 'allow', rule: null, close_reason: null, request: null,
    }) + '\n');
    obs.poll(T0);
    const policy = () => obs.store.snapshot(TOKEN)!.destinations[0].policy;
    expect(policy()).toEqual({ enforced: { action: 'allow', rule: null }, written: { action: 'allow', rule: null } });
    apply({ kind: 'blockDomain', apex: 'arxiv.org', terminate: true });
    expect(policy().written).toMatchObject({ action: 'block', rule: expect.stringMatching(/-apex$/) });
    expect(policy().enforced).toEqual({ action: 'allow', rule: null }); // the gate has not taken it yet
    gateReads(true);
    obs.poll(T0 + 2000);
    expect(policy().enforced).toMatchObject({ action: 'block' });
  });

  it('controlStatus never writes a probe file', () => {
    controlStatus(join(home, 'control'), rulesPath, true);
    expect(readdirSync(control)).toEqual([]);
  });
});

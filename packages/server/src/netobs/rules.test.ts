import { describe, expect, it } from 'vitest';
import {
  CUT_PREFIX, RulesError, applyOp, emptyRules, evaluate, inNetwork, newRuleId, opRules, parseIp, parseNetwork,
  parseRulesBytes, serializeRules, validateRules, type ApplyContext, type FlowFacts,
} from './rules.js';
import type { RulesFile } from './types.js';

const base = { v: 1, env: 'pi-search', session: 'pi-search', default: 'allow', rules: [] as unknown[] };
const rule = (over: Record<string, unknown> = {}) => ({ id: 'r_1', action: 'block', match: { host: 'a.com' }, ...over });
const ok = (data: unknown, opts = {}) => expect(() => validateRules(data, opts)).not.toThrow();
const bad = (data: unknown, re: RegExp, opts = {}) => expect(() => validateRules(data, opts)).toThrow(re);

describe('validateRules: every rejection in policy.py', () => {
  it('accepts the handoff example and a minimal file', () => {
    ok({ v: 1, env: 'e', session: 's' });
    ok({ ...base, updated_at: 't', updated_by: 'layman', rules: [
      { id: 'r_01JBQ', action: 'block', match: { host: '*.doubleclick.net' }, terminate: false, note: 'ad tracker' },
      { id: 'r_01JBR', action: 'block', match: { ip: '203.0.113.0/24', port: 443 } },
      { id: 'r_01JBS', action: 'allow', match: { service: 'llm' } },
    ] });
  });
  it('top level must be an object', () => bad([], /top level must be an object/));
  it('unknown top-level key', () => bad({ ...base, exec: 1 }, /unknown top-level keys \['exec'\]/));
  it('v must be 1', () => { bad({ ...base, v: 2 }, /v: must be 1/); bad({ ...base, v: '1' }, /v: must be 1/); });
  it('env and session are required labels', () => {
    bad({ ...base, env: undefined }, /env: invalid value/);
    bad({ ...base, session: 'a b' }, /session: invalid value/);
  });
  it('env and session must match the gate', () => {
    bad(base, /env: file is for 'pi-search', this gate is 'x'/, { env: 'x' });
    bad(base, /session: file is for/, { session: 'pi-search-2' });
    ok(base, { env: 'pi-search', session: 'pi-search' });
  });
  it('updated_at / updated_by must be strings', () => bad({ ...base, updated_by: 5 }, /updated_by: must be a string/));
  it('default must be allow or block', () => { bad({ ...base, default: 'deny' }, /default: must be allow\|block/); bad({ ...base, default: null }, /default/); });
  it('rules must be an array, of objects', () => {
    bad({ ...base, rules: {} }, /rules: must be an array/);
    bad({ ...base, rules: [1] }, /rules\[0\]: must be an object/);
  });
  it('unknown rule key', () => bad({ ...base, rules: [rule({ why: 'x' })] }, /rules\[0\]: unknown keys \['why'\]/));
  it('rule id pattern', () => {
    bad({ ...base, rules: [rule({ id: 'x_1' })] }, /rules\[0\]\.id/);
    bad({ ...base, rules: [rule({ id: 'r_' })] }, /rules\[0\]\.id/);
    bad({ ...base, rules: [rule({ id: `r_${'a'.repeat(65)}` })] }, /rules\[0\]\.id/);
    bad({ ...base, rules: [rule({ id: 'r_1\n' })] }, /rules\[0\]\.id/);
  });
  it('duplicate ids', () => bad({ ...base, rules: [rule(), rule()] }, /duplicate rule id/));
  it('action', () => bad({ ...base, rules: [rule({ action: 'deny' })] }, /action: must be allow\|block/));
  it('terminate must be a boolean (an explicit null is not)', () => {
    bad({ ...base, rules: [rule({ terminate: 'yes' })] }, /terminate: must be a boolean/);
    bad({ ...base, rules: [rule({ terminate: null })] }, /terminate: must be a boolean/);
  });
  it('note at most 500 characters (code points), null allowed', () => {
    ok({ ...base, rules: [rule({ note: '😀'.repeat(500) })] });
    ok({ ...base, rules: [rule({ note: null })] });
    bad({ ...base, rules: [rule({ note: 'x'.repeat(501) })] }, /note: must be a string of at most 500/);
  });
  it('match must be a non-empty object with known keys', () => {
    bad({ ...base, rules: [rule({ match: {} })] }, /match: must be a non-empty object/);
    bad({ ...base, rules: [rule({ match: { path: '/' } })] }, /match: unknown keys \['path'\]/);
  });
  it('host glob charset, case-insensitive', () => {
    ok({ ...base, rules: [rule({ match: { host: '*.Example.COM' } })] });
    bad({ ...base, rules: [rule({ match: { host: 'a b' } })] }, /match\.host/);
    bad({ ...base, rules: [rule({ match: { host: '[ab].com' } })] }, /match\.host/);
    bad({ ...base, rules: [rule({ match: { host: 'x'.repeat(254) } })] }, /match\.host/);
  });
  it('ip literal or CIDR', () => {
    for (const ip of ['10.0.0.1', '10.0.0.0/8', '10.1.2.3/8', '::1', '2001:db8::/32', '10.0.0.0/255.0.0.0']) ok({ ...base, rules: [rule({ match: { ip } })] });
    for (const ip of ['10.0.0', '010.0.0.1', '10.0.0.0/33', 'example.com', '1::2::3']) bad({ ...base, rules: [rule({ match: { ip } })] }, /match\.ip/);
  });
  it('port integer or lo-hi, in range', () => {
    ok({ ...base, rules: [rule({ match: { port: 443 } })] });
    ok({ ...base, rules: [rule({ match: { port: '8000-8100' } })] });
    for (const port of [0, 65536, '9-1', true, '80', 1.5]) bad({ ...base, rules: [rule({ match: { port } })] }, /match\.port/);
  });
  it('service and tool are labels; scope is one of three', () => {
    bad({ ...base, rules: [rule({ match: { service: 'a/b' } })] }, /match\.service/);
    bad({ ...base, rules: [rule({ match: { tool: '' } })] }, /match\.tool/);
    bad({ ...base, rules: [rule({ match: { scope: 'lan' } })] }, /match\.scope: must be one of/);
  });
  it('at most 10,000 rules; at most 1 MiB', () => {
    bad({ ...base, rules: Array.from({ length: 10_001 }, (_, i) => rule({ id: `r_${i}` })) }, /at most 10000 rules/);
    expect(() => parseRulesBytes(Buffer.alloc(1024 * 1024 + 1, 32))).toThrow(/larger than/);
    expect(() => parseRulesBytes(Buffer.from('{'))).toThrow(/not valid JSON/);
  });
});

describe('IP parsing', () => {
  it('parses v4 and v6 like Python', () => {
    expect(parseIp('1.2.3.4')).toEqual({ version: 4, value: 0x01020304n });
    expect(parseIp('::')?.value).toBe(0n);
    expect(parseIp('::ffff:1.2.3.4')?.value).toBe(0xffff01020304n);
    expect(parseIp('1:2:3:4:5:6:7:8')?.value).toBe(0x00010002000300040005000600070008n);
    for (const s of ['1.2.3', '1.2.3.256', '01.2.3.4', ':1::', '1:2:3:4:5:6:7:8:9', 'g::', '1.2.3.4%1', 'fe80::1%', '::1%a%b']) expect(parseIp(s), s).toBeNull();
    // A scope id is accepted and ignored, as Python does.
    expect(parseIp('fe80::1%eth0')?.value).toBe(parseIp('fe80::1')?.value);
  });
  it('networks drop host bits and accept net/host masks', () => {
    expect(parseNetwork('10.1.2.3/8')).toMatchObject({ prefix: 8, base: 0x0a000000n });
    expect(parseNetwork('10.0.0.0/255.255.255.255')?.prefix).toBe(32);
    expect(parseNetwork('10.0.0.0/0.0.0.255')?.prefix).toBe(24);
    expect(parseNetwork('10.0.0.0/255.0.255.0')).toBeNull();
    expect(inNetwork(parseIp('10.9.9.9')!, parseNetwork('10.0.0.0/8')!)).toBe(true);
    expect(inNetwork(parseIp('::a09:909')!, parseNetwork('10.0.0.0/8')!)).toBe(false);
  });
});

describe('evaluate: first match wins, else the default', () => {
  const set = validateRules({ ...base, default: 'block', rules: [
    { id: 'r_llm', action: 'allow', match: { service: 'llm' } },
    { id: 'r_ads', action: 'block', match: { host: '*.tracker.example' }, terminate: true },
    { id: 'r_wiki', action: 'allow', match: { host: '*wikipedia.org', port: '1-1024' } },
    { id: 'r_net', action: 'allow', match: { ip: '151.101.0.0/16' } },
  ] });
  const f = (over: Partial<FlowFacts>): FlowFacts => ({ host: null, ip: null, port: 443, service: 'proxy', tool: 'web_fetch', scope: 'tunnelled', ...over });
  it('matches', () => {
    expect(evaluate(set, f({ service: 'llm' }))).toEqual({ action: 'allow', rule: 'r_llm', terminate: false });
    expect(evaluate(set, f({ host: 'ADS.Tracker.Example' }))).toEqual({ action: 'block', rule: 'r_ads', terminate: true });
    expect(evaluate(set, f({ host: 'tracker.example' })).rule).toBeNull(); // *. does not match the apex
    expect(evaluate(set, f({ host: 'en.wikipedia.org' })).rule).toBe('r_wiki');
    expect(evaluate(set, f({ host: 'en.wikipedia.org', port: 8443 })).rule).toBeNull();
    expect(evaluate(set, f({ host: 'arxiv.org', ip: '151.101.3.42' })).rule).toBe('r_net');
    expect(evaluate(set, f({ host: 'arxiv.org', ip: null }))).toEqual({ action: 'block', rule: null, terminate: false });
  });
});

describe('operations', () => {
  let n = 0;
  const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({
    env: 'pi-search', token: 'pi-search', now: Date.UTC(2026, 8, 25), newId: () => `r_id${++n}`, currentSha256: null, ...over,
  });
  const file = (): RulesFile => ({ ...emptyRules('pi-search', 'pi-search'), rules: [{ id: 'r_old', action: 'block', match: { host: 'old.com' } }] });
  const valid = (f: RulesFile) => validateRules(JSON.parse(serializeRules(f).toString()), { env: 'pi-search', session: 'pi-search' });

  it('puts new blocks on top, stamps the file, and stays valid', () => {
    const f = applyOp(file(), { kind: 'blockHost', host: 'ArXiv.org', terminate: true, note: 'x' }, ctx());
    expect(f.rules[0]).toMatchObject({ action: 'block', match: { host: 'arxiv.org' }, terminate: true, note: 'x' });
    expect(f.rules[1].id).toBe('r_old');
    expect(f).toMatchObject({ updated_by: 'layman', updated_at: '2026-09-25T00:00:00.000Z' });
    valid(f);
  });
  it('blocks a domain with two rules sharing a stem', () => {
    const f = applyOp(file(), { kind: 'blockDomain', apex: 'arxiv.org', terminate: false }, ctx());
    expect(f.rules.slice(0, 2).map((r) => [r.id.replace(/r_id\d+/, 'S'), r.match.host])).toEqual([['S-apex', 'arxiv.org'], ['S-sub', '*.arxiv.org']]);
    valid(f);
  });
  it('blocks a group with one rule', () => {
    const f = applyOp(file(), { kind: 'blockGroup', key: 'tool', value: 'search-engine-fanout', terminate: false }, ctx());
    expect(f.rules[0].match).toEqual({ tool: 'search-engine-fanout' });
  });
  it('removes rules, and refuses when none are left to remove', () => {
    expect(applyOp(file(), { kind: 'removeRule', ids: ['r_old'] }, ctx()).rules).toEqual([]);
    expect(() => applyOp(file(), { kind: 'removeRule', ids: ['r_gone'] }, ctx())).toThrow(RulesError);
  });
  it('cutAll and restoreAll round-trip, restoring the previous default', () => {
    const start = { ...file(), default: 'allow' as const };
    const cut = applyOp(start, { kind: 'cutAll', keepLlm: true }, ctx());
    expect(cut.default).toBe('block');
    expect(cut.rules.filter((r) => r.id.startsWith(CUT_PREFIX)).map((r) => [r.action, r.match])).toEqual([
      ['allow', { service: 'llm' }], ['block', { scope: 'tunnelled' }], ['block', { scope: 'direct' }], ['block', { scope: 'local' }],
    ]);
    valid(cut);
    expect(() => applyOp(cut, { kind: 'cutAll', keepLlm: false }, ctx())).toThrow(/already cut/);
    const back = applyOp(cut, { kind: 'restoreAll' }, ctx());
    expect({ default: back.default, rules: back.rules }).toEqual({ default: 'allow', rules: start.rules });
    expect(() => applyOp(back, { kind: 'restoreAll' }, ctx())).toThrow(/not cut/);
  });
  it('saves a draft only onto the file it was made from', () => {
    const op = { kind: 'saveDraft' as const, baseSha256: 'aaa', default: 'block' as const, rules: [] };
    expect(() => applyOp(file(), op, ctx({ currentSha256: 'bbb' }))).toThrow(/changed since you started/);
    expect(applyOp(file(), op, ctx({ currentSha256: 'aaa' }))).toMatchObject({ default: 'block', rules: [] });
  });
  it('mints ULID-like ids the gate accepts', () => {
    const id = newRuleId(Date.UTC(2026, 8, 25), (k) => new Uint8Array(k).fill(7));
    expect(id).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(opRules({ kind: 'allowHost', host: 'A.com' })).toEqual([{ action: 'allow', match: { host: 'a.com' } }]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  blockChoices, blockOp, checkMatchValue, controlDisabledReason, decidedBy, draftRuleId, groupTarget, isCut, isDirty,
  matchFor, moveRule, openToCut, previewRules, previewText, rebaseDraft, siblingIds, startDraft, toggleFor,
} from './net-rules.js';
import type { RulesOp } from './netobs-types.js';
// The server's own opRules, imported across packages in a test only: the preview must never drift from what is written.
import { opRules } from '../../../server/src/netobs/rules.js';
import { dest, rulesView } from './net-test-fixtures.js';

const allow = { action: 'allow' as const, rule: null };
const blockBy = (rule: string | null) => ({ action: 'block' as const, rule });

describe('toggleFor', () => {
  it('shows what the gate enforces, and pending while the file says otherwise', () => {
    expect(toggleFor(dest('a.com:443', { policy: { enforced: allow, written: allow } }))).toBe('allow');
    expect(toggleFor(dest('a.com:443', { policy: { enforced: blockBy('r_x'), written: blockBy('r_x') } }))).toBe('block');
    expect(toggleFor(dest('a.com:443', { policy: { enforced: blockBy(null), written: blockBy(null) } }))).toBe('default');
    expect(toggleFor(dest('a.com:443', { policy: { enforced: allow, written: blockBy('r_new') } }))).toBe('pending');
  });
  it('the guard and a host-less endpoint are locked whatever the rules say', () => {
    expect(toggleFor(dest('x:80', { state: 'guard', policy: { enforced: allow, written: allow } }))).toBe('locked');
    expect(toggleFor(dest('@proxy', { flags: { scope: 'local', unresolved: false, noHost: true, cleartext: false, fanout: false } }))).toBe('locked');
  });
  it('falls back to the observed state when the enforced set is unknown', () => {
    expect(toggleFor(dest('a.com:443', { state: 'user_rule' }))).toBe('block');
    expect(toggleFor(dest('a.com:443', { state: 'default_block' }))).toBe('default');
    expect(toggleFor(dest('a.com:443'))).toBe('allow');
  });
});

describe('controlDisabledReason', () => {
  it('explains why toggles cannot act', () => {
    expect(controlDisabledReason(rulesView())).toBeNull();
    expect(controlDisabledReason(rulesView({ control: { state: 'read-only', detail: 'mounted read-only' } }))).toBe('mounted read-only');
    expect(controlDisabledReason(rulesView({ invalid: 'bad key' }))).toMatch(/rules.json is invalid \(bad key\)/);
    expect(controlDisabledReason(rulesView({ write: { opId: 'o', kind: 'blockHost', sha256: 's', at: 1, state: 'pending', error: null } }))).toMatch(/Waiting/);
  });
});

describe('block choices and operations', () => {
  const arxiv = dest('arxiv.org:443', { groupKey: 'arxiv.org', ips: ['151.101.3.42'] });
  it('offers host, domain and IP, with the CDN warning on the IP', () => {
    expect(blockChoices(arxiv).map((c) => [c.scope, c.detail, !!c.warning])).toEqual([
      ['host', 'host arxiv.org', false],
      ['domain', 'host arxiv.org + host *.arxiv.org (2 rules)', false],
      ['ip', 'ip 151.101.3.42', true],
    ]);
    // An IP-literal destination has neither a domain nor a separate IP choice.
    expect(blockChoices(dest('10.0.0.1:443', { groupKey: '10.0.0.1', ips: ['10.0.0.1'] })).map((c) => c.scope)).toEqual(['host']);
  });
  it('builds the op for each choice', () => {
    expect(blockOp(arxiv, 'domain', true, ' ads ')).toEqual({ kind: 'blockDomain', apex: 'arxiv.org', terminate: true, note: 'ads' });
    expect(blockOp(arxiv, 'ip', false, '')).toEqual({ kind: 'blockIp', ip: '151.101.3.42', terminate: false, note: undefined });
  });
  it('maps groups to one rule', () => {
    expect(groupTarget('@fanout', 'Search fan-out')).toMatchObject({ key: 'tool', value: 'search-engine-fanout' });
    expect(groupTarget('@local', 'Local links')).toMatchObject({ key: 'scope', value: 'local', warning: expect.stringContaining('LLM') });
    expect(groupTarget('route:VPN', 'VPN')).toMatchObject({ key: 'scope', value: 'tunnelled', label: 'Everything tunnelled' });
    expect(groupTarget('tool:web_fetch', 'web_fetch')).toMatchObject({ key: 'tool', value: 'web_fetch' });
    expect(groupTarget('domain:arxiv.org', 'arxiv.org')).toBeNull();
    expect(groupTarget('@guard', 'Refused')).toBeNull();
  });
});

describe('previewRules mirrors the server', () => {
  const ops: RulesOp[] = [
    { kind: 'blockHost', host: 'ArXiv.org', terminate: true, note: 'n' },
    { kind: 'blockDomain', apex: 'arxiv.org', terminate: false },
    { kind: 'blockIp', ip: '151.101.3.42', terminate: true },
    { kind: 'blockGroup', key: 'tool', value: 'search-engine-fanout', terminate: false },
    { kind: 'allowHost', host: 'a.com' },
    { kind: 'allowDomain', apex: 'a.com', note: 'x' },
    { kind: 'cutAll', keepLlm: true },
    { kind: 'cutAll', keepLlm: false },
    { kind: 'setDefault', default: 'block' },
  ];
  it.each(ops.map((op) => [op.kind, op]))('%s', (_, op) => {
    expect(previewRules(op as RulesOp)).toEqual(opRules(op as RulesOp));
  });
  it('prints one rule per line', () => {
    expect(previewText({ kind: 'blockDomain', apex: 'arxiv.org', terminate: true }).split('\n')).toHaveLength(2);
  });
});

describe('rules in the file', () => {
  const rules = [
    { id: 'r_S-apex', action: 'block' as const, match: { host: 'a.com' } },
    { id: 'r_S-sub', action: 'block' as const, match: { host: '*.a.com' } },
    { id: 'r_x', action: 'block' as const, match: { host: 'x.com' } },
  ];
  it('finds the other rule of a domain pair', () => {
    expect(siblingIds('r_S-sub', rules)).toEqual(['r_S-apex', 'r_S-sub']);
    expect(siblingIds('r_x', rules)).toEqual(['r_x']);
  });
  it('lists what a rule decides now', () => {
    const ds = [dest('a.com:443', { policy: { enforced: blockBy('r_S-apex'), written: null } }), dest('b.com:443', { policy: { enforced: allow, written: null } })];
    expect(decidedBy(['r_S-apex', 'r_S-sub'], ds).map((d) => d.key)).toEqual(['a.com:443']);
  });
  it('detects the kill switch and counts what it would cut', () => {
    expect(isCut({ v: 1, env: 'e', session: 'e', default: 'block', rules: [{ id: 'r_layman_cut_X_0', action: 'block', match: { scope: 'local' } }] })).toBe(true);
    expect(isCut({ v: 1, env: 'e', session: 'e', default: 'allow', rules })).toBe(false);
    const ds = [dest('llm:8080', { services: ['llm'], openFlows: 1 }), dest('a.com:443', { services: ['proxy'], openFlows: 3 })];
    expect([openToCut(ds, true), openToCut(ds, false)]).toEqual([3, 4]);
  });
});

describe('the draft', () => {
  const view = (rules: Array<{ id: string; host: string }>, sha: string, def: 'allow' | 'block' = 'allow') => rulesView({
    sha256: sha, file: { v: 1, env: 'e', session: 'e', default: def, rules: rules.map((r) => ({ id: r.id, action: 'block', match: { host: r.host } })) },
  });

  it('is dirty once edited, and moves rules', () => {
    const d = startDraft(view([{ id: 'r_a', host: 'a' }, { id: 'r_b', host: 'b' }], 's1'));
    expect(isDirty(d)).toBe(false);
    const moved = { ...d, rules: moveRule(d.rules, 'r_b', 'r_a') };
    expect(moved.rules.map((r) => r.id)).toEqual(['r_b', 'r_a']);
    expect(isDirty(moved)).toBe(true);
  });

  it('rebases onto a changed file: keeps additions on top and deletions, takes the rest from the file', () => {
    const d0 = startDraft(view([{ id: 'r_a', host: 'a' }, { id: 'r_b', host: 'b' }], 's1'));
    const d = { ...d0, rules: [{ id: 'r_new', action: 'block' as const, match: { host: 'new' } }, d0.rules[1]], default: 'block' as const }; // added r_new, deleted r_a
    const next = view([{ id: 'r_a', host: 'a' }, { id: 'r_b', host: 'b' }, { id: 'r_cli', host: 'cli' }], 's2');
    const r = rebaseDraft(d, next);
    expect(r.base).toBe('s2');
    expect(r.rules.map((x) => x.id)).toEqual(['r_new', 'r_b', 'r_cli']);
    expect(r.default).toBe('block');
    // An unchanged default follows the file.
    expect(rebaseDraft(d0, view([], 's3', 'block')).default).toBe('block');
  });

  it('mints ids the gate accepts, never reusing one', () => {
    const a = draftRuleId(1_000, new Set());
    expect(a).toMatch(/^r_[0-9A-Za-z_-]{1,64}$/);
    expect(draftRuleId(1_000, new Set([a]))).not.toBe(a);
  });

  it('checks form values and builds matches', () => {
    expect(checkMatchValue('host', '*.ads.example')).toBeNull();
    expect(checkMatchValue('host', 'a b')).toMatch(/Hosts use/);
    expect(checkMatchValue('port', '8000-8100')).toBeNull();
    expect(checkMatchValue('scope', 'lan')).toMatch(/One of/);
    expect(matchFor('port', '443')).toEqual({ port: 443 });
    expect(matchFor('port', '1-2')).toEqual({ port: '1-2' });
  });
});

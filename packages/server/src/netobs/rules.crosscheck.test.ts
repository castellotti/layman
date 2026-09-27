/**
 * The rules validator and evaluator exist twice: glove's `glove/netgate/policy.py`
 * (what the gate runs) and the port in `rules.ts` (what Layman refuses to write
 * past). This feeds one corpus to both and requires the same verdict for every
 * file and the same matching rule for every flow. Also runs `glove net validate`
 * itself once, on a file Layman wrote, since that is the documented entry point.
 * Skipped when glove or `uv` is not beside the repo.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { applyOp, emptyRules, evaluate, GUARD_RULE, guardRefuses, parseRulesBytes, predict, serializeRules, type FlowFacts } from './rules.js';

const GLOVE = join(dirname(fileURLToPath(import.meta.url)), '../../../../../glove');

function available(): boolean {
  if (!existsSync(join(GLOVE, 'glove', 'netgate', 'policy.py'))) return false;
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const python = (script: string, input: unknown): unknown =>
  JSON.parse(execFileSync('uv', ['run', '--quiet', '--project', GLOVE, 'python', '-c', script], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }));

const ENV = 'pi-search';
const base = { v: 1, env: ENV, session: ENV, default: 'allow' };
const r = (match: unknown, over: Record<string, unknown> = {}) => ({ id: 'r_a', action: 'block', match, ...over });
const file = (...rules: unknown[]) => ({ ...base, rules });

/** Files that probe every rule of the schema, valid and not. */
const CORPUS: unknown[] = [
  base, { v: 1, env: ENV, session: ENV }, file(), [], 'x', null,
  { ...base, v: 2 }, { ...base, v: true }, { ...base, v: '1' }, { ...base, v: 1.0 }, { ...base, extra: 1 },
  { ...base, env: 'other' }, { ...base, session: 'pi-search-x' }, { ...base, env: 5 }, { ...base, session: '' },
  { ...base, updated_at: 1 }, { ...base, updated_by: 'layman', updated_at: 'now' },
  { ...base, default: 'block' }, { ...base, default: 'deny' }, { ...base, default: null },
  { ...base, rules: null }, { ...base, rules: {} }, file(1), file([]),
  file(r({ host: 'a.com' })), file(r({ host: 'A.COM' })), file(r({ host: '*.a.com' })), file(r({ host: 'a?.com' })),
  file(r({ host: 'a b' })), file(r({ host: '' })), file(r({ host: 'x'.repeat(253) })), file(r({ host: 'x'.repeat(254) })),
  file(r({ host: 'é.com' })), file(r({ host: 5 })), file(r({ host: '[a]' })),
  file(r({ ip: '10.0.0.1' })), file(r({ ip: '10.0.0.0/8' })), file(r({ ip: '10.1.2.3/8' })), file(r({ ip: '10.0.0.0/08' })),
  file(r({ ip: '10.0.0.0/33' })), file(r({ ip: '10.0.0.0/255.0.0.0' })), file(r({ ip: '10.0.0.0/0.0.0.255' })),
  file(r({ ip: '10.0.0.0/255.0.255.0' })), file(r({ ip: '010.0.0.1' })), file(r({ ip: '10.0.0' })), file(r({ ip: '256.0.0.1' })),
  file(r({ ip: '::' })), file(r({ ip: '::1' })), file(r({ ip: '2001:db8::/32' })), file(r({ ip: '2001:db8::/129' })),
  file(r({ ip: '::ffff:1.2.3.4' })), file(r({ ip: '1:2:3:4:5:6:7:8' })), file(r({ ip: '1:2:3:4:5:6:7::' })),
  file(r({ ip: '1::2::3' })), file(r({ ip: ':1:2:3:4:5:6:7' })), file(r({ ip: '1:2:3:4:5:6:7:8:9' })),
  file(r({ ip: 'fe80::1%eth0' })), file(r({ ip: 'fe80::1%eth0/64' })), file(r({ ip: 'fe80::%1/64' })), file(r({ ip: '1.2.3.4%1' })),
  file(r({ ip: 'fe80::1%' })), file(r({ ip: '::1%a%b' })), file(r({ ip: 'fe80::1%eth0/255.0.0.0' })), file(r({ ip: '2001:db8::/255.0.0.0' })), file(r({ ip: 'example.com' })), file(r({ ip: 10 })),
  file(r({ ip: ' 10.0.0.1' })), file(r({ ip: '10.0.0.1/' })),
  file(r({ port: 443 })), file(r({ port: 0 })), file(r({ port: 65535 })), file(r({ port: 65536 })), file(r({ port: '1-2' })),
  file(r({ port: '2-1' })), file(r({ port: '80' })), file(r({ port: '001-00080' })), file(r({ port: '123456-1' })),
  file(r({ port: true })), file(r({ port: -1 })), file(r({ port: null })),
  file(r({ service: 'llm' })), file(r({ service: 'a/b' })), file(r({ tool: 'search-engine-fanout' })), file(r({ tool: 'x'.repeat(65) })),
  file(r({ scope: 'tunnelled' })), file(r({ scope: 'lan' })), file(r({ scope: null })),
  file(r({})), file(r(null)), file(r({ path: '/' })), file(r({ host: 'a.com', path: '/' })),
  file(r({ host: 'a.com' }, { id: 'x' })), file(r({ host: 'a.com' }, { id: 'r_' })), file(r({ host: 'a.com' }, { id: `r_${'a'.repeat(64)}` })),
  file(r({ host: 'a.com' }, { id: `r_${'a'.repeat(65)}` })), file(r({ host: 'a.com' }, { id: 'r_a\n' })), file(r({ host: 'a.com' }, { id: 5 })),
  file(r({ host: 'a.com' }, { action: 'deny' })), file(r({ host: 'a.com' }, { action: null })),
  file(r({ host: 'a.com' }, { terminate: true })), file(r({ host: 'a.com' }, { terminate: 'yes' })), file(r({ host: 'a.com' }, { terminate: null })),
  file(r({ host: 'a.com' }, { note: 'x'.repeat(500) })), file(r({ host: 'a.com' }, { note: 'x'.repeat(501) })),
  file(r({ host: 'a.com' }, { note: '😀'.repeat(500) })), file(r({ host: 'a.com' }, { note: null })), file(r({ host: 'a.com' }, { note: 5 })),
  file(r({ host: 'a.com' }, { why: 1 })), file(r({ host: 'a.com' }), r({ host: 'b.com' })),
  file(r({ host: 'a.com' }), r({ host: 'b.com' }, { id: 'r_b' })),
];

const FACTS: FlowFacts[] = [
  { host: 'arxiv.org', ip: '151.101.3.42', port: 443, service: 'proxy', tool: 'web_fetch', scope: 'tunnelled' },
  { host: 'export.arxiv.org', ip: null, port: 443, service: 'proxy', tool: 'web_fetch', scope: 'tunnelled' },
  { host: 'ADS.Tracker.Example', ip: '104.16.99.12', port: 80, service: 'proxy', tool: 'web_fetch', scope: 'direct' },
  { host: 'llm.operator.lan', ip: null, port: 8080, service: 'llm', tool: 'llm', scope: 'local' },
  { host: null, ip: null, port: null, service: 'proxy', tool: null, scope: 'local' },
  { host: 'search.brave.com', ip: '2001:db8::5', port: 443, service: 'fanout', tool: 'search-engine-fanout', scope: 'tunnelled' },
  { host: '10.0.0.1', ip: '10.0.0.1', port: 22, service: 'proxy', tool: 'web_fetch', scope: 'local' },
  { host: 'fe80::5', ip: 'fe80::5%eth1', port: 443, service: 'proxy', tool: 'web_fetch', scope: 'local' },
];
const RULESETS = [
  { ...base, default: 'block', rules: [
    { id: 'r_1', action: 'allow', match: { service: 'llm' } },
    { id: 'r_2', action: 'block', match: { host: '*.tracker.example' }, terminate: true },
    { id: 'r_3', action: 'allow', match: { host: '*arxiv.org', port: '1-1024' } },
    { id: 'r_4', action: 'allow', match: { ip: '2001:db8::/32' } },
    { id: 'r_5', action: 'block', match: { ip: '10.0.0.0/255.0.0.0', scope: 'local' } },
    { id: 'r_6', action: 'block', match: { ip: 'fe80::%1/64' } },
  ] },
  { ...base, rules: [
    { id: 'r_1', action: 'block', match: { tool: 'search-engine-fanout' } },
    { id: 'r_2', action: 'block', match: { host: 'arxiv.org' } },
    { id: 'r_3', action: 'block', match: { scope: 'direct', port: 80 } },
    { id: 'r_4', action: 'block', match: { host: '?????.arxiv.org' } },
  ] },
];

/** Hosts (normalized, as glove records them) and in-tunnel answers for the built-in guard. */
const GUARD_HOSTS = [
  'arxiv.org', 'export.arxiv.org', 'gluetun', 'egress-proxy', 'localhost', 'a.localhost', 'printer.local',
  'db.internal', 'nas.lan', 'x.home', 'x.home.arpa', 'x.localdomain', 'x.intranet', 'x.corp', 'x.private',
  'local', 'internal.example.com', 'localhost.example.com',
  '169.254.169.254', '10.0.0.1', '172.16.5.4', '172.32.0.1', '192.168.1.1', '127.0.0.1', '0.0.0.0',
  '100.64.0.1', '100.128.0.1', '192.0.0.9', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7',
  '203.0.113.7', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '8.8.8.8', '151.101.3.42',
  '2130706433', '0x7f.1', '0177.0.0.1', '0x7f000001', '10.1', '8.8.2056', '1.2.3.4.5', '0x', '08.1.1.1', '999.1.1.1',
  '::1', '::', '[::1]', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12::1',
  '2001:db8::1', '2001:4860:4860::8888', '2606:4700::1111', 'ff02::1', '2002::1', '2001:1::1', '2001:3::1',
  '64:ff9b:1::1', '64:ff9b::808:808', '3fff::1',
];

const GUARD = `import json,sys
from glove.netgate.guard import check
print(json.dumps([check(h)[0] is not None for h in json.load(sys.stdin)]))`;

const VALIDATE = `import json,sys
from glove.netgate.policy import parse_bytes, PolicyError
out=[]
for s in json.load(sys.stdin):
    try:
        parse_bytes(s.encode(), env="${ENV}", session="${ENV}"); out.append(True)
    except PolicyError: out.append(False)
print(json.dumps(out))`;

const EVALUATE = `import json,sys
from glove.netgate.policy import validate
d=json.load(sys.stdin)
print(json.dumps([[list(validate(rs).evaluate(f)) for f in d["facts"]] for rs in d["sets"]]))`;

describe('rules cross-check against glove/netgate/policy.py', () => {
  const ready = available();

  it.skipIf(!ready)('accepts and rejects exactly the files glove does', () => {
    const texts = CORPUS.map((c) => JSON.stringify(c));
    const glove = python(VALIDATE, texts) as boolean[];
    const ours = texts.map((t) => {
      try {
        parseRulesBytes(Buffer.from(t), { env: ENV, session: ENV });
        return true;
      } catch {
        return false;
      }
    });
    const diffs = texts.flatMap((t, i) => (glove[i] === ours[i] ? [] : [`${t} → glove ${glove[i]}, layman ${ours[i]}`]));
    expect(diffs).toEqual([]);
    expect(glove.filter(Boolean).length).toBeGreaterThan(20); // the corpus exercises both outcomes
    expect(glove.filter((x) => !x).length).toBeGreaterThan(40);
  });

  it.skipIf(!ready)('evaluates flows to the same verdict and rule', () => {
    const glove = python(EVALUATE, { sets: RULESETS, facts: FACTS }) as Array<Array<[string, string | null, boolean]>>;
    const ours = RULESETS.map((rs) => {
      const { set } = parseRulesBytes(Buffer.from(JSON.stringify(rs)));
      return FACTS.map((f) => { const v = evaluate(set, f); return [v.action, v.rule, v.terminate]; });
    });
    expect(ours).toEqual(glove);
  });

  it.skipIf(!ready)('refuses exactly the hosts glove\'s built-in guard does', () => {
    const glove = python(GUARD, GUARD_HOSTS) as boolean[];
    const diffs = GUARD_HOSTS.flatMap((h, i) => (glove[i] === guardRefuses(h) ? [] : [`${h} → glove ${glove[i]}, layman ${!glove[i]}`]));
    expect(diffs).toEqual([]);
    expect(glove.filter(Boolean).length).toBeGreaterThan(20);
    expect(glove.filter((x) => !x).length).toBeGreaterThan(5);
  });

  // glove's gate (`forward.py`): the guard runs on the in-tunnel IP before any rule, so a host
  // whose in-tunnel answer is non-public is refused as the guard, never by the user's rule for it.
  it.skipIf(!ready)('predicts the guard, not a user rule, for a host that resolves in-tunnel to a non-public address', () => {
    const { set } = parseRulesBytes(Buffer.from(JSON.stringify(file(r({ host: 'rebind.example' }, { id: 'r_user' })))));
    const facts: FlowFacts = { host: 'rebind.example', ip: '203.0.113.7', port: 443, service: 'proxy', tool: 'web_fetch', scope: 'local' };
    expect(python(GUARD, ['203.0.113.7'])).toEqual([true]);
    expect(evaluate(set, facts).rule).toBe('r_user'); // the rules alone would name the user's rule
    expect(predict(set, facts, { proxy: true, resolution: 'in-tunnel' })).toMatchObject({ action: 'block', rule: GUARD_RULE });
    // Not an in-tunnel answer, or not a proxy listener: the guard does not run on the IP.
    expect(predict(set, facts, { proxy: true, resolution: 'unavailable' }).rule).toBe('r_user');
    expect(predict(set, facts, { proxy: false, resolution: 'in-tunnel' }).rule).toBe('r_user');
  });

  it.skipIf(!ready)('`glove net validate` accepts a file Layman wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-xcheck-'));
    try {
      let n = 0;
      const f = applyOp(emptyRules(ENV, ENV), { kind: 'blockDomain', apex: 'arxiv.org', terminate: true, note: 'check' },
        { env: ENV, token: ENV, now: Date.now(), newId: () => `r_X${++n}`, currentSha256: null });
      const path = join(dir, 'rules.json');
      writeFileSync(path, serializeRules(f));
      const out = JSON.parse(execFileSync('uv', ['run', '--quiet', '--project', GLOVE, 'glove', 'net', 'validate', path,
        '--env', ENV, '--session', ENV, '--json'], { encoding: 'utf8' }));
      expect(out).toMatchObject({ ok: true, active_count: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

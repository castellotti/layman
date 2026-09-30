/**
 * glove v3's grant states (`__scenarios_v3__/`, a copy of glove's
 * `tests/fixtures/netobs-v3/`), each a whole `~/.glove`, read through discovery
 * → store → rules control exactly as a live home is. The handoff's control
 * lifecycle is the fact asserted: controls only with the filter grant and its
 * directory, revocation remembered, orphans and not-observable sessions read-only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { NetObs } from './index.js';
import type { HistorySession, NetHistory } from './history.js';
import type { NetSessionSummary, RulesOp } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V3 = join(HERE, '__scenarios_v3__');
const GLOVE_V3 = join(HERE, '../../../../../glove/tests/fixtures/netobs-v3');
const NOW = Date.parse('2026-10-01T12:00:01.000Z');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'netobs-v3-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A writable copy of one scenario's glove home, with the `control/` glove always creates. */
function home(name: string): string {
  const h = join(root, name);
  cpSync(join(V3, name, 'home'), h, { recursive: true });
  mkdirSync(join(h, 'control'), { recursive: true });
  // The registry's session directories are host paths from glove's generator; give the
  // non-orphaned ones a real directory holding their id, as glove's would.
  const reg = JSON.parse(readFileSync(join(h, 'registry.json'), 'utf8')) as { v: 2; sessions: Array<{ id: string; dir: string }> };
  for (const row of reg.sessions) {
    row.dir = join(h, 'sessions', row.id);
    if (name === 'orphaned') continue;
    mkdirSync(join(row.dir, '.glove'), { recursive: true });
    writeFileSync(join(row.dir, '.glove', 'id'), `${row.id}\n`);
  }
  writeFileSync(join(h, 'registry.json'), JSON.stringify(reg));
  return h;
}

class MemHistory implements NetHistory {
  rows = new Map<string, HistorySession>();
  enabled(): boolean {
    return true;
  }
  load(): HistorySession[] {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  save(rows: HistorySession[]): void {
    for (const r of rows) this.rows.set(r.token, structuredClone(r));
  }
}

function open(h: string, history?: NetHistory): NetObs {
  const obs = new NetObs({ getGloveHome: () => h, history });
  obs.poll(NOW);
  return obs;
}
const summary = (obs: NetObs, id: string): NetSessionSummary => obs.sessions().find((s) => s.token === id)!;
const block: RulesOp = { kind: 'blockHost', host: 'arxiv.org', terminate: false };

describe('glove v3 grant states', () => {
  it('observe-only: flows and transcripts, no rule controls', () => {
    const obs = open(home('observe-only'));
    const id = 'observe-only-0f1a2b';
    expect(summary(obs, id)).toMatchObject({
      harness: 'pi', flows: 2,
      glove: { template: 'pi-search', filter: 'not-granted', transcripts: true, orphaned: false, notObservable: false },
    });
    expect(obs.store.rules(id)!.control).toMatchObject({ state: 'not-granted', detail: expect.stringContaining('filter: {}') });
    expect(obs.applyRules(id, block, 'op', NOW).ok).toBe(false);
    expect(readdirSync(join(root, 'observe-only', 'control'))).toEqual([]); // nothing created
  });

  it('observe-filter: controls enabled, the rules enforced by hash, and a write keeps env == session == id', () => {
    const h = home('observe-filter');
    const obs = open(h);
    const id = 'observe-filter-0f1a2b';
    expect(summary(obs, id).glove.filter).toBe('granted');
    const rules = obs.store.rules(id)!;
    expect(rules.control.state).toBe('ok');
    expect(rules.enforcement).toBe('enforced');
    expect(rules.invalid).toBeNull();
    expect(obs.applyRules(id, block, 'op', NOW)).toEqual({ ok: true, error: null });
    const written = JSON.parse(readFileSync(join(h, 'control', id, 'rules.json'), 'utf8'));
    expect([written.env, written.session]).toEqual([id, id]);
    expect(written.rules.map((r: { match: { host: string } }) => r.match.host)).toEqual(['arxiv.org', 'ads.example.com']);
    expect(statSync(join(h, 'control', id, 'rules.json')).mode & 0o777).toBe(0o644);
  });

  it('observe-filter, controls switched off in Settings: read-only', () => {
    const obs = new NetObs({ getGloveHome: () => home('observe-filter'), controlEnabled: () => false });
    obs.poll(NOW);
    expect(obs.store.rules('observe-filter-0f1a2b')!.control.state).toBe('disabled');
  });

  it('observe-no-transcripts: flows only', () => {
    const obs = open(home('observe-no-transcripts'));
    expect(summary(obs, 'observe-no-transcripts-0f1a2b').glove).toMatchObject({ transcripts: false, filter: 'not-granted' });
  });

  it('filter-revoked: indistinguishable from never granted to a Layman that never saw the grant', () => {
    const obs = open(home('filter-revoked'));
    expect(summary(obs, 'filter-revoked-0f1a2b').glove.filter).toBe('not-granted');
  });

  it('filter-revoked: revoked for a Layman that saw the grant, across a restart', () => {
    const history = new MemHistory();
    const id = 'filter-revoked-0f1a2b';
    const h = home('filter-revoked');
    const net = join(h, 'observe', id, 'net');
    const facts = readFileSync(join(net, 'session.json'), 'utf8');
    // Before: granted, with its control directory (as glove had it).
    const granted = JSON.parse(facts);
    granted.grants.filter = { granted: true, since: '2026-10-01T11:00:00.000Z' };
    writeFileSync(join(net, 'session.json'), JSON.stringify(granted));
    mkdirSync(join(h, 'control', id));
    const first = open(h, history);
    expect(first.store.rules(id)!.control.state).toBe('ok');
    first.persist();
    // glove up without `filter:`: the grant reads false again and control/<id>/ goes.
    writeFileSync(join(net, 'session.json'), facts);
    rmSync(join(h, 'control', id), { recursive: true });
    first.poll(NOW + 1000);
    expect(first.store.rules(id)!.control.state).toBe('revoked');
    // A restarted Layman still knows.
    const again = open(h, history);
    expect(summary(again, id).glove.filter).toBe('revoked');
    expect(again.store.rules(id)!.control).toMatchObject({ state: 'revoked', detail: expect.stringContaining('rules.revoked.json') });
    expect(again.applyRules(id, block, 'op', NOW).ok).toBe(false);
    expect(existsSync(join(h, 'control', id))).toBe(false);
  });

  it('filter re-granted: a new grant whose directory glove has not made yet is granted, not revoked', () => {
    const id = 'filter-revoked-0f1a2b';
    const h = home('filter-revoked');
    const net = join(h, 'observe', id, 'net');
    const facts = JSON.parse(readFileSync(join(net, 'session.json'), 'utf8'));
    const grant = (since: string) => {
      facts.grants.filter = { granted: true, since };
      writeFileSync(join(net, 'session.json'), JSON.stringify(facts));
    };
    grant('2026-10-01T11:00:00.000Z');
    mkdirSync(join(h, 'control', id));
    const obs = open(h);
    expect(obs.store.rules(id)!.control.state).toBe('ok');
    // The directory goes under the same grant: being revoked.
    rmSync(join(h, 'control', id), { recursive: true });
    obs.poll(NOW + 1000);
    expect(summary(obs, id).glove.filter).toBe('revoked');
    // glove up with `filter: {}` again: a new `since`, before glove makes control/<id>/.
    grant('2026-10-01T12:30:00.000Z');
    obs.poll(NOW + 2000);
    expect(summary(obs, id).glove.filter).toBe('granted');
    expect(obs.store.rules(id)!.control.state).toBe('no-dir');
    mkdirSync(join(h, 'control', id));
    obs.poll(NOW + 3000);
    expect(obs.store.rules(id)!.control.state).toBe('ok');
  });

  it('orphaned: session deleted, export retained, read-only history', () => {
    const obs = open(home('orphaned'));
    const id = 'orphaned-0f1a2b';
    expect(summary(obs, id)).toMatchObject({ flows: 2, glove: { orphaned: true } });
    expect(obs.store.rules(id)!.control).toMatchObject({ state: 'orphaned', detail: expect.stringContaining('glove gc') });
  });

  it('not-observable: listed greyed out, with no data and nothing looked for', () => {
    const obs = open(home('not-observable'));
    expect(obs.sessions()).toEqual([expect.objectContaining({
      token: 'not-observable-0f1a2b', harness: 'pi', flows: 0, live: false,
      glove: expect.objectContaining({ notObservable: true, template: 'pi-search' }),
    })]);
    expect(obs.store.snapshot('not-observable-0f1a2b')).toBeNull();
  });

  it('a glove v2 home is reported on the session list, not read', () => {
    const h = join(root, 'v2');
    mkdirSync(join(h, 'envs', 'pi-local', 'sessions', 'pi-local', 'net'), { recursive: true });
    writeFileSync(join(h, 'registry.json'), JSON.stringify([{ dir: '/w', harness: 'pi', env_id: 'pi-local' }]));
    const obs = open(h);
    expect(obs.sessions()).toEqual([]);
    expect(obs.registryView().state).toBe('v2-home');
  });
});

describe('corporate route', () => {
  it('a destination on a corporate route predicts "up to the allowlist", never the guard', () => {
    const h = home('observe-filter');
    const id = 'observe-filter-0f1a2b';
    const net = join(h, 'observe', id, 'net');
    const facts = JSON.parse(readFileSync(join(net, 'session.json'), 'utf8'));
    const proxy = facts.services.find((sv: { service: string }) => sv.service === 'proxy');
    proxy.route = { kind: 'corporate', upstream: 'http://glove-x-corporate-proxy:8888' };
    facts.upstream_kind = 'corporate';
    writeFileSync(join(net, 'session.json'), JSON.stringify(facts));
    const flow = (fid: string, host: string) => JSON.stringify({
      v: 1, type: 'flow', phase: 'close', id: fid, env: id, session: id, t: '2026-10-01T12:00:00.000Z', t_open: '2026-10-01T12:00:00.000Z',
      t_close: '2026-10-01T12:00:00.000Z', service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
      dest: { host, port: 443, ip: null, resolution: 'unavailable' }, scope: 'direct', route: proxy.route,
      bytes: { up: 1, down: 1 }, verdict: 'allow', rule: null, close_reason: 'eof', request: null, run: 'g_1',
    });
    writeFileSync(join(net, 'flows.ndjson'), [flow('f_1', 'wiki.corp'), flow('f_2', 'docs.example.com')].join('\n') + '\n');
    const obs = open(h);
    const policy = (host: string) => obs.store.snapshot(id)!.destinations.find((d) => d.host === host)!.policy.enforced;
    expect(policy('wiki.corp')).toEqual({ action: 'allow', rule: null, allowlist: true }); // not "refused by the guard"
    expect(policy('docs.example.com')).toEqual({ action: 'allow', rule: null, allowlist: true });
  });
});

describe('v3 fixture drift guard', () => {
  const files = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (f === '__pycache__' || f === 'COPIED.md' || f === '.DS_Store') continue;
        if (statSync(p).isDirectory()) walk(p);
        else out.push(relative(dir, p));
      }
    };
    walk(dir);
    return out.sort();
  };
  it.skipIf(!existsSync(GLOVE_V3))('the copy is byte-identical to ../glove/tests/fixtures/netobs-v3', () => {
    const theirs = files(GLOVE_V3);
    expect(files(V3)).toEqual(theirs);
    for (const f of theirs) expect(readFileSync(join(V3, f)).equals(readFileSync(join(GLOVE_V3, f))), f).toBe(true);
  });
});

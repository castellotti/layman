/**
 * glove's scenario fixtures: one real `net/`
 * directory per state the original fixture lacks, read through discovery → tail
 * → store exactly as a live session is. Each scenario's own README row is the
 * fact asserted.
 *
 * Every scenario is "stale" when read later, so each is read with "now" one
 * second after its status.json heartbeat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NetObs } from './index.js';
import type { FlowView, NetSnapshot, NetState } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = join(HERE, '__scenarios__');
const GLOVE_SCENARIOS = join(HERE, '../../../../../glove/tests/fixtures/netobs-scenarios');
const TOKEN = 'pi-search';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'netobs-scenario-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function load(name: string, nowOffsetMs = 1_000): NetSnapshot {
  const src = join(SCENARIOS, name);
  const net = join(home, 'envs', TOKEN, 'sessions', TOKEN, 'net');
  mkdirSync(net, { recursive: true });
  for (const f of readdirSync(src)) {
    if (f === 'rules.json') {
      const control = join(home, 'control', TOKEN, TOKEN);
      mkdirSync(control, { recursive: true });
      cpSync(join(src, f), join(control, f));
    } else {
      cpSync(join(src, f), join(net, f));
    }
  }
  const status = JSON.parse(readFileSync(join(src, 'status.json'), 'utf8')) as { t: string };
  const obs = new NetObs({ getSessionsDir: () => join(home, 'envs') });
  obs.poll(Date.parse(status.t) + nowOffsetMs);
  const snap = obs.store.snapshot(TOKEN);
  expect(snap).not.toBeNull();
  return snap!;
}

const states = (snap: NetSnapshot): Record<string, NetState> =>
  Object.fromEntries(snap.flows.map((f) => [f.dest.host ?? `@${f.service}:${f.closeReason}`, f.state]));
const flow = (snap: NetSnapshot, host: string | null): FlowView => {
  const f = snap.flows.find((x) => x.dest.host === host);
  expect(f, String(host)).toBeDefined();
  return f!;
};

describe('glove netobs scenarios', () => {
  it('default-block: an unmatched flow is blocked by the default, not by a rule', () => {
    const snap = load('default-block');
    expect(states(snap)).toEqual({ 'en.wikipedia.org': 'finished', 'arxiv.org': 'default_block' });
    expect(snap.totals.blocked).toEqual({ guard: 0, userRule: 0, default: 1 });
    expect(snap.rules.file?.default).toBe('block');
  });

  it('direct: an untunnelled flow is counted and flagged, and the guard refusal stays local', () => {
    const snap = load('direct');
    expect(flow(snap, 'en.wikipedia.org').flags.scope).toBe('direct');
    expect(flow(snap, '169.254.169.254').state).toBe('guard');
    expect(snap.totals.directFlows).toBe(1);
    expect(snap.gate.route).toMatchObject({ kind: 'direct', verified: false, exitIdentityOff: true });
  });

  it('rules-rejected: ok false, the enforced and the rejected hashes differ, and the good rule still blocks', () => {
    const snap = load('rules-rejected');
    const rules = snap.gate.rules!;
    expect(rules.ok).toBe(false);
    expect(rules.error).toMatch(/unknown top-level keys/);
    expect(rules.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rules.last_rejected?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rules.last_rejected?.sha256).not.toBe(rules.sha256);
    expect(flow(snap, 'ads.tracker.example').state).toBe('user_rule');
    // The file on disk is the rejected one: shown for what it is, not as enforced.
    expect(snap.rules.exists).toBe(true);
  });

  it('terminate: a rule that cut an established flow is the user rule, with the bytes it moved', () => {
    const snap = load('terminate');
    const f = flow(snap, 'arxiv.org');
    expect(f.state).toBe('user_rule');
    expect(f.rule).toBe('r_01M3SCENCUTARXIV0000000000');
    expect(f.bytes.down).toBe(114_727);
  });

  it('resolver-down: flows stay allowed but land in the unknown-location bucket', () => {
    const snap = load('resolver-down');
    expect(snap.gate.resolver.healthy).toBe(false);
    for (const f of snap.flows) {
      expect(f.state).toBe('finished');
      expect(f.flags.unresolved).toBe(true);
    }
  });

  it('telemetry-dropped: the view is marked incomplete and an orphaned close is still read', () => {
    const snap = load('telemetry-dropped');
    expect(snap.gate.telemetry?.dropped).toBe(4);
    // A flow whose close was lost looks open: after the idle threshold, pooled.
    expect(flow(snap, 'en.wikipedia.org').phase).not.toBe('close');
    expect(flow(snap, 'arxiv.org').state).toBe('finished');
    expect(flow(snap, 'www.nature.com').state).toBe('finished');
  });

  it('record-full: the record mode is reported and requests come through', () => {
    const snap = load('record-full');
    expect(snap.gate.record).toBe('full');
    const cleartext = flow(snap, 'example.org');
    expect(cleartext.request?.method).toBe('GET');
    expect(cleartext.request?.url).toMatch(/^http:\/\/example\.org/);
    expect(cleartext.flags.cleartext).toBe(true);
    expect(flow(snap, 'en.wikipedia.org').request).toMatchObject({ method: 'CONNECT', url: null });
  });

  it('exit-none: no exit.ndjson is expected, and the route is declared only', () => {
    const snap = load('exit-none');
    expect(snap.exit).toBeNull();
    expect(snap.gate.route).toMatchObject({ verified: false, exitIdentityOff: true });
    expect(snap.counters.gaps).toBe(0);
  });

  it('exit-unhealthy: the latest exit is unhealthy, so the route is no longer verified', () => {
    const snap = load('exit-unhealthy');
    expect(snap.exits.length).toBeGreaterThanOrEqual(2);
    expect(snap.exit?.healthy).toBe(false);
    expect(snap.gate.route.verified).toBe(false);
  });

  it('pooled: an open flow with no records for a while is pooled, not live', () => {
    const snap = load('pooled');
    const llm = flow(snap, 'llm.operator.lan');
    expect(llm.phase).toBe('update');
    expect(llm.state).toBe('pooled');
    expect(flow(snap, 'arxiv.org').state).toBe('finished');
    expect(snap.totals.openFlows).toBe(1);
  });

  it('sni-refined: the later SNI replaces the configured target, leaving no stale destination', () => {
    const snap = load('sni-refined');
    expect(snap.flows.map((f) => f.dest.host)).toEqual(['llm.operator.lan']);
    expect(snap.destinations.map((d) => d.host)).toEqual(['llm.operator.lan']);
  });

  it('rotation: a flow straddling rotated files, including a same-millisecond collision, is read once', () => {
    const snap = load('rotation');
    expect(snap.flows).toHaveLength(13);
    expect(snap.counters.gaps).toBe(0);
    expect(flow(snap, 'arxiv.org')).toMatchObject({ state: 'finished', bytes: { up: 1_571, down: 98_343 } });
  });

  it('empty: connections that sent nothing are folded, not shown as blocks', () => {
    const snap = load('empty');
    expect(snap.emptyFolded).toBe(2);
    expect(snap.flows.filter((f) => f.state === 'empty').every((f) => f.destKey === null)).toBe(true);
    expect(snap.destinations.map((d) => d.host)).toEqual(['en.wikipedia.org']);
    expect(snap.totals.blocked).toEqual({ guard: 0, userRule: 0, default: 0 });
  });

  it('search: the four engine flows are fan-out, the search flow is the harness', () => {
    const snap = load('search');
    const fanout = snap.flows.filter((f) => f.flags.fanout);
    expect(fanout.map((f) => f.dest.host).sort()).toEqual(
      ['api.qwant.com', 'html.duckduckgo.com', 'search.brave.com', 'www.mojeek.com'],
    );
    expect(flow(snap, 'searxng')).toMatchObject({ tool: 'web_search', flags: { fanout: false, scope: 'local' } });
  });

  it('stopped: a clean shutdown cuts the open download, and nothing is left open or inferred', () => {
    const snap = load('stopped');
    expect(snap.gate.freshness).toBe('stopped');
    expect(flow(snap, 'arxiv.org').state).toBe('gate_shutdown');
    expect(flow(snap, 'llm.operator.lan').state).toBe('finished');
    expect(snap.totals).toMatchObject({ openFlows: 0, gateLost: 0 });
  });

  it('gate-lost: an unclosed flow whose forwarder was declared dead is cut, inferred — not live', () => {
    const snap = load('gate-lost');
    const f = flow(snap, 'arxiv.org');
    expect(f.phase).toBe('update');
    expect(f.state).toBe('gate_lost');
    expect(snap.totals).toMatchObject({ openFlows: 0, gateLost: 1 });
    expect(snap.destinations[0]).toMatchObject({ openFlows: 0, state: 'gate_lost' });
    // gate records are understood, not counted as unknown types.
    expect(snap.counters.skipped).toBe(0);
  });
});

describe('scenario drift guard', () => {
  const available = existsSync(GLOVE_SCENARIOS);
  const walk = (root: string, dir = ''): string[] =>
    readdirSync(join(root, dir)).flatMap((f) => {
      const rel = join(dir, f);
      if (f.startsWith('.') || f === '__pycache__' || f === 'COPIED.md') return [];
      return statSync(join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
    });
  it.skipIf(!available)('the copy is byte-identical to ../glove/tests/fixtures/netobs-scenarios', () => {
    const theirs = walk(GLOVE_SCENARIOS).sort();
    expect(walk(SCENARIOS).sort()).toEqual(theirs);
    for (const f of theirs) {
      expect(readFileSync(join(SCENARIOS, f)).equals(readFileSync(join(GLOVE_SCENARIOS, f))), f).toBe(true);
    }
  });
});

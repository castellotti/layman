/**
 * glove's round-13 netobs-v3 scenarios (`llm-auth`, `llm-auth-oauth`, `github`, `ssh`,
 * `downloads`), read through discovery → store exactly as a live home is, and joined in
 * Trace to the calls their transcripts hold.
 *
 * glove's transcript times are illustrative (every line at T0), so each call is placed at the
 * time its flows imply; its tool name, input and result are the transcript's own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { TimelineEvent } from '../events/types.js';
import { callsFrom, correlate, downloadsOf } from './correlate.js';
import { NetObs } from './index.js';
import { applyOp, emptyRules, evaluate, validateRules } from './rules.js';
import { nextServices, type FlowView, type NetSnapshot, type RulesFile } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V3 = join(HERE, '__scenarios_v3__');
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const NOW = T0 + 60_000;

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'netobs-r13-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** One scenario's glove home, read as Layman reads a live one; its snapshot. */
function snapshot(name: string): NetSnapshot {
  const h = join(root, name);
  cpSync(join(V3, name, 'home'), h, { recursive: true });
  mkdirSync(join(h, 'control'), { recursive: true });
  const reg = JSON.parse(readFileSync(join(h, 'registry.json'), 'utf8')) as { sessions: Array<{ id: string; dir: string }> };
  for (const row of reg.sessions) {
    row.dir = join(h, 'sessions', row.id);
    mkdirSync(join(row.dir, '.glove'), { recursive: true });
    writeFileSync(join(row.dir, '.glove', 'id'), `${row.id}\n`);
  }
  writeFileSync(join(h, 'registry.json'), JSON.stringify(reg));
  const obs = new NetObs({ getGloveHome: () => h });
  obs.poll(NOW);
  return obs.store.snapshot(`${name}-0f1a2b`)!;
}

/** A Pi transcript's tool calls, in order: name and arguments. */
function piCalls(name: string): Array<{ name: string; input: Record<string, unknown> }> {
  const dir = join(V3, name, 'home', 'observe', `${name}-0f1a2b`, 'transcripts', '--work--');
  const lines = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return lines.flatMap((l) => (l.message?.content ?? []))
    .filter((c: { type: string }) => c.type === 'toolCall')
    .map((c: { name: string; arguments: Record<string, unknown> }) => ({ name: c.name, input: c.arguments }));
}

let n = 0;
function event(toolName: string, toolInput: Record<string, unknown>, start: number, end: number, toolOutput?: unknown): TimelineEvent {
  return {
    id: `ev${++n}`, type: 'tool_call_completed', timestamp: T0 + end + 1500, sessionId: 's1', agentType: 'pi',
    data: { toolName, toolInput, toolOutput, transcriptAt: T0 + start, transcriptCompletedAt: T0 + end },
  };
}

const flowsOf = (snap: NetSnapshot): FlowView[] => snap.flows;
const services = (snap: NetSnapshot) => snap.session!.services;
const byService = (snap: NetSnapshot, name: string) => services(snap).find((s) => s.service === name)!;
const sum = (fs: FlowView[], k: 'up' | 'down') => fs.reduce((a, f) => a + f.bytes[k], 0);

describe('llm-auth: each model call is a hop and a provider leg', () => {
  for (const name of ['llm-auth', 'llm-auth-oauth']) {
    it(`${name}: hops flagged and off the map, totals count the provider leg once, one Trace row per call`, () => {
      const snap = snapshot(name);
      expect(nextServices(byService(snap, 'llm'), services(snap)).map((s) => s.service)).toEqual(['llm-upstream']);
      const hops = flowsOf(snap).filter((f) => f.service === 'llm');
      const legs = flowsOf(snap).filter((f) => f.service === 'llm-upstream');
      expect(hops.map((f) => f.flags.hop)).toEqual([true, true]);
      expect(legs.map((f) => f.flags.hop)).toEqual([false, false]);
      // Each hop opens before and closes after the leg it caused: the fold's window holds it.
      for (const [hop, leg] of [[hops[0], legs[0]], [hops[1], legs[1]]] as const) {
        expect(hop.tOpen).toBeLessThan(leg.tOpen);
        expect(hop.tClose!).toBeGreaterThan(leg.tClose!);
      }
      expect(snap.totals.bytesDown).toBe(sum(legs, 'down'));
      expect(snap.totals.bytesUp).toBe(sum(legs, 'up'));

      // The provider leg is the destination that left; the hop is a local link, never placed.
      const provider = snap.destinations.find((d) => d.services.includes('llm-upstream'))!;
      const hopDest = snap.destinations.find((d) => d.services.includes('llm'))!;
      expect(provider).toMatchObject({ host: 'api.anthropic.com', port: 443 });
      expect(provider.flags.hop).toBe(false);
      expect([hopDest.flags.hop, hopDest.flags.unresolved, hopDest.geo]).toEqual([true, false, null]);
      // Under oauth the hop's dest is the provider's own name, at the sidecar's port: two destinations, not one.
      expect(hopDest.host).toBe(name === 'llm-auth' ? 'glove-llm-auth-0f1a2b-llm-auth' : 'api.anthropic.com');
      expect(hopDest.port).toBe(8080);
      expect(hopDest.key).not.toBe(provider.key);

      const { items, unattributed } = correlate({ calls: [], flows: flowsOf(snap), services: services(snap), from: T0 });
      const llm = items.filter((i) => i.kind === 'llm');
      expect(llm).toHaveLength(2);
      expect(unattributed).toEqual([]);
    });
  }
});

describe('github: the relay’s egress is claimed by the gh and git calls', () => {
  it('gh pr list claims api.github.com, git clone claims github.com', () => {
    const snap = snapshot('github');
    expect(byService(snap, 'github-egress')).toMatchObject({ harness: false, client: 'github', tool: 'gh', next: [] });
    const [gh, clone] = piCalls('github');
    expect([gh.input.command, clone.input.command]).toEqual(['gh pr list --repo octo-org/widgets', 'git clone https://github.com/octo-org/widgets']);
    const calls = callsFrom([event(gh.name, gh.input, 800, 2200), event(clone.name, clone.input, 2800, 5200)]);
    const { items, unattributed } = correlate({ calls, flows: flowsOf(snap), services: services(snap), from: T0 });
    const host = (id: string) => flowsOf(snap).find((f) => f.id === id)!.dest.host;
    const claimed = items.filter((i) => i.kind === 'call').map((i) => (i.kind === 'call' ? i.flowIds.map(host) : []));
    expect(claimed).toEqual([['api.github.com'], ['github.com']]);
    expect(unattributed).toEqual([]);
  });
});

describe('ssh: a LAN relay, and glove refusing a name that resolved public', () => {
  it('ssh-build is a LAN link; ssh-db is refused by glove, not by a rule; each call claims its gate', () => {
    const snap = snapshot('ssh');
    const build = snap.destinations.find((d) => d.services.includes('ssh-build'))!;
    const db = snap.destinations.find((d) => d.services.includes('ssh-db'))!;
    expect(build).toMatchObject({ scope: 'lan', state: 'finished' });
    expect(db).toMatchObject({ scope: 'lan', state: 'guard', rule: 'builtin:lan-only' });
    expect(db.ips).toEqual([]); // glove does not record the public address it refused

    const [up, refused] = piCalls('ssh');
    const calls = callsFrom([event(up.name, up.input, 800, 4200), event(refused.name, refused.input, 4800, 5200)]);
    const { items, unattributed } = correlate({ calls, flows: flowsOf(snap), services: services(snap), from: T0 });
    const svc = (id: string) => flowsOf(snap).find((f) => f.id === id)!.service;
    expect(items.filter((i) => i.kind === 'call').map((i) => (i.kind === 'call' ? i.flowIds.map(svc) : []))).toEqual([['ssh-build'], ['ssh-db']]);
    expect(unattributed).toEqual([]);
  });

  it('Cut all decides every ssh gate block (rules cannot name scope lan)', () => {
    const snap = snapshot('ssh');
    const id = 'ssh-0f1a2b';
    let i = 0;
    const cut = validateRules(applyOp(emptyRules(id, id), { kind: 'cutAll', keepLlm: true }, {
      env: id, token: id, now: NOW, newId: () => `r_${String(++i).padStart(26, '0')}`, currentSha256: null,
    }) as unknown as RulesFile);
    for (const f of flowsOf(snap)) {
      expect(evaluate(cut, { host: f.dest.host, ip: f.dest.ip, port: f.dest.port, service: f.service, tool: f.tool, scope: f.flags.scope }).action).toBe('block');
    }
  });
});

describe('downloads: the fetch and download hops, each with its egress', () => {
  it('every *-mcp hop goes on through its own egress; hops leave the totals', () => {
    const snap = snapshot('downloads');
    const next = (s: string) => nextServices(byService(snap, s), services(snap)).map((x) => x.service);
    expect([next('webfetch-mcp'), next('webdownload-mcp'), next('webfetch-egress')]).toEqual([['webfetch-egress'], ['webdownload-egress'], []]);
    const hops = flowsOf(snap).filter((f) => f.service.endsWith('-mcp'));
    const egress = flowsOf(snap).filter((f) => f.service.endsWith('-egress'));
    expect(hops.every((f) => f.flags.hop)).toBe(true);
    expect(egress.some((f) => f.flags.hop)).toBe(false);
    expect(snap.totals.bytesDown).toBe(sum(egress, 'down'));
    // The fetcher's own destination is a hop, never "unresolved", never on the map.
    const fetcher = snap.destinations.filter((d) => d.host === 'glove-downloads-0f1a2b-fetcher');
    expect(fetcher.map((d) => [d.flags.hop, d.flags.unresolved])).toEqual(fetcher.map(() => [true, false]));
  });

  it('Vibe’s fetch claims the fetch hop and egress, its download the download hop and egress, and its result lists the file', () => {
    const snap = snapshot('downloads');
    const dir = join(V3, 'downloads', 'home', 'observe', 'downloads-0f1a2b', 'transcripts');
    const lines = readFileSync(join(dir, readdirSync(dir)[0], 'messages.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const calls = lines.flatMap((l) => l.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
      id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments) as Record<string, unknown>,
      // What the Vibe watcher records as the output: the tool message's `content` (`vibe/watcher.ts`).
      output: lines.find((l) => l.role === 'tool' && l.tool_call_id === c.id)?.content as string,
    }));
    expect(calls.map((c) => c.name)).toEqual(['webfetch_fetch_url', 'webdownload_web_download']);
    const [fetch, dl] = calls;
    const evs = callsFrom([event(fetch.name, fetch.input, 900, 2200, fetch.output), event(dl.name, dl.input, 2900, 9200, dl.output)]);
    const { items, unattributed } = correlate({ calls: evs, flows: flowsOf(snap), services: services(snap), from: T0 });
    const svc = (id: string) => flowsOf(snap).find((f) => f.id === id)!.service;
    const claimed = items.filter((i) => i.kind === 'call').map((i) => (i.kind === 'call' ? i.flowIds.map(svc).sort() : []));
    expect(claimed).toEqual([['webfetch-egress', 'webfetch-mcp'], ['webdownload-egress', 'webdownload-mcp']]);
    expect(unattributed).toEqual([]);
    expect(downloadsOf(dl.output)).toMatchObject([{ path: '/work/downloads/data.tar.gz', bytes: 10485760, sha256: 'ab'.repeat(32) }]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { TimelineEvent } from '../events/types.js';
import { callsFrom, callTiming, correlate, flowRole, joinDistance, urlsOf, urlTarget } from './correlate.js';
import { parseLine, parseSessionFile } from './parse.js';
import { NetStore } from './store.js';
import type { FlowView, NetService, TraceCall } from './types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const SERVICES: NetService[] = parseSessionFile(JSON.parse(readFileSync(join(FIXTURE, 'session.json'), 'utf8')))!.services;

let n = 0;
/** A tool-call event, as the pi watcher records it when it kept the transcript's times. */
function call(toolName: string, toolInput: Record<string, unknown>, start: number, end: number | null, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: `ev${++n}`, type: end === null ? 'tool_call_pending' : 'tool_call_completed', timestamp: (end ?? start) + 1500, sessionId: 's1', agentType: 'pi',
    data: { toolName, toolInput, transcriptAt: start, ...(end !== null ? { transcriptCompletedAt: end } : {}) }, ...over,
  };
}

const FLAGS = { scope: 'tunnelled' as const, unresolved: false, noHost: false, cleartext: false, fanout: false };
function flow(id: string, host: string | null, tOpen: number, over: Partial<FlowView> = {}): FlowView {
  return {
    id, phase: 'close', tOpen, tClose: tOpen + 500, lastT: tOpen + 500, lastActivityAt: tOpen + 500, service: 'proxy', tool: 'web_fetch', client: 'harness',
    proto: 'http-connect', dest: { host, port: 443, ip: null, resolution: 'in-tunnel' }, scope: 'tunnelled', route: null, bytes: { up: 1, down: 1 },
    verdict: 'allow', rule: null, closeReason: 'eof', request: null, state: 'finished', flags: { ...FLAGS }, destKey: host ? `${host}:443` : '@proxy',
    groupKey: host ?? '@proxy', spark: [], ...over,
  };
}

const T = 1_000_000;
const join_ = (calls: TraceCall[], flows: FlowView[], from = T - 5000) => correlate({ calls, flows, services: SERVICES, from });
const claimedBy = (r: ReturnType<typeof correlate>) => Object.fromEntries(
  r.items.flatMap((i) => (i.kind === 'call' ? [[i.call.label, [...i.flowIds, ...i.fanoutIds]]] : [])),
);

describe('reading calls', () => {
  it('takes URLs from url-like arguments, a urls list, and shell commands', () => {
    expect(urlsOf({ url: 'https://arxiv.org/abs/1' })).toEqual(['https://arxiv.org/abs/1']);
    expect(urlsOf({ urls: ['https://a.example/', 42, 'not a url'] })).toEqual(['https://a.example/']);
    expect(urlsOf({ command: "curl -s 'https://api.github.com/repos/x' | jq . && wget http://example.org/f.txt" }))
      .toEqual(['https://api.github.com/repos/x', 'http://example.org/f.txt']);
    expect(urlsOf({ path: '/tmp/x' })).toEqual([]);
  });
  it('keeps a fetch whose URL the PII filter redacted, and joins nothing to it', () => {
    const cs = callsFrom([call('web_fetch', { url: 'http://[REDACTED]/latest/meta-data/' }, T, T + 100)]);
    expect(cs.map((c) => [c.kind, c.label, c.targets, c.redacted])).toEqual([['fetch', 'http://[REDACTED]/latest/meta-data/', [], true]]);
    const r = join_(cs, [flow('g', '169.254.169.254', T + 10)]);
    expect(r.unattributed).toEqual(['g']);
  });
  it('keeps a port only when the URL spells one out', () => {
    expect(urlTarget('http://gluetun:8000/v1/publicip/ip')).toEqual({ host: 'gluetun', port: 8000 });
    expect(urlTarget('https://EN.Wikipedia.org/wiki/X')).toEqual({ host: 'en.wikipedia.org', port: null });
    expect(urlTarget('http://[::1]:8080/')).toEqual({ host: '::1', port: 8080 });
    expect(urlTarget('ftp://x.example/')).toBeNull();
  });
  it('sorts calls into fetch, search and other', () => {
    const cs = callsFrom([
      call('web_search', { query: 'history of onion routing' }, T, T + 900),
      call('web_fetch', { url: 'https://arxiv.org/abs/2403.01234' }, T + 1000, T + 1800),
      call('Bash', { command: 'ls -la' }, T + 2000, T + 2100),
      { id: 'p', type: 'user_prompt', timestamp: T, sessionId: 's1', agentType: 'pi', data: { prompt: 'x' } },
    ]);
    expect(cs.map((c) => [c.kind, c.label])).toEqual([
      ['search', 'history of onion routing'], ['fetch', 'https://arxiv.org/abs/2403.01234'], ['other', 'ls -la'],
    ]);
  });
  it('trusts the transcript, then a hook, and otherwise only the read time', () => {
    expect(callTiming({ type: 'tool_call_completed', timestamp: 9000, data: { transcriptAt: 1000, transcriptCompletedAt: 2000, completedAt: 9000 } }))
      .toEqual({ start: 1000, end: 2000, timing: 'exact' });
    expect(callTiming({ type: 'tool_call_completed', timestamp: 1000, data: { completedAt: 2500 } })).toEqual({ start: 1000, end: 2500, timing: 'exact' });
    expect(callTiming({ type: 'tool_call_pending', timestamp: 1000, data: {} })).toEqual({ start: 1000, end: null, timing: 'exact' });
    // A passive watcher before transcript times were kept: both stamps are the read time.
    expect(callTiming({ type: 'tool_call_completed', timestamp: 9000, data: { completedAt: 8999 } })).toEqual({ start: 9000, end: 9000, timing: 'approximate' });
  });
});

describe('joining', () => {
  it('matches a flow to the call naming its host, inside the call window', () => {
    const cs = callsFrom([call('web_fetch', { url: 'https://arxiv.org/abs/1' }, T, T + 1000)]);
    const r = join_(cs, [flow('in', 'arxiv.org', T + 200), flow('early', 'arxiv.org', T - 1500), flow('late', 'arxiv.org', T + 3500), flow('other', 'example.org', T + 100)]);
    expect(claimedBy(r)).toEqual({ 'https://arxiv.org/abs/1': ['in'] });
    expect(r.unattributed).toEqual(['early', 'other', 'late']);
  });
  it('allows 1 s before the start and 2 s after the end', () => {
    expect(joinDistance({ start: T, end: T + 1000, timing: 'exact' }, T - 1000, 0)).toBe(1000);
    expect(joinDistance({ start: T, end: T + 1000, timing: 'exact' }, T - 1001, 0)).toBeNull();
    expect(joinDistance({ start: T, end: T + 1000, timing: 'exact' }, T + 3000, 0)).toBe(3000);
    expect(joinDistance({ start: T, end: T + 1000, timing: 'exact' }, T + 3001, 0)).toBeNull();
    expect(joinDistance({ start: T, end: null, timing: 'exact' }, T + 60_000, 0)).toBe(60_000);
  });
  it('matches host case-insensitively, and the port only when the URL gave one', () => {
    const cs = callsFrom([
      call('web_fetch', { url: 'http://gluetun:8000/v1/publicip/ip' }, T, T + 100),
      call('web_fetch', { url: 'https://EXAMPLE.org/' }, T, T + 100),
    ]);
    const r = join_(cs, [
      flow('g8000', 'gluetun', T, { dest: { host: 'gluetun', port: 8000, ip: null, resolution: 'disabled' } }),
      flow('g9000', 'gluetun', T, { dest: { host: 'gluetun', port: 9000, ip: null, resolution: 'disabled' } }),
      flow('ex', 'Example.ORG', T, { dest: { host: 'Example.ORG', port: 80, ip: null, resolution: 'in-tunnel' } }),
    ]);
    expect(claimedBy(r)).toEqual({ 'http://gluetun:8000/v1/publicip/ip': ['g8000'], 'https://EXAMPLE.org/': ['ex'] });
    expect(r.unattributed).toEqual(['g9000']);
  });
  it('gives a flow two calls could claim to the nearest start', () => {
    const cs = callsFrom([
      call('web_fetch', { url: 'https://arxiv.org/abs/1' }, T, T + 4000),
      call('web_fetch', { url: 'https://arxiv.org/pdf/1' }, T + 3000, T + 5000),
    ]);
    const r = join_(cs, [flow('a', 'arxiv.org', T + 100), flow('b', 'arxiv.org', T + 2900)]);
    expect(claimedBy(r)).toEqual({ 'https://arxiv.org/abs/1': ['a'], 'https://arxiv.org/pdf/1': ['b'] });
  });
  it('attaches the search service and SearXNG\'s fan-out to web_search', () => {
    const cs = callsFrom([call('web_search', { query: 'onion routing' }, T, T + 2000)]);
    const fan = (id: string, host: string) => flow(id, host, T + 400, { service: 'fanout', tool: 'search-engine-fanout', client: 'searxng', flags: { ...FLAGS, fanout: true } });
    const r = join_(cs, [
      flow('s', 'searxng', T + 50, { service: 'search', tool: 'web_search', scope: 'local' }),
      fan('f1', 'html.duckduckgo.com'), fan('f2', 'search.brave.com'),
      flow('f3', 'www.mojeek.com', T + 9000, { service: 'fanout', client: 'searxng', flags: { ...FLAGS, fanout: true } }),
    ]);
    const item = r.items.find((i) => i.kind === 'call')!;
    expect(item.kind === 'call' && [item.flowIds, item.fanoutIds]).toEqual([['s'], ['f1', 'f2']]);
    expect(r.unattributed).toEqual(['f3']);
  });
  it('makes LLM flows their own rows, in time order between the calls', () => {
    const cs = callsFrom([call('web_fetch', { url: 'https://arxiv.org/' }, T + 1000, T + 2000)]);
    const r = join_(cs, [
      flow('l1', 'llm.operator.lan', T, { service: 'llm', tool: 'llm', scope: 'local' }),
      flow('l2', 'llm.operator.lan', T + 2500, { service: 'llm', tool: 'llm', scope: 'local' }),
    ]);
    expect(r.items.map((i) => (i.kind === 'llm' ? i.flowId : i.call.label))).toEqual(['l1', 'https://arxiv.org/', 'l2']);
    expect(r.unattributed).toEqual([]);
  });
  it('keeps a call that made no traffic, and never guesses an owner for traffic no call names', () => {
    const cs = callsFrom([call('web_fetch', { url: 'https://nowhere.example/' }, T, T + 100), call('Bash', { command: 'make' }, T, T + 100)]);
    const r = join_(cs, [flow('x', 'example.org', T + 10), flow('m', null, T + 10)]);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((i) => i.kind === 'call' && i.flowIds.length === 0)).toBe(true);
    expect(r.unattributed).toEqual(['x', 'm']);
  });
  it('joins approximate calls by host after the turn began, the first read after the flow wins', () => {
    const approx = (url: string, readAt: number): TimelineEvent => ({
      id: `ev${++n}`, type: 'tool_call_completed', timestamp: readAt, sessionId: 's1', agentType: 'pi',
      data: { toolName: 'web_fetch', toolInput: { url }, completedAt: readAt },
    });
    const cs = callsFrom([approx('https://arxiv.org/abs/1', T + 4000), approx('https://arxiv.org/pdf/1', T + 9000)]);
    expect(cs.every((c) => c.timing === 'approximate')).toBe(true);
    const r = join_(cs, [flow('a', 'arxiv.org', T + 3000), flow('b', 'arxiv.org', T + 8000), flow('before', 'arxiv.org', T - 7000)], T);
    expect(claimedBy(r)).toEqual({ 'https://arxiv.org/abs/1': ['a'], 'https://arxiv.org/pdf/1': ['b'] });
    expect(r.unattributed).toEqual(['before']);
  });
  it('names a kept-alive connection a later call rode, without claiming it', () => {
    // As seen against a real gate: pi keeps its SearXNG connection open across searches, and SearXNG pools its engines'.
    const pooled = (id: string, host: string, tOpen: number, tClose: number | null) => flow(id, host, tOpen, {
      service: 'fanout', tool: 'search-engine-fanout', client: 'searxng', flags: { ...FLAGS, fanout: true }, tClose, lastT: tClose ?? tOpen + 900, phase: tClose ? 'close' : 'open',
    });
    const cs = callsFrom([
      call('web_search', { query: 'first' }, T + 2400, T + 5400),
      call('web_search', { query: 'second' }, T + 6000, T + 6500),
      call('web_fetch', { url: 'https://a.example/1' }, T + 7000, T + 8000),
      call('web_fetch', { url: 'https://a.example/2' }, T + 9000, T + 9500),
      call('web_search', { query: 'after it closed' }, T + 14_000, T + 14_500),
    ]);
    const flows = [
      flow('s', 'searxng', T + 2400, { service: 'search', tool: 'web_search', scope: 'local', tClose: T + 12_600, lastT: T + 12_600 }),
      pooled('e1', 'engine-one.example', T + 2450, null),
      pooled('e2', 'engine-two.example', T + 2460, T + 4000),
      flow('a', 'a.example', T + 7050, { tClose: T + 9600, lastT: T + 9600 }),
    ];
    // Opened in an earlier turn and still open: named, never claimed or unattributed.
    const earlier = [pooled('old', 'engine-three.example', T - 60_000, null)];
    const r = correlate({ calls: cs, flows, earlier, services: SERVICES, from: T });
    const open = Object.fromEntries(r.items.flatMap((i) => (i.kind === 'call' ? [[i.call.label, i.openIds]] : [])));
    expect(claimedBy(r)).toEqual({ first: ['s', 'e1', 'e2'], second: [], 'https://a.example/1': ['a'], 'https://a.example/2': [], 'after it closed': [] });
    expect(open).toEqual({
      first: ['old'], second: ['old', 's', 'e1'], 'https://a.example/1': [], 'https://a.example/2': ['a'], 'after it closed': ['old', 'e1'],
    });
    expect(r.unattributed).toEqual([]);
  });
  it('shares flows between calls that started together instead of giving the first all of them', () => {
    // Two parallel fetches of one host: one assistant message, one start time.
    const cs = callsFrom([
      call('web_fetch', { url: 'https://b.example/x' }, T + 1000, T + 2000),
      call('web_fetch', { url: 'https://b.example/y' }, T + 1000, T + 2000),
    ]);
    const r = join_(cs, [flow('b1', 'b.example', T + 1100), flow('b2', 'b.example', T + 1150)]);
    expect(claimedBy(r)).toEqual({ 'https://b.example/x': ['b1'], 'https://b.example/y': ['b2'] });
  });
  it('classifies flows from their own fields, falling back to the declared service', () => {
    expect(flowRole({ service: 'llm', tool: null, client: null, flags: FLAGS }, SERVICES)).toBe('llm');
    expect(flowRole({ service: 'search', tool: null, client: null, flags: FLAGS }, SERVICES)).toBe('search');
    expect(flowRole({ service: 'fanout', tool: null, client: 'searxng', flags: FLAGS }, SERVICES)).toBe('fanout');
    expect(flowRole({ service: 'proxy', tool: 'web_fetch', client: 'harness', flags: FLAGS }, SERVICES)).toBe('other');
  });
});

describe('the glove fixture', () => {
  // Every flow in the fixture, as NetStore sees it.
  const store = new NetStore();
  store.ensure({ token: 'pi-search', env: 'pi-search', name: 'pi-search', netDir: '/n', controlDir: '/c', rulesPath: '/c/rules.json' });
  for (const line of readFileSync(join(FIXTURE, 'flows.ndjson'), 'utf8').split('\n').filter(Boolean)) {
    const p = parseLine(line);
    if (p.kind === 'flow') store.ingestFlow('pi-search', p.record, Date.parse('2026-09-23T14:14:48Z'));
    else if (p.kind === 'gate') store.ingestGate('pi-search', p.record, Date.parse('2026-09-23T14:14:48Z'));
  }
  const flows = store.flows('pi-search', 0, 5000)!;
  const at = (s: string) => Date.parse(`2026-09-23T14:14:${s}Z`);
  // The design's turn: one search, then a fetch per host, the arxiv PDF three seconds later.
  const events = [
    call('web_search', { query: 'history of onion routing' }, at('43.300'), at('44.500')),
    ...['https://en.wikipedia.org/wiki/Onion_routing', 'https://arxiv.org/abs/2403.01234', 'https://www.nature.com/articles/x',
      'https://duckduckgo.com/html/?q=tor', 'http://example.org/', 'http://169.254.169.254/latest/meta-data/',
      'http://gluetun:8000/v1/publicip/ip', 'https://ads.tracker.example/p.gif']
      .map((url) => call('web_fetch', { url }, at('43.350'), at('45.000'))),
    call('web_fetch', { url: 'https://arxiv.org/pdf/2403.01234' }, at('46.400'), at('47.000')),
  ];
  const r = correlate({ calls: callsFrom(events), flows, services: SERVICES, from: at('43.000') });
  const host = (id: string) => flows.find((f) => f.id === id)!.dest.host;
  const byLabel = Object.fromEntries(r.items.flatMap((i) => (i.kind === 'call' ? [[i.call.label, [...i.flowIds, ...i.fanoutIds].map(host)]] : [])));

  it('joins each fetch to its host, including the guard refusals and the rule block', () => {
    expect(byLabel['https://en.wikipedia.org/wiki/Onion_routing']).toEqual(['en.wikipedia.org']);
    expect(byLabel['http://169.254.169.254/latest/meta-data/']).toEqual(['169.254.169.254']);
    expect(byLabel['http://gluetun:8000/v1/publicip/ip']).toEqual(['gluetun']);
    expect(byLabel['https://ads.tracker.example/p.gif']).toEqual(['ads.tracker.example']);
    expect(byLabel['https://duckduckgo.com/html/?q=tor']).toEqual(['duckduckgo.com']);
  });
  it('gives the two arxiv flows to the abstract and the PDF by nearest start', () => {
    expect(byLabel['https://arxiv.org/abs/2403.01234']).toEqual(['arxiv.org']);
    expect(byLabel['https://arxiv.org/pdf/2403.01234']).toEqual(['arxiv.org']);
  });
  it('attaches the four fan-out engines to the search', () => {
    expect(byLabel['history of onion routing']?.sort()).toEqual(['api.qwant.com', 'html.duckduckgo.com', 'search.brave.com', 'www.mojeek.com']);
  });
  it('makes the LLM flow a row, and leaves only the request with no destination unattributed', () => {
    expect(r.items.filter((i) => i.kind === 'llm')).toHaveLength(1);
    expect(r.unattributed.map(host)).toEqual([null]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NetObs } from '../netobs/index.js';
import { TEST_ID, addGloveSession } from '../netobs/testing/glove-home.js';
import type { TimelineEvent } from '../events/types.js';
import { registerStyxRoutes, type StyxDeps } from './routes.js';
import { MATRIX_MAX_ROWS, type MatrixRow } from './matrix.js';
import type { HostRow, LinkRow, LogRow } from './gibson.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'netobs', '__fixtures__');
/** The fixture's clock: its last record is a little before this. */
const NOW = Date.parse('2026-09-23T14:14:48.000Z');
/** Just after the fixture's glove flows (the Gibson tests that read them move the clock here). */
const LATE = Date.parse('2026-10-16T19:08:00.000Z');

const toolCall = (id: string, sessionId: string, toolName: string, toolInput: Record<string, unknown>, at: number): TimelineEvent => ({
  id, type: 'tool_call_completed', timestamp: at, sessionId, agentType: 'claude-code', data: { toolName, toolInput },
});

let home: string;
let godotDir: string;
let netObs: NetObs;
let app: FastifyInstance;
let enabled: boolean;
let clock: number;
let eventsCalls: number;
let memory: { events: TimelineEvent[]; since: number };
let recording: TimelineEvent[];
let sessions: Record<string, string | undefined>; // id → session name

function flowLine(id: string, host: string, scope: string, t: string, port = 443): string {
  return JSON.stringify({
    v: 1, type: 'flow', phase: 'open', id, env: 'pi-search', session: 'pi-search', t, t_open: t, t_close: null, service: 'proxy',
    tool: 'web_fetch', client: 'harness', proto: 'http-connect', dest: { host, port, ip: null, resolution: 'literal' }, scope,
    route: null, bytes: { up: 1, down: 2 }, verdict: 'allow', rule: null, close_reason: null, request: null,
  }) + '\n';
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'styx-routes-'));
  const { net } = addGloveSession(home, TEST_ID);
  for (const f of ['flows.ndjson', 'exit.ndjson', 'session.json', 'status.json']) copyFileSync(join(FIXTURE, f), join(net, f));
  // Two direct flows: one to a host the user listed as their VPN, one to a stranger.
  appendFileSync(join(net, 'flows.ndjson'), flowLine('f_vpn', 'wiki.corp.example', 'direct', '2026-09-23T14:14:46.000Z'));
  appendFileSync(join(net, 'flows.ndjson'), flowLine('f_leak', 'leak.example.net', 'direct', '2026-09-23T14:14:46.500Z'));
  netObs = new NetObs({ getGloveHome: () => home, getVpnDomains: () => ['corp.example'] });
  netObs.poll(NOW);

  godotDir = join(home, 'godot');
  mkdirSync(godotDir);
  enabled = true;
  clock = NOW;
  eventsCalls = 0;
  memory = { events: [], since: NOW + 1 };
  sessions = { 'sess-gloved': TEST_ID, 'sess-plain': undefined };
  recording = [
    toolCall('e1', 'sess-plain', 'WebFetch', { url: 'https://docs.example.com/a' }, NOW - 60_000),
    toolCall('e2', 'sess-plain', 'Bash', { command: 'curl -sI https://example.org/x' }, NOW - 30_000),
    toolCall('e3', 'sess-plain', 'WebFetch', { url: 'https://old.example.com/' }, NOW - 7_200_000),
  ];
  const deps: StyxDeps = {
    enabled: () => enabled,
    godotDir: () => godotDir,
    store: netObs.store,
    gloveTokenOf: (id) => {
      const name = sessions[id];
      return name && netObs.store.has(name) ? name : null;
    },
    sessionExists: (id) => id in sessions,
    events: () => {
      eventsCalls++;
      return recording;
    },
    memory: () => memory,
    liveStandardSessions: () => ['sess-plain'],
    now: () => clock,
  };
  app = Fastify();
  registerStyxRoutes(app, deps);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

const get = async (qs = '') => app.inject(`/api/styx/v1/matrix${qs}`);
const rows = async (qs = '') => (await get(qs)).json() as MatrixRow[];

describe('GET /api/styx/v1/matrix', () => {
  it('is 404 while Styx is off, and answers as soon as it is turned on', async () => {
    enabled = false;
    expect((await get()).statusCode).toBe(404);
    expect((await get(`?glove=${TEST_ID}`)).statusCode).toBe(404);
    enabled = true;
    expect((await get(`?glove=${TEST_ID}`)).statusCode).toBe(200);
  });

  it('refuses what the contract refuses', async () => {
    for (const qs of ['?session=sess-plain&glove=' + TEST_ID, '?relative=60', '?relative=0s', '?relative=1y', '?relative=', '?session=a&session=b']) {
      expect((await get(qs)).statusCode, qs).toBe(400);
    }
    for (const p of ['start_date', 'start_time', 'end_date', 'end_time', 'timezone', 'client']) {
      const res = await get(`?${p}=x`);
      expect(res.statusCode, p).toBe(400);
      expect(res.json().error).toBe(`${p} is not supported by Layman's Styx feed`);
    }
  });

  it('is 404 for an unknown session or glove id', async () => {
    expect((await get('?session=nope')).statusCode).toBe(404);
    expect((await get('?glove=nope')).statusCode).toBe(404);
  });

  it('gives a gloved session the same rows by session= and by glove=', async () => {
    const byGlove = await rows(`?glove=${TEST_ID}`);
    expect(byGlove.length).toBeGreaterThan(0);
    expect(await rows('?session=sess-gloved')).toEqual(byGlove);
    expect(await rows(`?glove=${TEST_ID}&relative=1h`)).toEqual(await rows('?session=sess-gloved&relative=1h'));
  });

  it('takes a glove id as session= (a glove before its first prompt; styx-godot forwards only session)', async () => {
    const byGlove = await rows(`?glove=${TEST_ID}`);
    expect(await rows(`?session=${TEST_ID}`)).toEqual(byGlove);
    for (const route of ['hosts', 'links']) {
      expect((await app.inject({ method: 'GET', url: `/api/styx/v1/${route}?session=${TEST_ID}` })).statusCode, route).toBe(200);
    }
  });

  it('a listed VPN host is not untunnelled; an unlisted direct host is', async () => {
    const all = await rows(`?glove=${TEST_ID}&relative=1h`);
    expect(all.find((r) => r.address === 'wiki.corp.example:443')).toMatchObject({ untunnelled: false });
    expect(all.find((r) => r.address === 'leak.example.net:443')).toMatchObject({ untunnelled: true });
    const totals = await rows(`?glove=${TEST_ID}`);
    expect(totals.find((r) => r.address === 'wiki.corp.example:443')).toMatchObject({ untunnelled: false });
    expect(totals.find((r) => r.address === 'leak.example.net:443')).toMatchObject({ untunnelled: true });
  });

  it('never lists a hop, by either route', async () => {
    const hops = netObs.store.destinations(TEST_ID).filter((d) => d.flags.hop && d.host).map((d) => d.host);
    for (const qs of [`?glove=${TEST_ID}`, `?glove=${TEST_ID}&relative=1d`]) {
      const addresses = (await rows(qs)).map((r) => r.address);
      for (const h of hops) expect(addresses.some((a) => a.startsWith(`${h}:`)), `${qs} ${h}`).toBe(false);
    }
  });

  it('counts the hosts a standard session named: a WebFetch and a curl, once per call', async () => {
    const r = await rows('?session=sess-plain');
    expect(r.map((x) => x.address).sort()).toEqual(['docs.example.com:443', 'example.org:443', 'old.example.com:443']);
    expect(r.every((x) => x.count === 1 && x.sent === 0 && x.received === 0 && x.blocked === 0 && !x.untunnelled)).toBe(true);
  });

  it('a window keeps only calls that started inside it', async () => {
    expect((await rows('?session=sess-plain&relative=1h')).map((x) => x.address).sort()).toEqual(['docs.example.com:443', 'example.org:443']);
    expect((await rows('?session=sess-plain&relative=45s')).map((x) => x.address)).toEqual(['example.org:443']);
  });

  it('with no selector, merges every live gloved session and every live standard one, in a 15 minute window', async () => {
    const r = await rows();
    const addresses = r.map((x) => x.address);
    expect(addresses).toContain('docs.example.com:443');
    expect(addresses).toContain('example.org:443');
    expect(addresses).not.toContain('old.example.com:443');
    expect(addresses).toContain('leak.example.net:443');
    const sorted = [...r].sort((a, b) => b.count - a.count || a.address.localeCompare(b.address));
    expect(r.map((x) => x.address)).toEqual(sorted.map((x) => x.address));
  });

  it('caps at the row limit', async () => {
    recording = Array.from({ length: MATRIX_MAX_ROWS + 20 }, (_, i) => toolCall(`c${i}`, 'sess-plain', 'WebFetch', { url: `https://h${i}.example.com/` }, NOW - 1000));
    expect(await rows('?session=sess-plain')).toHaveLength(MATRIX_MAX_ROWS);
  });
});

describe('what a poll costs', () => {
  it('a window that memory reaches back to never reads the recording', async () => {
    memory = { events: recording.filter((e) => e.timestamp > NOW - 3_600_000), since: NOW - 7_200_000 };
    for (let i = 0; i < 3; i++) await rows('?session=sess-plain&relative=1h');
    expect(eventsCalls).toBe(0);
  });

  it('a window before memory begins reads the recording once, and reuses it', async () => {
    await rows('?session=sess-plain&relative=1h');
    await rows('?session=sess-plain&relative=1h');
    expect(eventsCalls).toBe(1);
  });

  it('two whole-record requests read the recording once', async () => {
    await rows('?session=sess-plain');
    await rows('?session=sess-plain');
    expect(eventsCalls).toBe(1);
  });

  it('a host that arrives after the recording was read shows at once, not after the cache', async () => {
    await rows('?session=sess-plain&relative=1h');
    memory = { events: [toolCall('n1', 'sess-plain', 'Bash', { command: 'curl -sI https://fresh.example.net' }, NOW - 500)], since: NOW - 60_000 };
    expect((await rows('?session=sess-plain&relative=1h')).map((r) => r.address)).toContain('fresh.example.net:443');
  });

  it('a memory horizon that keeps moving (a full ring) does not make every poll read the recording', async () => {
    for (let i = 0; i < 4; i++) {
      memory = { events: [], since: NOW - 3_600_000 * 2 + i * 1000 };
      await rows('?session=sess-plain&relative=1d');
    }
    expect(eventsCalls).toBe(1);
  });

  it('an event both in memory and in the recording counts once', async () => {
    memory = { events: [recording[1]], since: NOW - 40_000 };
    const r = await rows('?session=sess-plain&relative=1h');
    expect(r.find((x) => x.address === 'example.org:443')?.count).toBe(1);
  });
});

describe('the Gibson feed', () => {
  const feed = async <T>(name: string, qs = ''): Promise<T[]> => (await app.inject(`/api/styx/v1/${name}${qs}`)).json() as T[];
  const ROUTES = ['hosts', 'links', 'flows'];
  const netFlows = (): string => join(home, 'observe', TEST_ID, 'net', 'flows.ndjson');

  it('is 404 while Styx is off, on every route', async () => {
    enabled = false;
    for (const r of ROUTES) expect((await app.inject(`/api/styx/v1/${r}`)).statusCode, r).toBe(404);
  });

  it('refuses what the Matrix feed refuses, on every route', async () => {
    for (const r of ROUTES) {
      for (const qs of [`?session=sess-plain&glove=${TEST_ID}`, '?relative=60', '?relative=1y', '?start_date=2026-01-01', '?client=10.0.0.2', '?session=a&session=b']) {
        expect((await app.inject(`/api/styx/v1/${r}${qs}`)).statusCode, `${r}${qs}`).toBe(400);
      }
      expect((await app.inject(`/api/styx/v1/${r}?session=nope`)).statusCode, r).toBe(404);
      expect((await app.inject(`/api/styx/v1/${r}?glove=nope`)).statusCode, r).toBe(404);
    }
  });

  it('refuses a bad limit or host on /flows only', async () => {
    for (const qs of ['?limit=0', '?limit=501', '?limit=x', '?limit=1.5', '?limit=', '?limit=1&limit=2', '?host=', '?host=a&host=b']) {
      expect((await app.inject(`/api/styx/v1/flows${qs}`)).statusCode, qs).toBe(400);
    }
    expect((await app.inject('/api/styx/v1/flows?limit=500')).statusCode).toBe(200);
    expect((await app.inject('/api/styx/v1/hosts?limit=0')).statusCode).toBe(200);
  });

  it("a gloved session's hosts hold the fixture's, with the ports of one host merged into one row", async () => {
    clock = LATE;
    appendFileSync(netFlows(), flowLine('f_wiki80', 'en.wikipedia.org', 'tunnelled', '2026-10-16T19:07:50.000Z', 80));
    netObs.poll(LATE);
    const hosts = await feed<HostRow>('hosts', `?glove=${TEST_ID}`);
    const wiki = hosts.filter((h) => h.host === 'en.wikipedia.org');
    expect(wiki).toHaveLength(1);
    expect(wiki[0]).toMatchObject({ block: 'wikipedia.org', ports: [80, 443] });
    expect(hosts.map((h) => h.host)).toEqual(expect.arrayContaining(['arxiv.org', 'ads.tracker.example', 'leak.example.net']));
    expect(hosts.find((h) => h.host === 'leak.example.net')).toMatchObject({ untunnelled: true });
    expect(hosts.find((h) => h.host === 'wiki.corp.example')).toMatchObject({ untunnelled: false });
    const sorted = [...hosts].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
    expect(hosts.map((h) => h.host)).toEqual(sorted.map((h) => h.host));
  });

  it('answers the same by session= and by glove=, and for the whole record too, with no hop in it', async () => {
    clock = LATE;
    for (const r of ROUTES) {
      for (const w of ['', '&relative=1d']) {
        expect(await feed(r, `?session=sess-gloved${w}`), `${r}${w}`).toEqual(await feed(r, `?glove=${TEST_ID}${w}`));
      }
    }
    const hops = netObs.store.destinations(TEST_ID).filter((d) => d.flags.hop && d.host).map((d) => d.host);
    for (const qs of [`?glove=${TEST_ID}`, `?glove=${TEST_ID}&relative=1d`]) {
      const names = [...(await feed<HostRow>('hosts', qs)).map((h) => h.host), ...(await feed<LinkRow>('links', qs)).map((l) => l.target)];
      for (const h of hops) expect(names, `${qs} ${h}`).not.toContain(h);
    }
  });

  it('links name who reached whom, and /flows?host= returns only that host and respects limit', async () => {
    clock = LATE;
    const links = await feed<LinkRow>('links', `?glove=${TEST_ID}`);
    expect(links.find((l) => l.target === 'arxiv.org')).toMatchObject({ source_kind: 'client', count: 2 });
    const all = await feed<LogRow>('flows', `?glove=${TEST_ID}`);
    expect(new Set(all.map((r) => r.host)).size).toBeGreaterThan(3);
    const arxiv = await feed<LogRow>('flows', `?glove=${TEST_ID}&host=ARXIV.org`);
    expect(arxiv).toHaveLength(2);
    expect(arxiv.every((r) => r.host === 'arxiv.org')).toBe(true);
    expect(await feed('flows', `?glove=${TEST_ID}&host=arxiv.org&limit=1`)).toHaveLength(1);
    expect(all.length).toBeLessThanOrEqual(100);
    const times = all.map((r) => r.time);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('a standard session is the agent, through each tool, to the hosts its calls named', async () => {
    const hosts = await feed<HostRow>('hosts', '?session=sess-plain');
    expect(hosts.map((h) => h.host).sort()).toEqual(['docs.example.com', 'example.org', 'old.example.com']);
    expect(hosts.find((h) => h.host === 'docs.example.com')).toMatchObject({ ports: [443], tools: ['WebFetch'], sent: 0, scope: '' });
    expect(await feed<LinkRow>('links', '?session=sess-plain&relative=1h')).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'agent', source_kind: 'agent', via: 'WebFetch', target: 'docs.example.com' }),
    ]));
    const log = await feed<LogRow>('flows', '?session=sess-plain&host=example.org');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: 'agent', state: 'finished', port: 443, proto: 'https' });
  });

  it('with no selector, merges every live gloved session and every live standard one, in a 15 minute window', async () => {
    appendFileSync(netFlows(), flowLine('f_ex80', 'example.org', 'tunnelled', '2026-09-23T14:14:47.000Z', 80));
    netObs.poll(NOW);
    const hosts = await feed<HostRow>('hosts');
    const names = hosts.map((h) => h.host);
    expect(names).toEqual(expect.arrayContaining(['docs.example.com', 'leak.example.net']));
    expect(names).not.toContain('old.example.com');
    // example.org is in glove's flows (port 80) and in the standard session's curl (443): one tower.
    expect(hosts.filter((h) => h.host === 'example.org')).toHaveLength(1);
    expect(hosts.find((h) => h.host === 'example.org')!.ports).toEqual([80, 443]);
    const links = await feed<LinkRow>('links');
    expect(links.some((l) => l.source_kind === 'agent')).toBe(true);
    expect(links.some((l) => l.source_kind === 'client')).toBe(true);
  });

  it('caps hosts and links', async () => {
    recording = Array.from({ length: 600 }, (_, i) => toolCall(`c${i}`, 'sess-plain', 'WebFetch', { url: `https://h${i}.example.com/` }, NOW - 1000));
    expect(await feed('hosts', '?session=sess-plain')).toHaveLength(256);
    expect(await feed('links', '?session=sess-plain')).toHaveLength(512);
  });

  it('polling does not read the recording again: memory answers a recent window, the cache the rest', async () => {
    memory = { events: recording.filter((e) => e.timestamp > NOW - 3_600_000), since: NOW - 7_200_000 };
    for (let i = 0; i < 3; i++) for (const r of ROUTES) await feed(r, '?session=sess-plain&relative=1h');
    expect(eventsCalls).toBe(0);
    memory = { events: [], since: NOW + 1 };
    for (let i = 0; i < 3; i++) for (const r of ROUTES) await feed(r, '?session=sess-plain&relative=1h');
    expect(eventsCalls).toBe(1);
  });
});

describe('the Godot build', () => {
  const put = (name: string, body: string) => {
    writeFileSync(join(godotDir, name), body);
    utimesSync(join(godotDir, name), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  };

  it('is 404 while Styx is off', async () => {
    put('index.html', '<html></html>');
    enabled = false;
    expect((await app.inject('/styx/godot/index.html')).statusCode).toBe(404);
    expect((await app.inject('/api/styx/godot/status')).statusCode).toBe(404);
  });

  it('serves a file with its type, the CSP and nosniff', async () => {
    put('index.html', '<html></html>');
    put('index.wasm', 'x');
    const html = await app.inject('/styx/godot/');
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(String(html.headers['content-security-policy'])).toContain("connect-src 'self'");
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['cache-control']).toBe('no-cache');
    expect((await app.inject('/styx/godot/index.wasm?v=1')).headers['content-type']).toBe('application/wasm');
  });

  it('answers 404 JSON, never the app, for a missing file, and for traversal', async () => {
    const missing = await app.inject('/styx/godot/index.wasm');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/json');
    expect((await app.inject('/styx/godot/..%2fsecret.json')).statusCode).toBe(404);
  });

  it('answers 304 to If-Modified-Since for an unchanged file', async () => {
    put('index.pck', 'x');
    const first = await app.inject('/styx/godot/index.pck');
    const again = await app.inject({ url: '/styx/godot/index.pck', headers: { 'if-modified-since': String(first.headers['last-modified']) } });
    expect(again.statusCode).toBe(304);
  });

  it('reports the build status', async () => {
    const empty = (await app.inject('/api/styx/godot/status')).json();
    expect(empty.present).toBe(false);
    expect(empty.dir).toBe(godotDir);
  });
});

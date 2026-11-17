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

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'netobs', '__fixtures__');
/** The fixture's clock: its last record is a little before this. */
const NOW = Date.parse('2026-09-23T14:14:48.000Z');

const toolCall = (id: string, sessionId: string, toolName: string, toolInput: Record<string, unknown>, at: number): TimelineEvent => ({
  id, type: 'tool_call_completed', timestamp: at, sessionId, agentType: 'claude-code', data: { toolName, toolInput },
});

let home: string;
let godotDir: string;
let netObs: NetObs;
let app: FastifyInstance;
let enabled: boolean;
let eventsCalls: number;
let memory: { events: TimelineEvent[]; since: number };
let recording: TimelineEvent[];
let sessions: Record<string, string | undefined>; // id → session name

function flowLine(id: string, host: string, scope: string, t: string): string {
  return JSON.stringify({
    v: 1, type: 'flow', phase: 'open', id, env: 'pi-search', session: 'pi-search', t, t_open: t, t_close: null, service: 'proxy',
    tool: 'web_fetch', client: 'harness', proto: 'http-connect', dest: { host, port: 443, ip: null, resolution: 'literal' }, scope,
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
    now: () => NOW,
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { TimelineEvent } from '../events/types.js';
import { extractTurns } from '../turns/extract.js';
import { NetObs } from './index.js';
import { registerNetRoutes } from './routes.js';
import { buildTrace, callsBetween, type TraceDeps } from './trace.js';
import type { TraceView } from './types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const at = (s: string) => Date.parse(`2026-09-23T14:${s}Z`);

let n = 0;
const ev = (sessionId: string, type: TimelineEvent['type'], t: number, data: TimelineEvent['data']): TimelineEvent => ({
  id: `${sessionId}-e${++n}`, type, timestamp: t + 1500, sessionId, agentType: 'pi', data: { ...data, transcriptAt: t },
});
const fetch_ = (sid: string, url: string, t: number) =>
  ev(sid, 'tool_call_completed', t, { toolName: 'web_fetch', toolInput: { url }, transcriptCompletedAt: t + 800 });

/** Two pi runs in one glove session, plus an unrelated session with another name. */
function sessions(): Record<string, TimelineEvent[]> {
  return {
    run1: [
      ev('run1', 'user_prompt', at('10:00.000'), { prompt: 'an earlier turn' }),
      fetch_('run1', 'https://example.org/', at('10:01.000')),
      ev('run1', 'user_prompt', at('14:43.000'), { prompt: 'Research the history of onion routing' }),
      ev('run1', 'tool_call_completed', at('14:43.300'), { toolName: 'web_search', toolInput: { query: 'onion routing' }, transcriptCompletedAt: at('14:44.500') }),
      fetch_('run1', 'https://arxiv.org/abs/2403.01234', at('14:43.350')),
      fetch_('run1', 'http://169.254.169.254/latest/meta-data/', at('14:43.350')),
      fetch_('run1', 'https://arxiv.org/pdf/2403.01234', at('14:46.400')),
    ],
    run2: [ev('run2', 'user_prompt', at('14:50.000'), { prompt: 'a later run' })],
    // Hours before the glove session's first record: another run's, not shown.
    old: [ev('old', 'user_prompt', at('00:00.000') - 3 * 3600_000, { prompt: 'long ago' })],
    elsewhere: [ev('elsewhere', 'user_prompt', at('14:43.000'), { prompt: 'not gloved' })],
  };
}

let home: string;
let netObs: NetObs;
let deps: TraceDeps;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'netobs-trace-'));
  const net = join(home, 'envs', 'pi-search', 'sessions', 'pi-search', 'net');
  mkdirSync(net, { recursive: true });
  for (const f of ['flows.ndjson', 'exit.ndjson', 'session.json', 'status.json']) copyFileSync(join(FIXTURE, f), join(net, f));
  netObs = new NetObs({ getSessionsDir: () => join(home, 'envs') });
  netObs.poll(at('14:48.000'));
  const all = sessions();
  deps = {
    sessionsNamed: (token) => (token === 'pi-search' ? ['run1', 'run2', 'old'] : []),
    turns: (sid) => extractTurns(all[sid] ?? []),
    events: (sid) => all[sid] ?? [],
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('buildTrace', () => {
  it('lists the turns of every run in the glove session, in time order, within its span', () => {
    const t = buildTrace(netObs.store, 'pi-search', deps, null, at('14:55.000'))!;
    expect(t.sessionIds).toEqual(['run1', 'run2', 'old']);
    expect(t.turns.map((x) => [x.sessionId, x.promptText])).toEqual([
      ['run1', 'an earlier turn'], ['run1', 'Research the history of onion routing'], ['run2', 'a later run'],
    ]);
  });

  it('shows the latest turn by default, and uses the transcript\'s prompt time', () => {
    const t = buildTrace(netObs.store, 'pi-search', deps, null, at('14:55.000'))!;
    expect(t.turn?.promptText).toBe('a later run');
    expect(t.turn?.startedAt).toBe(at('14:50.000'));
    expect(t.items).toEqual([]);
  });

  it('joins a chosen turn\'s calls to the flows opened before the next prompt', () => {
    const turns = buildTrace(netObs.store, 'pi-search', deps, null)!.turns;
    const t = buildTrace(netObs.store, 'pi-search', deps, { turn: turns[1].promptEventId }, at('14:55.000'))!;
    expect(t.window).toEqual({ from: at('14:42.000'), to: at('14:49.000') });
    const hosts = (ids: string[]) => ids.map((id) => t.flows.find((f) => f.id === id)!.dest.host);
    const calls = t.items.flatMap((i) => (i.kind === 'call' ? [[i.call.label, hosts([...i.flowIds, ...i.fanoutIds]).length, i.call.timing]] : []));
    expect(calls).toEqual([
      ['onion routing', 4, 'exact'],
      ['https://arxiv.org/abs/2403.01234', 1, 'exact'],
      ['http://169.254.169.254/latest/meta-data/', 1, 'exact'],
      ['https://arxiv.org/pdf/2403.01234', 1, 'exact'],
    ]);
    expect(t.items.filter((i) => i.kind === 'llm')).toHaveLength(1);
    // Fetches the transcript does not have (wikipedia, nature, …) are unattributed, never guessed.
    expect(hosts(t.unattributed)).toContain('en.wikipedia.org');
    expect(t.counts).toMatchObject({ calls: 4, flows: 15, refused: 3, blocked: 1 });
  });

  it('accepts any event id in the turn, and says so when the turn is not this session\'s', () => {
    const turns = buildTrace(netObs.store, 'pi-search', deps, null)!.turns;
    const events = deps.events('run1');
    expect(buildTrace(netObs.store, 'pi-search', deps, { turn: events[4].id })!.turn?.promptEventId).toBe(turns[1].promptEventId);
    const none = buildTrace(netObs.store, 'pi-search', deps, { turn: 'elsewhere-e1' })!;
    expect([none.turn, none.items, none.turns.length]).toEqual([null, [], 3]);
  });

  it('finds the turn in progress at a moment, for the detail card and the ribbon', () => {
    const pick = (t: number) => buildTrace(netObs.store, 'pi-search', deps, { at: t }, at('14:55.000'))!.turn?.promptText;
    expect(pick(at('14:46.423'))).toBe('Research the history of onion routing');
    expect(pick(at('10:30.000'))).toBe('an earlier turn');
    expect(pick(at('14:52.000'))).toBe('a later run');
    // Before the first turn's window: none.
    expect(pick(at('09:00.000'))).toBeUndefined();
  });

  it('lists the calls in a time range across turns and runs, for the ribbon', () => {
    const calls = callsBetween(netObs.store, 'pi-search', deps, at('10:00.500'), at('14:44.000'))!;
    expect(calls.map((c) => c.label)).toEqual([
      'https://example.org/', 'onion routing', 'https://arxiv.org/abs/2403.01234', 'http://169.254.169.254/latest/meta-data/',
    ]);
    expect(callsBetween(netObs.store, 'nope', deps, 0, 1)).toBeNull();
  });

  it('is null for an unknown glove session, and empty when no Layman session is named after it', () => {
    expect(buildTrace(netObs.store, 'nope', deps, null)).toBeNull();
    const t = buildTrace(netObs.store, 'pi-search', { ...deps, sessionsNamed: () => [] }, null)!;
    expect([t.turns, t.turn]).toEqual([[], null]);
  });
});

describe('GET /api/net/sessions/:token/trace', () => {
  let app: FastifyInstance;
  afterEach(async () => { await app.close(); });

  it('returns the trace, 404s an unknown session, and 501s without the Layman side', async () => {
    app = Fastify();
    registerNetRoutes(app, { netObs, trace: deps });
    await app.ready();
    const res = await app.inject('/api/net/sessions/pi-search/trace');
    expect(res.statusCode).toBe(200);
    expect((res.json() as TraceView).turns).toHaveLength(3);
    const byTime = await app.inject(`/api/net/sessions/pi-search/trace?at=${at('10:30.000')}`);
    expect((byTime.json() as TraceView).turn?.promptText).toBe('an earlier turn');
    const calls = await app.inject(`/api/net/sessions/pi-search/calls?from=${at('14:43.000')}&to=${at('14:47.000')}`);
    expect(calls.json().calls).toHaveLength(4);
    expect((await app.inject('/api/net/sessions/pi-search/calls?from=0&to=99999999999')).statusCode).toBe(400);
    expect((await app.inject('/api/net/sessions/nope/trace')).statusCode).toBe(404);
    await app.close();
    app = Fastify();
    registerNetRoutes(app, { netObs });
    await app.ready();
    expect((await app.inject('/api/net/sessions/pi-search/trace')).statusCode).toBe(501);
  });
});

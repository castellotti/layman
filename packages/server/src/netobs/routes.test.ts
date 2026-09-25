import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NetObs } from './index.js';
import { registerNetRoutes } from './routes.js';
import type { NetSnapshot } from './types.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

let home: string;
let app: FastifyInstance;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'netobs-routes-'));
  const net = join(home, 'envs', 'pi-search', 'sessions', 'pi-search', 'net');
  mkdirSync(net, { recursive: true });
  for (const f of ['flows.ndjson', 'exit.ndjson', 'session.json', 'status.json']) copyFileSync(join(FIXTURE, f), join(net, f));
  const netObs = new NetObs({ getSessionsDir: () => join(home, 'envs') });
  netObs.poll(Date.parse('2026-09-23T14:14:48.000Z'));
  app = Fastify();
  registerNetRoutes(app, { netObs });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

describe('net REST routes', () => {
  it('GET /api/net/sessions lists the fixture session', async () => {
    const res = await app.inject('/api/net/sessions');
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toMatchObject([{ token: 'pi-search', env: 'pi-search', harness: 'pi', flows: 15 }]);
  });

  it('GET /api/net/sessions/pi-search returns 15 flows with their states', async () => {
    const res = await app.inject('/api/net/sessions/pi-search');
    expect(res.statusCode).toBe(200);
    const snap = res.json() as NetSnapshot;
    expect(snap.flows).toHaveLength(15);
    const counts: Record<string, number> = {};
    for (const f of snap.flows) counts[f.state] = (counts[f.state] ?? 0) + 1;
    expect(counts).toEqual({ finished: 9, gate_shutdown: 1, broken: 1, guard: 3, user_rule: 1 });
  });

  it('404s an unknown token', async () => {
    expect((await app.inject('/api/net/sessions/nope')).statusCode).toBe(404);
    expect((await app.inject('/api/net/sessions/nope/flows')).statusCode).toBe(404);
  });

  it('pages flows and serves buckets by window', async () => {
    const flows = (await app.inject('/api/net/sessions/pi-search/flows?limit=4')).json().flows;
    expect(flows).toHaveLength(4);
    const buckets = (await app.inject('/api/net/sessions/pi-search/buckets?window=60s')).json();
    expect(buckets.buckets.length).toBeGreaterThan(0);
    const sum = buckets.buckets.reduce((a: number, b: { down: number }) => a + b.down, 0);
    expect(sum).toBe(1_475_671);
    expect((await app.inject('/api/net/sessions/pi-search/buckets?window=2d')).statusCode).toBe(400);
  });
});

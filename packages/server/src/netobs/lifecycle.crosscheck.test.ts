/**
 * The gate-lifecycle rule (glove's record contract) exists in two places: glove's reference
 * `glove.netview.ended_runs` and its port in `NetStore`. This runs both on the
 * same records — every scenario fixture plus a few hundred seeded random
 * sequences — and requires the same ended runs. Skipped when glove (or `uv`)
 * is not available next to this repo, like the fixture drift guards.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { NetStore } from './store.js';
import { parseLine } from './parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOVE = join(HERE, '../../../../../glove');
const SCENARIOS = join(HERE, '__scenarios__');

function uvAvailable(): boolean {
  if (!existsSync(join(GLOVE, 'glove', 'netview.py'))) return false;
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** glove's answer for many record lists at once (one interpreter start). */
function gloveEndedRuns(batches: unknown[][]): string[][] {
  const script = 'import json,sys\nfrom glove.netview import ended_runs\n'
    + 'print(json.dumps([sorted(ended_runs(b)) for b in json.load(sys.stdin)]))';
  const out = execFileSync('uv', ['run', '--quiet', '--project', GLOVE, 'python', '-c', script], {
    input: JSON.stringify(batches), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out) as string[][];
}

function laymanEndedRuns(records: unknown[]): string[] {
  const store = new NetStore();
  store.ensure({ token: 'x', env: 'x', name: 'x', netDir: '/nonexistent', controlDir: '/nonexistent', rulesPath: '/nonexistent/rules.json' });
  for (const rec of records) {
    const p = parseLine(JSON.stringify(rec));
    if (p.kind === 'flow') store.ingestFlow('x', p.record, 0);
    else if (p.kind === 'gate') store.ingestGate('x', p.record, 0);
  }
  return store.endedRuns('x');
}

/** mulberry32: a seeded generator, so a failing sequence can be reproduced. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random interleaving of starts, stops (some inferred), collector records and flow records. */
function randomSequence(seed: number): unknown[] {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const t = (i: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, 0, i * 100)).toISOString();
  const base = { v: 1, env: 'x', session: 'x' };
  const services = ['proxy', 'llm'];
  const runs: Record<string, string[]> = { proxy: ['g_P1', 'g_P2', 'g_P3'], llm: ['g_L1', 'g_L2'] };
  const out: unknown[] = [];
  const n = 5 + Math.floor(r() * 25);
  for (let i = 0; i < n; i++) {
    const service = pick(services);
    const run = pick(runs[service]);
    const kind = r();
    if (kind < 0.3) out.push({ ...base, type: 'gate', event: 'start', role: 'forward', run, service, t: t(i) });
    else if (kind < 0.5) out.push({ ...base, type: 'gate', event: 'stop', role: 'forward', run, service, t: t(i), ...(r() < 0.5 ? { inferred: true } : {}) });
    else if (kind < 0.55) out.push({ ...base, type: 'gate', event: pick(['start', 'stop']), role: 'collect', run: 'g_C', service: null, t: t(i) });
    else {
      out.push({
        ...base, type: 'flow', phase: 'open', id: `f_${i}`, t: t(i), t_open: t(i), t_close: null, service, tool: null, client: 'harness',
        proto: 'tcp', dest: { host: 'h', port: 1, ip: null, resolution: 'disabled' }, scope: 'local', route: null,
        bytes: { up: 0, down: 0 }, verdict: 'allow', rule: null, close_reason: null, request: null, run,
      });
    }
  }
  return out;
}

const scenarioRecords = (name: string): unknown[] => {
  const dir = join(SCENARIOS, name);
  return readdirSync(dir)
    .filter((f) => /^flows(-.*)?\.ndjson$/.test(f))
    .sort((a, b) => (a === 'flows.ndjson' ? 1 : b === 'flows.ndjson' ? -1 : a.localeCompare(b)))
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
};

describe('gate lifecycle cross-check against glove.netview.ended_runs', () => {
  const available = uvAvailable();

  it.skipIf(!available)('agrees on every scenario and on 300 random sequences', () => {
    const names = readdirSync(SCENARIOS).filter((n) => statSync(join(SCENARIOS, n)).isDirectory()).sort();
    const batches = [...names.map(scenarioRecords), ...Array.from({ length: 300 }, (_, i) => randomSequence(i + 1))];
    const glove = gloveEndedRuns(batches);
    batches.forEach((b, i) => {
      const label = i < names.length ? `scenario ${names[i]}` : `random seed ${i - names.length + 1}`;
      expect(laymanEndedRuns(b), label).toEqual(glove[i]);
    });
    // The fixture that exists for this rule really exercises it.
    expect(glove[names.indexOf('gate-lost')]).toHaveLength(1);
  });
});

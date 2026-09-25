/**
 * A fake glove home and a replaying gate, for developing and checking Layman's
 * network views without running glove (docs/planning/network-views.md §9.1).
 *
 * Builds `<dir>/envs/pi-search/sessions/pi-search/net/` from glove's fixture
 * (`src/netobs/__fixtures__/`), with every timestamp rewritten to "now", then
 * replays the flow records at their original relative pace so the live views
 * animate. It heartbeats `status.json` every 5 s like a running gate, and marks
 * the gate stopped on Ctrl-C.
 *
 * Run:
 *
 *   pnpm --filter ./packages/server netobs:replay -- [options]     (via tsx)
 *   node packages/server/scripts/netobs-replay.ts [options]         (Node ≥ 23, no loader)
 *
 * then point Layman at it: `glove.enabled: true`, `glove.sessionsDir: <dir>/envs`.
 *
 * Options:
 *   --dir <path>         fake glove home (default /tmp/layman-netobs/glove)
 *   --speed <x>          replay speed multiplier (default 1; 0.1 = ten times slower)
 *   --loop               replay again, with fresh flow ids, after each pass
 *   --loop-gap <s>       seconds between passes (default 5)
 *   --rotate-every <n>   rename flows.ndjson to flows-<ts>.ndjson every n records
 *   --direct             inject one scope:"direct" flow mid-pass (the leak treatment)
 *   --gate               fake gate mode — not yet implemented (arrives with the rules writer)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'netobs', '__fixtures__');
const ENV = 'pi-search';
const NAME = 'pi-search';

interface Options {
  dir: string;
  speed: number;
  loop: boolean;
  loopGapS: number;
  rotateEvery: number;
  direct: boolean;
  gate: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    dir: '/tmp/layman-netobs/glove',
    speed: 1,
    loop: false,
    loopGapS: 5,
    rotateEvery: 0,
    direct: false,
    gate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--') continue; // `pnpm … netobs:replay -- --flag` passes the separator through
    else if (a === '--dir') o.dir = resolve(next());
    else if (a === '--speed') o.speed = Number(next());
    else if (a === '--loop') o.loop = true;
    else if (a === '--loop-gap') o.loopGapS = Number(next());
    else if (a === '--rotate-every') o.rotateEvery = Number(next());
    else if (a === '--direct') o.direct = true;
    else if (a === '--gate') o.gate = true;
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!(o.speed > 0)) throw new Error('--speed must be > 0');
  return o;
}

type Rec = Record<string, unknown> & { t: string; t_open?: string; t_close?: string | null; id?: string };

const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** glove's rotation stamp: `%Y%m%dT%H%M%S` + milliseconds + `Z`. */
function rotationStamp(ms: number): string {
  return iso(ms).replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.gate) {
    console.error('--gate (fake gate mode) arrives with the rules writer; replaying without it is supported now.');
    process.exit(2);
  }

  const net = join(o.dir, 'envs', ENV, 'sessions', NAME, 'net');
  const control = join(o.dir, 'control', ENV, NAME);
  // Only ever clear the fake session's own net/ dir, never anything above it.
  rmSync(net, { recursive: true, force: true });
  mkdirSync(net, { recursive: true });
  mkdirSync(control, { recursive: true });

  const flows: Rec[] = readFileSync(join(FIXTURE, 'flows.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const exitRec: Rec = JSON.parse(readFileSync(join(FIXTURE, 'exit.ndjson'), 'utf8').split('\n')[0]);
  const status = JSON.parse(readFileSync(join(FIXTURE, 'status.json'), 'utf8'));
  const session = JSON.parse(readFileSync(join(FIXTURE, 'session.json'), 'utf8'));

  const start = Date.now();
  writeAtomic(join(net, 'session.json'), JSON.stringify({ ...session, rendered_at: iso(start) }, null, 2) + '\n');
  appendFileSync(join(net, 'exit.ndjson'), JSON.stringify({ ...exitRec, t: iso(start) }) + '\n');
  // The fixture's rule set, as if a user had written it. Never clobber a file
  // already there: that is Layman's (or the user's) to own.
  const rulesPath = join(control, 'rules.json');
  if (!existsSync(rulesPath)) copyFileSync(join(FIXTURE, 'rules.json'), rulesPath);

  let written = 0;
  let rotations = 0;
  let stopped = false;
  const heartbeat = () =>
    writeAtomic(
      join(net, 'status.json'),
      JSON.stringify(
        {
          ...status,
          state: stopped ? 'stopped' : 'running',
          t: iso(Date.now()),
          rules: { ...status.rules, loaded_at: iso(start), source_mtime: iso(start) },
          telemetry: { ...status.telemetry, written, rotations },
        },
        null,
        2,
      ) + '\n',
    );
  heartbeat();
  const beat = setInterval(heartbeat, 5_000);
  process.on('SIGINT', () => {
    stopped = true;
    clearInterval(beat);
    heartbeat();
    console.log('\nGate marked stopped. Bye.');
    process.exit(0);
  });

  const flowsPath = join(net, 'flows.ndjson');
  writeFileSync(flowsPath, '');
  const write = (rec: Rec) => {
    appendFileSync(flowsPath, JSON.stringify(rec) + '\n');
    written++;
    if (o.rotateEvery > 0 && written % o.rotateEvery === 0) {
      let target = join(net, `flows-${rotationStamp(Date.now())}.ndjson`);
      for (let n = 1; existsSync(target); n++) target = join(net, `flows-${rotationStamp(Date.now())}-${n}.ndjson`);
      renameSync(flowsPath, target);
      writeFileSync(flowsPath, '');
      rotations++;
    }
  };

  console.log(`Fake glove home: ${o.dir}`);
  console.log(`Set in Layman:   glove.enabled = true, glove.sessionsDir = ${join(o.dir, 'envs')}`);
  console.log(`Replaying ${flows.length} records at ×${o.speed}${o.loop ? ', looping' : ''}. Ctrl-C to stop the gate.`);

  const t0 = Date.parse(flows[0].t);
  for (let pass = 0; ; pass++) {
    const passStart = Date.now();
    const shift = (s: string | null | undefined) =>
      s ? iso(passStart + (Date.parse(s) - t0) / o.speed) : (s ?? null);
    const directAt = Math.floor(flows.length / 2);
    for (let i = 0; i < flows.length; i++) {
      const r = flows[i];
      const due = passStart + (Date.parse(r.t) - t0) / o.speed;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      write({
        ...r,
        id: pass === 0 ? r.id : `${r.id}L${pass}`,
        t: shift(r.t)!,
        t_open: shift(r.t_open),
        t_close: shift(r.t_close),
      });
      if (o.direct && i === directAt) await injectDirect(write, pass);
    }
    console.log(`Pass ${pass + 1} done (${written} records written, ${rotations} rotations).`);
    if (!o.loop) break;
    await sleep(o.loopGapS * 1000);
  }
  console.log('Replay finished; the gate keeps heartbeating. Ctrl-C to stop it.');
}

/**
 * One flow that left with no tunnel: the anonymity failure the map, the strip
 * and the tab dot must make unmissable.
 */
async function injectDirect(write: (r: Rec) => void, pass: number): Promise<void> {
  const id = `f_DIRECTREPLAY${String(pass).padStart(4, '0')}`;
  const base = {
    v: 1, type: 'flow', id, env: ENV, session: ENV, service: 'proxy', tool: 'web_fetch', client: 'harness',
    proto: 'http-connect', dest: { host: 'api.github.com', port: 443, ip: '140.82.113.6', resolution: 'in-tunnel' },
    scope: 'direct', route: { kind: 'direct', upstream: null }, verdict: 'allow', rule: null, request: null,
  };
  const tOpen = iso(Date.now());
  write({ ...base, phase: 'open', t: tOpen, t_open: tOpen, t_close: null, bytes: { up: 60, down: 0 }, close_reason: null });
  await sleep(1000);
  write({ ...base, phase: 'update', t: iso(Date.now()), t_open: tOpen, t_close: null, bytes: { up: 1480, down: 42_000 }, close_reason: null });
  await sleep(1000);
  const tClose = iso(Date.now());
  write({ ...base, phase: 'close', t: tClose, t_open: tOpen, t_close: tClose, bytes: { up: 1510, down: 88_214 }, close_reason: 'eof' });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

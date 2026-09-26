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
 * With `--scenario`, it replays glove's scenario fixtures (`src/netobs/__scenarios__/`)
 * instead, each into its own glove session named after the scenario, so every
 * state they cover can be looked at side by side in the session picker.
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
 *   --scenario <names>   replay scenarios instead of the fixture: comma-separated names, or `all`
 *   --demo-geo <file>    write a small demo geolocation database (MaxMind format, type
 *                        "Layman-Demo-City": not real data) placing the fixtures' IPs, and exit.
 *                        Point Settings → Glove → Geolocation database at it.
 *   --gate               fake gate: validate control/<env>/<name>/rules.json with Layman's port of glove's
 *                        validator, report it in status.json as glove's collector does (sha256,
 *                        last_rejected, last good set kept on a rejection), and apply its verdicts to the
 *                        replayed flows (blocked opens; `terminate` rules cut open flows)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { evaluate, parseRulesBytes, type RuleSet } from '../src/netobs/rules.ts';
import { writeMmdb } from '../src/netobs/testing/mmdb-writer.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'netobs', '__fixtures__');
const SCENARIOS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'netobs', '__scenarios__');
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
  scenarios: string[];
  demoGeo: string | null;
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
    scenarios: [],
    demoGeo: null,
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
    else if (a === '--demo-geo') o.demoGeo = resolve(next());
    else if (a === '--scenario') {
      const v = next();
      o.scenarios = v === 'all'
        ? readdirSync(SCENARIOS).filter((n) => statSync(join(SCENARIOS, n)).isDirectory()).sort()
        : v.split(',').map((n) => n.trim()).filter(Boolean);
      for (const n of o.scenarios) if (!existsSync(join(SCENARIOS, n, 'status.json'))) throw new Error(`no scenario "${n}" in ${SCENARIOS}`);
    }
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

/** What a replay needs from a fixture: its records in file order, and its side files. */
interface Source {
  /** flows.ndjson (rotated files first, oldest first) and exit.ndjson, merged by time. */
  records: Array<{ file: 'flows' | 'exit'; rec: Rec }>;
  status: Record<string, unknown> & { state?: string; rules?: Record<string, unknown>; telemetry?: Record<string, unknown> };
  session: Record<string, unknown>;
  rules: string | null;
}

const readNdjson = (path: string): Rec[] =>
  existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

/** glove's `(stamp, n)` order for rotated files (handoff §2), not name order. */
function rotatedFlows(dir: string): string[] {
  const key = (f: string) => {
    const m = /^flows-(\d{8}T\d{9}Z)(?:-(\d+))?\.ndjson$/.exec(f);
    return m ? [m[1], Number(m[2] ?? 0)] as const : null;
  };
  return readdirSync(dir)
    .filter((f) => key(f) !== null)
    .sort((a, b) => { const x = key(a)!; const y = key(b)!; return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]; })
    .map((f) => join(dir, f));
}

function loadSource(dir: string): Source {
  const flows = [...rotatedFlows(dir), join(dir, 'flows.ndjson')].flatMap(readNdjson);
  const exits = readNdjson(join(dir, 'exit.ndjson'));
  // Exits first at a tie: the fixture's exit record predates the flows it explains.
  const records = [
    ...exits.map((rec) => ({ file: 'exit' as const, rec })),
    ...flows.map((rec) => ({ file: 'flows' as const, rec })),
  ].sort((x, y) => Date.parse(x.rec.t) - Date.parse(y.rec.t));
  const rulesPath = join(dir, 'rules.json');
  return {
    records,
    status: JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')),
    session: JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')),
    rules: existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : null,
  };
}

const stops: Array<() => void> = [];

/** Where the demo database puts the fixtures' IPs: plausible, made up, and labelled as such. */
const DEMO_PLACES: Array<{ cidr: string; city: string; countryCode: string; country: string; lat: number; lon: number }> = [
  { cidr: '151.101.0.0/16', city: 'San Francisco', countryCode: 'US', country: 'United States', lat: 37.77, lon: -122.42 },
  { cidr: '93.184.215.0/24', city: 'Los Angeles', countryCode: 'US', country: 'United States', lat: 34.05, lon: -118.24 },
  { cidr: '40.114.177.0/24', city: 'Virginia', countryCode: 'US', country: 'United States', lat: 38.03, lon: -78.48 },
  { cidr: '185.15.59.0/24', city: 'Amsterdam', countryCode: 'NL', country: 'Netherlands', lat: 52.37, lon: 4.9 },
  { cidr: '143.204.55.0/24', city: 'Frankfurt', countryCode: 'DE', country: 'Germany', lat: 50.11, lon: 8.68 },
  { cidr: '5.102.173.0/24', city: 'London', countryCode: 'GB', country: 'United Kingdom', lat: 51.51, lon: -0.13 },
  { cidr: '51.91.211.0/24', city: 'Roubaix', countryCode: 'FR', country: 'France', lat: 50.69, lon: 3.17 },
  { cidr: '140.82.113.0/24', city: 'Ashburn', countryCode: 'US', country: 'United States', lat: 39.04, lon: -77.49 },
];

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.demoGeo) {
    writeFileSync(o.demoGeo, writeMmdb(DEMO_PLACES.map(({ cidr, ...record }) => ({ cidr, record })), 'Layman-Demo-City'));
    console.log(`Demo geolocation database (not real data): ${o.demoGeo}`);
    return;
  }
  process.on('SIGINT', () => {
    for (const stop of stops) stop();
    console.log('\nGate marked stopped. Bye.');
    process.exit(0);
  });
  console.log(`Fake glove home: ${o.dir}`);
  console.log(`Set in Layman:   glove.enabled = true, glove.sessionsDir = ${join(o.dir, 'envs')}`);
  if (o.scenarios.length) {
    console.log(`Replaying scenarios ${o.scenarios.join(', ')}, each as its own session. Ctrl-C to stop the gates.`);
    await Promise.all(o.scenarios.map((n) => replay(o, loadSource(join(SCENARIOS, n)), n, n, false)));
  } else {
    await replay(o, loadSource(FIXTURE), ENV, NAME, o.direct);
  }
  console.log('Replay finished; the gate keeps heartbeating. Ctrl-C to stop it.');
}

/** status.json `rules`, as glove's collector reports them. */
interface GateRules {
  loaded_at: string | null;
  source_mtime: string | null;
  ok: boolean;
  error: string | null;
  active_count: number;
  sha256: string | null;
  last_rejected: { checked_at: string; source_mtime: string | null; sha256: string | null; error: string } | null;
}

/**
 * A stand-in for glove's PolicyWatcher: polls rules.json, keeps the last
 * known-good set, and reports every read the way the real gate does — by hash.
 */
class FakeGate {
  set: RuleSet | null = null;
  rules: GateRules = { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0, sha256: null, last_rejected: null };
  private sig: string | null = null;

  constructor(private readonly path: string, private readonly env: string, private readonly token: string) {}

  /** True when the enforced set changed. */
  poll(): boolean {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      if (this.sig === 'absent') return false;
      const had = this.set !== null;
      this.sig = 'absent';
      this.set = null;
      this.rules = { ...this.rules, loaded_at: iso(Date.now()), source_mtime: null, ok: true, error: null, active_count: 0, sha256: null };
      return had;
    }
    const sig = `${st.ino}:${st.mtimeMs}:${st.size}:${st.mode}:${st.uid}:${st.gid}`;
    if (sig === this.sig) return false;
    this.sig = sig;
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.path);
    } catch (e) {
      const error = `cannot read rules.json: ${(e as NodeJS.ErrnoException).code}`;
      this.rules = { ...this.rules, ok: false, error, last_rejected: { checked_at: iso(Date.now()), source_mtime: iso(st.mtimeMs), sha256: null, error } };
      return false;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      this.set = parseRulesBytes(bytes, { env: this.env, session: this.token }).set;
    } catch (e) {
      const error = (e as Error).message;
      this.rules = { ...this.rules, ok: false, error, last_rejected: { checked_at: iso(Date.now()), source_mtime: iso(st.mtimeMs), sha256, error } };
      return false;
    }
    this.rules = { ...this.rules, loaded_at: iso(Date.now()), source_mtime: iso(st.mtimeMs), ok: true, error: null, active_count: this.set.rules.length, sha256 };
    return true;
  }

  /** The verdict for a flow record, or null to let it through. glove's own refusals are never second-guessed. */
  verdict(r: Rec): { rule: string | null; terminate: boolean } | null {
    if (!this.set || r.verdict === 'block') return null;
    const dest = (r.dest ?? {}) as { host?: string | null; ip?: string | null; port?: number | null };
    const v = evaluate(this.set, {
      host: dest.host ?? null, ip: dest.ip ?? null, port: dest.port ?? null,
      service: (r.service as string) ?? null, tool: (r.tool as string) ?? null, scope: (r.scope as string) ?? null,
    });
    return v.action === 'block' ? { rule: v.rule, terminate: v.terminate } : null;
  }
}

/**
 * Replay one source into `<dir>/envs/<env>/sessions/<name>/net/`, rewriting
 * times to now and `env`/`session` to this session's. A later pass gets fresh
 * flow and run ids, so to the reader each pass is a restarted gate.
 */
async function replay(o: Options, src: Source, env: string, name: string, direct: boolean): Promise<void> {
  const token = name === env ? env : `${env}-${name}`;
  const net = join(o.dir, 'envs', env, 'sessions', name, 'net');
  const control = join(o.dir, 'control', env, name);
  // Only ever clear the fake session's own net/ dir, never anything above it.
  rmSync(net, { recursive: true, force: true });
  mkdirSync(net, { recursive: true });
  mkdirSync(control, { recursive: true });

  const start = Date.now();
  writeAtomic(join(net, 'session.json'), JSON.stringify({ ...src.session, env, session: token, rendered_at: iso(start) }, null, 2) + '\n');
  // The source's rule set, as if a user had written it. Never clobber a file
  // already there: that is Layman's (or the user's) to own.
  const rulesPath = join(control, 'rules.json');
  if (src.rules !== null && !existsSync(rulesPath)) {
    writeFileSync(rulesPath, src.rules.replace(/"env": *"[^"]*"/, `"env": "${env}"`).replace(/"session": *"[^"]*"/, `"session": "${token}"`));
  }

  let written = 0;
  let rotations = 0;
  let state = 'running';
  const gate = o.gate ? new FakeGate(rulesPath, env, token) : null;
  gate?.poll();
  const heartbeat = () => {
    const rules = gate ? gate.rules : src.status.rules ?? {};
    writeAtomic(
      join(net, 'status.json'),
      JSON.stringify(
        {
          ...src.status,
          state,
          t: iso(Date.now()),
          rules: gate ? rules : { ...rules, loaded_at: rules.loaded_at ? iso(start) : null, source_mtime: rules.source_mtime ? iso(start) : null },
          telemetry: { ...src.status.telemetry, written, rotations },
        },
        null,
        2,
      ) + '\n',
    );
  };
  heartbeat();
  const beat = setInterval(heartbeat, 5_000);
  // Flows the fake gate refused or cut: their remaining records are dropped, as the real gate would never send them.
  const ended = new Set<string>();
  const open = new Map<string, Rec>();
  const cut = (r: Rec, rule: string | null, bytes?: unknown) => {
    const t = iso(Date.now());
    ended.add(r.id as string);
    open.delete(r.id as string);
    write({ ...r, phase: 'close', t, t_close: t, verdict: 'block', rule, close_reason: 'blocked', bytes: bytes ?? { up: 40, down: 180 } });
  };
  // Forwarders re-read rules.json about once a second; `terminate` rules cut established flows.
  const rulesTimer = gate
    ? setInterval(() => {
        if (!gate.poll()) return;
        for (const r of [...open.values()]) {
          const v = gate.verdict(r);
          if (v?.terminate) cut(r, v.rule, r.bytes);
        }
      }, 1_000)
    : null;
  stops.push(() => {
    state = 'stopped';
    clearInterval(beat);
    if (rulesTimer) clearInterval(rulesTimer);
    heartbeat();
  });

  const flowsPath = join(net, 'flows.ndjson');
  writeFileSync(flowsPath, '');
  const write = (rec: Rec, file: 'flows' | 'exit' = 'flows') => {
    if (file === 'exit') {
      appendFileSync(join(net, 'exit.ndjson'), JSON.stringify(rec) + '\n');
      return;
    }
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

  console.log(`  ${token}: ${src.records.length} records at ×${o.speed}${o.loop ? ', looping' : ''}`);
  const t0 = Date.parse(src.records[0]?.rec.t ?? iso(start));
  for (let pass = 0; ; pass++) {
    const passStart = Date.now();
    const shift = (s: string | null | undefined) =>
      s ? iso(passStart + (Date.parse(s) - t0) / o.speed) : (s ?? null);
    const renamed = (v: unknown) => (pass === 0 || typeof v !== 'string' ? v : `${v}L${pass}`);
    const directAt = Math.floor(src.records.length / 2);
    for (let i = 0; i < src.records.length; i++) {
      const { file, rec: r } = src.records[i];
      const due = passStart + (Date.parse(r.t) - t0) / o.speed;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const out: Rec = { ...r, env, session: token, t: shift(r.t)! };
      if (file === 'flows') {
        if ('id' in r) out.id = renamed(r.id) as string;
        if ('run' in r) out.run = renamed(r.run);
        if ('t_open' in r) out.t_open = shift(r.t_open) ?? undefined;
        if ('t_close' in r) out.t_close = shift(r.t_close);
      }
      if (file === 'flows' && out.type === 'flow' && gate) {
        if (ended.has(out.id as string)) continue;
        const v = out.phase === 'open' ? gate.verdict(out) : null;
        if (v) {
          // Refused at open: one close record, as the gate writes for a blocked connection.
          write({ ...out, phase: 'open', verdict: 'block', rule: v.rule, bytes: { up: 40, down: 0 } });
          cut(out, v.rule);
          continue;
        }
        if (out.phase === 'close') open.delete(out.id as string);
        else open.set(out.id as string, out);
      }
      write(out, file);
      if (direct && i === directAt) await injectDirect(write, pass, env, token);
    }
    if (!o.loop) break;
    await sleep(o.loopGapS * 1000);
  }
  // A scenario that ends with the gate stopped (`stopped`) says so; otherwise keep heartbeating.
  if (src.status.state && src.status.state !== 'running') {
    state = src.status.state;
    clearInterval(beat);
    if (rulesTimer) clearInterval(rulesTimer);
    heartbeat();
  }
  console.log(`  ${token}: done (${written} records written, ${rotations} rotations).`);
}

/**
 * One flow that left with no tunnel: the anonymity failure the map, the strip
 * and the tab dot must make unmissable.
 */
async function injectDirect(write: (r: Rec) => void, pass: number, env: string, token: string): Promise<void> {
  const id = `f_DIRECTREPLAY${String(pass).padStart(4, '0')}`;
  const base = {
    v: 1, type: 'flow', id, env, session: token, service: 'proxy', tool: 'web_fetch', client: 'harness',
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

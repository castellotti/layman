// A finished glove session with 300 destinations and 40 broken paths (`big`), so the Destinations table windows past
// 200 rows and Topology's destination and broken-path columns both scroll. And `llm-lan`, shaped after a real gloved pi
// whose Topology overlapped: the model call through llm-auth to a LAN host (`llm` → `llm-upstream`), Playwright's
// egress to many hosts, broken paths and guard refusals. Written into the e2e work dir's fake glove home by
// scripts/netobs-e2e.sh.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GLOVE, sid } from './env.mjs';

const ID = sid('big');

const net = join(GLOVE, 'observe', ID, 'net');
mkdirSync(net, { recursive: true });
const t0 = Date.now() - 5 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const lines = [];
for (let i = 0; i < 300; i++) {
  const base = {
    v: 1, type: 'flow', id: `f_BIG${String(i).padStart(6, '0')}`, env: ID, session: ID, t_open: iso(t0 + i * 1000),
    service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
    dest: { host: `host${i}.example${i % 7}.com`, port: 443, ip: `151.101.${i % 250}.${1 + (i % 200)}`, resolution: 'in-tunnel' },
    scope: 'tunnelled', route: { kind: 'vpn', upstream: null }, verdict: 'allow', rule: null, request: null,
  };
  lines.push({ ...base, phase: 'open', t: base.t_open, t_close: null, bytes: { up: 100, down: 0 }, close_reason: null });
  lines.push({ ...base, phase: 'close', t: iso(t0 + i * 1000 + 1000), t_close: iso(t0 + i * 1000 + 1000), bytes: { up: 900, down: 20000 }, close_reason: 'eof' });
}
// And 40 paths that broke (the upstream could not reach them), so Topology's broken-path column scrolls too.
for (let i = 0; i < 40; i++) {
  const at = t0 + 250_000 + i * 500;
  const base = {
    v: 1, type: 'flow', id: `f_BIGDEAD${String(i).padStart(4, '0')}`, env: ID, session: ID, t_open: iso(at),
    service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
    dest: { host: `dead${i}.unreachable.net`, port: 443, ip: null, resolution: 'unavailable' },
    scope: 'tunnelled', route: { kind: 'vpn', upstream: null }, verdict: 'allow', rule: null, request: null,
  };
  lines.push({ ...base, phase: 'open', t: base.t_open, t_close: null, bytes: { up: 0, down: 0 }, close_reason: null });
  lines.push({ ...base, phase: 'close', t: iso(at + 200), t_close: iso(at + 200), bytes: { up: 65, down: 47 }, close_reason: 'upstream_unreachable' });
}
writeFileSync(join(net, 'flows.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// llm-lan: harness → llm → llm-auth (glove's sidecar) → llm-upstream → a model server on the LAN.
const LLM = sid('llm-lan');
const lnet = join(GLOVE, 'observe', LLM, 'net');
mkdirSync(lnet, { recursive: true });
const G = `glove-${LLM}`;
const llines = [];
const flow = (id, at, spec, bytes, close = 'eof') => {
  const base = { v: 1, type: 'flow', id, env: LLM, session: LLM, t_open: iso(at), route: null, verdict: 'allow', rule: null, request: null, ...spec };
  llines.push({ ...base, phase: 'open', t: base.t_open, t_close: null, bytes: { up: Math.min(100, bytes.up), down: 0 }, close_reason: null });
  llines.push({ ...base, phase: 'close', t: iso(at + 400), t_close: iso(at + 400), bytes, close_reason: close });
};
for (let i = 0; i < 20; i++) {
  const at = t0 + i * 5000;
  flow(`f_LLMHOP${i}`, at, { service: 'llm', tool: 'llm', client: 'harness', proto: 'tcp', scope: 'lan', dest: { host: `${G}-llm-auth`, port: 8080, ip: null, resolution: 'disabled' } }, { up: 210_000, down: 12_000 });
  flow(`f_LLMLEG${i}`, at + 20, { service: 'llm-upstream', tool: 'llm', client: 'llm', proto: 'tcp', scope: 'lan', dest: { host: 'gpu.lan', port: 8080, ip: '192.168.1.40', resolution: 'disabled' } }, { up: 200_000, down: 11_000 });
}
for (let i = 0; i < 60; i++) {
  flow(`f_LLMWEB${i}`, t0 + 1000 + i * 1500, { service: 'browser-egress', tool: 'browser', client: 'playwright', proto: 'http-connect', scope: 'tunnelled', dest: { host: `site${i}.example${i % 5}.com`, port: 443, ip: `151.101.${i}.${1 + i}`, resolution: 'in-tunnel' } }, { up: 800, down: 30_000 + i * 100 });
}
for (let i = 0; i < 25; i++) {
  flow(`f_LLMDEAD${i}`, t0 + 2000 + i * 700, { service: 'browser-egress', tool: 'browser', client: 'playwright', proto: 'http-connect', scope: 'tunnelled', dest: { host: `tracker${i}.adnet.example`, port: 443, ip: null, resolution: 'unavailable' } }, { up: 65, down: 47 }, 'upstream_unreachable');
}
for (const [i, host] of ['169.254.169.254', 'gluetun'].entries()) {
  flow(`f_LLMGUARD${i}`, t0 + 3000 + i * 900, { service: 'browser-egress', tool: 'browser', client: 'playwright', proto: 'http-connect', scope: 'local', dest: { host, port: 80, ip: null, resolution: 'literal' }, verdict: 'block', rule: 'builtin:ssrf-guard' }, { up: 39, down: 0 }, 'blocked');
}
writeFileSync(join(lnet, 'flows.ndjson'), llines.sort((a, b) => a.t.localeCompare(b.t)).map((l) => JSON.stringify(l)).join('\n') + '\n');
writeFileSync(join(lnet, 'session.json'), JSON.stringify({
  v: 1, type: 'session', env: LLM, session: LLM, harness: 'pi', upstream_kind: 'vpn', exit_identity: 'none', resolve: 'in-tunnel', services: [
    { service: 'llm', listen: `${G}-llm:8080`, observed: true, mode: 'tcp', tool: 'llm', scope: 'lan', client: 'harness', harness: true, upstream: `tcp:${G}-llm-auth:8080`, next: ['llm-upstream'] },
    { service: 'llm-upstream', listen: `${G}-llm-upstream:8080`, observed: true, mode: 'tcp', tool: 'llm', scope: 'lan', client: 'llm', harness: false, upstream: 'tcp:gpu.lan:8080', next: [] },
    { service: 'browser', listen: `${G}-browser:3001`, observed: true, mode: 'tcp', tool: 'browser', scope: 'local', client: 'harness', harness: true, upstream: `tcp:${G}-playwright:3001`, next: ['browser-egress'] },
    { service: 'browser-egress', listen: `${G}-browser-egress:8888`, observed: true, mode: 'http-proxy', tool: 'browser', client: 'playwright', harness: false, route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' }, next: [] },
  ],
}));
writeFileSync(join(lnet, 'status.json'), JSON.stringify({
  v: 1, gate: '0.3.0', state: 'stopped', record: 'metadata', upstream: { kind: 'vpn', healthy: true }, resolver: { mode: 'in-tunnel', healthy: true },
  rules: { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0 }, t: iso(t0 + 300_000),
}));
writeFileSync(join(net, 'session.json'), JSON.stringify({ v: 1, type: 'session', env: ID, session: ID, harness: 'pi', upstream_kind: 'vpn', exit_identity: 'none', services: [] }));
writeFileSync(join(net, 'status.json'), JSON.stringify({
  v: 1, gate: '0.1.0', state: 'stopped', record: 'metadata', upstream: { kind: 'vpn', healthy: true }, resolver: { mode: 'in-tunnel', healthy: true },
  rules: { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0 }, t: iso(t0 + 300_000),
}));
// A registry row (glove v3, observe grant only) and its session directory, so it is not listed as orphaned.
const dirOf = (id) => {
  const dir = join(GLOVE, 'sessions', id);
  mkdirSync(join(dir, '.glove'), { recursive: true });
  writeFileSync(join(dir, '.glove', 'id'), `${id}\n`);
  return dir;
};
// The same lock the replays take (netobs-replay.ts withRegistryLock), so no row is lost.
const lock = join(GLOVE, '.registry.replay-lock');
for (const until = Date.now() + 2000; ;) {
  try { mkdirSync(lock); break; } catch { if (Date.now() > until) break; await new Promise((r) => setTimeout(r, 10)); }
}
try {
  let rows = [];
  try { rows = JSON.parse(readFileSync(join(GLOVE, 'registry.json'), 'utf8')).sessions ?? []; } catch { /* none yet */ }
  rows = [...rows.filter((r) => r.id !== ID && r.id !== LLM), ...[ID, LLM].map((id) => ({ id, dir: dirOf(id), harness: 'pi', template: null, created: iso(t0), subnet: null,
    grants: { observe: { net: true, transcripts: false }, filter: { granted: false } } }))];
  writeFileSync(join(GLOVE, 'registry.json'), JSON.stringify({ v: 2, sessions: rows }, null, 2) + '\n');
} finally {
  rmSync(lock, { recursive: true, force: true });
}
console.log(`big: 300 destinations and 40 broken paths in ${net}; llm-lan: the model's path through llm-auth in ${lnet}`);

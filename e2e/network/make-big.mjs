// A finished glove session with 300 destinations (`big`), so the Destinations table windows past
// 200 rows. Written into the e2e work dir's fake glove home by scripts/netobs-e2e.sh.
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GLOVE } from './env.mjs';

const net = join(GLOVE, 'envs', 'big', 'sessions', 'big', 'net');
mkdirSync(net, { recursive: true });
const t0 = Date.now() - 5 * 60_000;
const iso = (ms) => new Date(ms).toISOString();
const lines = [];
for (let i = 0; i < 300; i++) {
  const base = {
    v: 1, type: 'flow', id: `f_BIG${String(i).padStart(6, '0')}`, env: 'big', session: 'big', t_open: iso(t0 + i * 1000),
    service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
    dest: { host: `host${i}.example${i % 7}.com`, port: 443, ip: `151.101.${i % 250}.${1 + (i % 200)}`, resolution: 'in-tunnel' },
    scope: 'tunnelled', route: { kind: 'vpn', upstream: null }, verdict: 'allow', rule: null, request: null,
  };
  lines.push({ ...base, phase: 'open', t: base.t_open, t_close: null, bytes: { up: 100, down: 0 }, close_reason: null });
  lines.push({ ...base, phase: 'close', t: iso(t0 + i * 1000 + 1000), t_close: iso(t0 + i * 1000 + 1000), bytes: { up: 900, down: 20000 }, close_reason: 'eof' });
}
writeFileSync(join(net, 'flows.ndjson'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
writeFileSync(join(net, 'session.json'), JSON.stringify({ v: 1, type: 'session', env: 'big', session: 'big', harness: 'pi', upstream_kind: 'vpn', exit_identity: 'none', services: [] }));
writeFileSync(join(net, 'status.json'), JSON.stringify({
  v: 1, gate: '0.1.0', state: 'stopped', record: 'metadata', upstream: { kind: 'vpn', healthy: true }, resolver: { mode: 'in-tunnel', healthy: true },
  rules: { loaded_at: null, source_mtime: null, ok: true, error: null, active_count: 0 }, t: iso(t0 + 300_000),
}));
console.log(`big: 300 destinations in ${net}`);

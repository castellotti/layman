/**
 * Hand-made glove records for what glove's rounds 1–10 added: llm-auth's two-hop
 * model call, the github and ssh relays (with a `--lan-only` refusal), and
 * `web_download`. Shaped after glove's endpoint specs (`extensions/llm/hooks.py`,
 * `extensions/ssh/hooks.py`, `extensions/github/extension.yml`,
 * `extensions/webfetch/extension.yml` at glove `7c8f07a`).
 *
 * To be replaced by glove's own netobs-v3 scenarios (`llm-auth`, `github`, `ssh`,
 * `downloads`) once glove generates them with its real forwarder and collector:
 * these are Layman's reading of the endpoint graph, not glove's output.
 */
import type { FlowRecord, NetService, NetSessionFile } from '../types.js';

export const ROUNDS_ID = 'pi-rounds-a1b2c3';
const G = `glove-${ROUNDS_ID}`;

export const ROUNDS_SERVICES: NetService[] = [
  // harness → llm (forwarder) → llm-auth (adds the key) → llm-upstream → provider
  { service: 'llm', listen: `${G}-llm:8080`, observed: true, mode: 'tcp', tool: 'llm', scope: 'cloud', client: 'harness', harness: true, upstream: `tcp:${G}-llm-auth:8080`, route: { kind: 'tcp', upstream: `tcp:${G}-llm-auth:8080` } },
  { service: 'llm-upstream', listen: `${G}-llm-upstream:443`, observed: true, mode: 'tcp', tool: 'llm', scope: 'cloud', client: 'llm', harness: false, upstream: 'tcp:api.anthropic.com:443', route: { kind: 'tcp', upstream: 'tcp:api.anthropic.com:443' } },
  { service: 'webdownload-mcp', listen: `${G}-webdownload-mcp:8000`, observed: true, mode: 'tcp', tool: 'web_download', scope: 'local', client: 'harness', harness: true, upstream: `tcp:${G}-fetcher:8000`, route: { kind: 'tcp', upstream: `tcp:${G}-fetcher:8000` } },
  { service: 'webdownload-egress', listen: `${G}-webdownload-egress:8888`, observed: true, mode: 'http-proxy', tool: 'web_download', client: 'webfetch', harness: false, route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' } },
  { service: 'github-egress', listen: `${G}-github-egress:8888`, observed: true, mode: 'http-proxy', tool: 'gh', client: 'github', harness: false, route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' } },
  { service: 'ssh-build', listen: `${G}-ssh-build:22`, observed: true, mode: 'tcp', tool: 'ssh', scope: 'lan', client: 'ssh', harness: false, upstream: 'tcp:build.lan:22', route: { kind: 'tcp', upstream: 'tcp:build.lan:22' } },
  { service: 'ssh-db', listen: `${G}-ssh-db:22`, observed: true, mode: 'tcp', tool: 'ssh', scope: 'lan', client: 'ssh', harness: false, upstream: 'tcp:db.example.com:22', route: { kind: 'tcp', upstream: 'tcp:db.example.com:22' } },
];

export function roundsSessionFile(): NetSessionFile {
  return {
    v: 1, type: 'session', env: ROUNDS_ID, session: ROUNDS_ID, harness: 'pi', gate: '0.3.0', record: 'metadata',
    resolve: 'in-tunnel', resolver: 'dns://gluetun:53', exit_identity: 'none', upstream_kind: 'vpn',
    rendered_at: '2026-10-12T10:00:00.000Z', services: ROUNDS_SERVICES,
  };
}

const T0 = Date.parse('2026-10-12T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

type FlowSpec = {
  id: string; service: string; tool: string; client: string; proto: string; scope: string;
  host: string | null; port: number; ip: string | null; resolution: string;
  open: number; close: number; up: number; down: number;
  verdict?: string; rule?: string | null; closeReason?: string;
};

function records(f: FlowSpec): FlowRecord[] {
  const base = {
    v: 1 as const, type: 'flow' as const, id: f.id, env: ROUNDS_ID, session: ROUNDS_ID, t_open: iso(T0 + f.open),
    service: f.service, tool: f.tool, client: f.client, proto: f.proto,
    dest: { host: f.host, port: f.port, ip: f.ip, resolution: f.resolution }, scope: f.scope, route: null,
    verdict: f.verdict ?? 'allow', rule: f.rule ?? null, request: null, run: 'g_01ROUNDS',
  };
  const open: FlowRecord = { ...base, phase: 'open', t: iso(T0 + f.open), t_close: null, bytes: { up: Math.min(f.up, 200), down: 0 }, close_reason: null };
  const close: FlowRecord = { ...base, phase: 'close', t: iso(T0 + f.close), t_close: iso(T0 + f.close), bytes: { up: f.up, down: f.down }, close_reason: f.closeReason ?? 'eof' };
  return [open, close];
}

const hop = (id: string, open: number, close: number, up: number, down: number): FlowSpec => ({
  id, service: 'llm', tool: 'llm', client: 'harness', proto: 'tcp', scope: 'cloud',
  host: `${G}-llm-auth`, port: 8080, ip: null, resolution: 'disabled', open, close, up, down,
});
const leg = (id: string, open: number, close: number, up: number, down: number): FlowSpec => ({
  id, service: 'llm-upstream', tool: 'llm', client: 'llm', proto: 'tcp', scope: 'cloud',
  host: 'api.anthropic.com', port: 443, ip: '160.79.104.10', resolution: 'disabled', open, close, up, down,
});

/** Two model calls through llm-auth (each a hop and a leg, the hop a little bigger: headers), then the rest. */
export const ROUNDS_FLOWS: FlowSpec[] = [
  hop('f_hop1', 0, 4000, 2100, 9100), leg('f_leg1', 30, 3980, 2000, 9000),
  { id: 'f_dlhop', service: 'webdownload-mcp', tool: 'web_download', client: 'harness', proto: 'tcp', scope: 'local', host: `${G}-fetcher`, port: 8000, ip: null, resolution: 'disabled', open: 5000, close: 9000, up: 400, down: 300 },
  { id: 'f_dl', service: 'webdownload-egress', tool: 'web_download', client: 'webfetch', proto: 'http-connect', scope: 'tunnelled', host: 'arxiv.org', port: 443, ip: '151.101.3.42', resolution: 'in-tunnel', open: 5100, close: 60_000, up: 900, down: 2_400_000 },
  { id: 'f_gh', service: 'github-egress', tool: 'gh', client: 'github', proto: 'http-connect', scope: 'tunnelled', host: 'api.github.com', port: 443, ip: '140.82.112.6', resolution: 'in-tunnel', open: 10_200, close: 11_000, up: 700, down: 5200 },
  { id: 'f_ssh', service: 'ssh-build', tool: 'ssh', client: 'ssh', proto: 'tcp', scope: 'lan', host: 'build.lan', port: 22, ip: '192.168.1.20', resolution: 'disabled', open: 12_100, close: 13_000, up: 3000, down: 4000 },
  { id: 'f_lanonly', service: 'ssh-db', tool: 'ssh', client: 'ssh', proto: 'tcp', scope: 'lan', host: 'db.example.com', port: 22, ip: null, resolution: 'disabled', open: 14_050, close: 14_050, up: 0, down: 0, verdict: 'block', rule: 'lan-only', closeReason: 'blocked' },
  hop('f_hop2', 20_000, 23_000, 3100, 12_100), leg('f_leg2', 20_020, 22_990, 3000, 12_000),
];

/** The flow records in file order (by record time). */
export function roundsRecords(): FlowRecord[] {
  return ROUNDS_FLOWS.flatMap(records).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

export const ROUNDS_T0 = T0;

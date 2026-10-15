/**
 * glove rounds 1–10 in the network views: llm-auth's two-hop model call, the
 * github and ssh relays (a `--lan-only` refusal among them), and `web_download`.
 * Hand-made destinations shaped after the server's `netobs/testing/rounds.ts`;
 * replace with glove's netobs-v3 scenarios once they exist.
 */
import { describe, expect, it } from 'vitest';
import { isMappable, unknownLocation } from './net-geo.js';
import { GROUP_GUARD, GROUP_LOCAL, buildTable, guardReason, type TableOptions, type TableRow } from './net-table.js';
import { layoutTopology, pathHops, type Topology } from './net-topology.js';
import { traceAxis, traceRows } from './net-trace.js';
import { dest, flow, rulesView, sessionData } from './net-test-fixtures.js';
import type { DestinationAggregate, FlowFlags, NetService, NetSessionFile, TraceCall, TraceView } from './netobs-types.js';
import type { NetSessionData } from './net-state.js';

const ID = 'pi-search-0f1a2b';
const G = `glove-${ID}`;
const SERVICES: NetService[] = [
  { service: 'llm', listen: `${G}-llm:8080`, observed: true, mode: 'tcp', tool: 'llm', scope: 'cloud', client: 'harness', harness: true, upstream: `tcp:${G}-llm-auth:8080` },
  { service: 'llm-upstream', listen: `${G}-llm-upstream:443`, observed: true, mode: 'tcp', tool: 'llm', scope: 'cloud', client: 'llm', harness: false, upstream: 'tcp:api.anthropic.com:443' },
  { service: 'webdownload-mcp', listen: `${G}-webdownload-mcp:8000`, observed: true, mode: 'tcp', tool: 'web_download', scope: 'local', client: 'harness', harness: true },
  { service: 'webdownload-egress', listen: `${G}-webdownload-egress:8888`, observed: true, mode: 'http-proxy', tool: 'web_download', client: 'webfetch', harness: false, route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' } },
  { service: 'github-egress', listen: `${G}-github-egress:8888`, observed: true, mode: 'http-proxy', tool: 'gh', client: 'github', harness: false, route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' } },
  { service: 'ssh-build', listen: `${G}-ssh-build:22`, observed: true, mode: 'tcp', tool: 'ssh', scope: 'lan', client: 'ssh', harness: false, upstream: 'tcp:build.lan:22' },
  { service: 'ssh-db', listen: `${G}-ssh-db:22`, observed: true, mode: 'tcp', tool: 'ssh', scope: 'lan', client: 'ssh', harness: false, upstream: 'tcp:db.example.com:22' },
];
const SESSION: NetSessionFile = {
  v: 1, type: 'session', env: ID, session: ID, harness: 'pi', gate: '0.3.0', record: 'metadata', resolve: 'in-tunnel',
  resolver: null, exit_identity: 'none', upstream_kind: 'vpn', rendered_at: null, services: SERVICES,
};

const flags = (scope: FlowFlags['scope'], over: Partial<FlowFlags> = {}): FlowFlags =>
  ({ scope, unresolved: false, noHost: false, cleartext: false, fanout: false, hop: false, ...over });
const via = (service: string, tool: string, client: string) => ({ services: [service], tools: [tool], clients: [client] });
const GEO = { lat: 37.77, lon: -122.42, city: 'San Francisco', country: 'United States', countryCode: 'US' };

function dests(): DestinationAggregate[] {
  return [
    dest(`${G}-llm-auth:8080`, { ...via('llm', 'llm', 'harness'), port: 8080, scope: 'cloud', flags: flags('cloud', { hop: true }), bytesUp: 5200, bytesDown: 21_200, geo: GEO }),
    dest('api.anthropic.com:443', { ...via('llm-upstream', 'llm', 'llm'), scope: 'cloud', flags: flags('cloud'), bytesUp: 5000, bytesDown: 21_000, geo: GEO }),
    dest(`${G}-fetcher:8000`, { ...via('webdownload-mcp', 'web_download', 'harness'), port: 8000, scope: 'local', flags: flags('local'), bytesUp: 400, bytesDown: 300 }),
    dest('arxiv.org:443', { ...via('webdownload-egress', 'web_download', 'webfetch'), bytesUp: 900, bytesDown: 2_400_000 }),
    dest('api.github.com:443', { ...via('github-egress', 'gh', 'github'), groupKey: 'github.com', bytesUp: 700, bytesDown: 5200 }),
    dest('build.lan:22', { ...via('ssh-build', 'ssh', 'ssh'), port: 22, scope: 'lan', flags: flags('lan'), bytesUp: 3000, bytesDown: 4000 }),
    dest('db.example.com:22', { ...via('ssh-db', 'ssh', 'ssh'), groupKey: 'example.com', port: 22, scope: 'lan', flags: flags('lan'), state: 'guard', rule: 'lan-only', blocked: 1, blockedBy: { 'lan-only': 1 } }),
  ];
}

function data(): NetSessionData {
  return sessionData({ route: { kind: 'vpn', verified: false, exitIdentityOff: true, upstreamHealthy: true } }, {
    token: ID, session: SESSION, rules: rulesView(), destinations: new Map(dests().map((d) => [d.key, d])),
  });
}

const node = (t: Topology, id: string) => {
  const n = t.nodes.find((x) => x.id === id);
  expect(n, id).toBeDefined();
  return n!;
};

describe('Topology', () => {
  const t = layoutTopology(data(), 1400, 780);

  it('draws llm-upstream as the model call\'s second leg, not as a sidecar\'s fan-out', () => {
    expect(node(t, 'svc:llm-upstream')).toMatchObject({ tone: 'plain' });
    expect(node(t, 'svc:llm-upstream').lines[0].text).toBe('llm-auth → provider');
    // Not reachable from the sandbox: llm-auth dials it.
    expect(t.bands.some((b) => b.id === 'sandbox>svc:llm-upstream')).toBe(false);
    expect(t.bands.find((b) => b.id === 'svc:llm>svc:llm-upstream:hop')).toMatchObject({ kind: 'local', label: { text: 'via llm-auth' } });
    // The provider leaves by the llm link; the hop's sidecar is no destination of its own.
    expect(t.bands.some((b) => b.id === 'route:llm>dest:api.anthropic.com:443')).toBe(true);
    expect(t.nodes.some((n) => n.id === `dest:${G}-llm-auth:8080`)).toBe(false);
  });

  it('follows a provider\'s path through llm-auth', () => {
    const p = pathHops(data(), 'api.anthropic.com')!;
    expect(p.hops.map((h) => [h.id, h.title])).toEqual([
      ['sandbox', `${ID} sandbox`], ['service', 'llm service'], ['sidecar', 'llm-auth'], ['upstream', 'llm-upstream service'],
      ['policy', 'Policy'], ['route', 'LLM link'], ['dest', 'api.anthropic.com'],
    ]);
  });

  it('links each egress to its own trigger: a download is not a fetch', () => {
    const triggers = t.bands.filter((b) => b.kind === 'trigger').map((b) => [b.from, b.to]);
    expect(triggers).toEqual([['svc:webdownload-mcp', 'svc:webdownload-egress']]);
    expect(pathHops(data(), 'arxiv.org')!.hops[0]).toMatchObject({ title: 'Web fetcher (not the harness)', detail: 'page fetch or file download' });
    expect(pathHops(data(), 'api.github.com')!.hops[0]).toMatchObject({ title: 'GitHub relay (not the harness)' });
  });

  it('with glove\'s `next` (round 13), links a sidecar hop to its egress by `next`, not by label', () => {
    const withNext = data();
    withNext.session = { ...SESSION, services: SERVICES.map((s) => ({
      ...s,
      next: s.service === 'llm' ? ['llm-upstream'] : s.service === 'webdownload-mcp' ? ['webdownload-egress'] : [],
    })) };
    const key = `${G}-fetcher:8000`;
    withNext.destinations = new Map([...withNext.destinations].map(([k, d]) => [k, k === key ? { ...d, flags: { ...d.flags, hop: true } } : d]));
    const n = layoutTopology(withNext, 1400, 780);
    expect(n.bands.find((b) => b.id === 'svc:webdownload-mcp>svc:webdownload-egress:hop')).toMatchObject({ kind: 'local', label: { text: 'via fetcher' } });
    expect(n.bands.some((b) => b.kind === 'trigger')).toBe(false);
    expect(n.nodes.some((x) => x.id === `dest:${key}`)).toBe(false);
    // The selected path agrees: it starts at the harness's hop and goes through the fetcher.
    expect(pathHops(withNext, 'arxiv.org')!.hops.slice(0, 4).map((h) => [h.id, h.title])).toEqual([
      ['sandbox', `${ID} sandbox`], ['service', 'webdownload-mcp service'], ['sidecar', 'fetcher'], ['upstream', 'webdownload-egress service'],
    ]);
    expect(pathHops(withNext, 'arxiv.org')!.hops[2].detail).toBe('page fetch or file download');
  });

  it('links an egress once when its `next` comes from a service the sandbox does not dial', () => {
    // A fan-out service is drawn, so its hop band is; the label trigger must then stand down.
    const withNext = data();
    withNext.session = { ...SESSION, services: SERVICES.map((s) => ({ ...s, next: s.service === 'github-egress' ? ['webdownload-egress'] : [] })) };
    const n = layoutTopology(withNext, 1400, 780);
    expect(n.bands.some((b) => b.id === 'svc:github-egress>svc:webdownload-egress:hop')).toBe(true);
    expect(n.bands.filter((b) => b.to === 'svc:webdownload-egress' && (b.kind === 'trigger' || b.id.endsWith(':hop')))).toHaveLength(1);
  });

  it('routes an ssh host as a LAN link, never the llm link or the tunnel', () => {
    expect(t.bands.some((b) => b.id === 'route:local>dest:build.lan:22')).toBe(true);
    expect(node(t, 'route:llm').hosts).toEqual(['api.anthropic.com']);
    const p = pathHops(data(), 'build.lan')!;
    expect(p.hops[0].title).toBe('SSH relay (not the harness)');
    expect(p.hops.find((h) => h.id === 'route')).toMatchObject({ title: 'LAN link', status: expect.stringContaining('never tunnelled') });
  });

  it('ends a lan-only refusal at the wall as glove\'s guard', () => {
    expect(t.wall.labels.map((l) => [l.kind, l.sub])).toEqual([['guard', 'LAN name resolved to a public address']]);
  });
});

describe('the destination table', () => {
  const opts = (over: Partial<TableOptions> = {}): TableOptions => ({
    groupBy: 'route', sortBy: 'recent', filter: 'all', text: '', toggled: new Set(), now: 0, ...over,
  });
  const row = (rows: TableRow[], label: string) => rows.find((r) => r.label === label);

  it('names a LAN host by its tool, and the llm hop as a local link', () => {
    const rows = buildTable(data(), opts({ toggled: new Set([GROUP_LOCAL]) })).rows;
    expect(row(rows, 'LAN · SSH')).toBeDefined();
    expect(row(rows, 'cloud · LLM')).toMatchObject({ members: [expect.objectContaining({ host: 'api.anthropic.com' })] });
    expect(row(rows, `${G}-llm-auth:8080`)).toMatchObject({ depth: 1, route: { text: 'local · hop' } });
    expect(rows.find((r) => r.key === GROUP_LOCAL)!.sublabel).toBe('LLM · Web download');
  });

  it('says why glove refused a lan-only host', () => {
    const rows = buildTable(data(), opts()).rows;
    expect(rows.find((r) => r.key === GROUP_GUARD)).toBeDefined();
    expect(row(rows, 'db.example.com:22')).toMatchObject({
      sublabel: 'LAN name resolved to a public address', toggle: 'locked', state: { text: 'refused · LAN name resolved to a public address' },
    });
    expect(guardReason({ host: 'db.example.com', rule: 'builtin:lan-only' })).toBe('LAN name resolved to a public address');
  });
});

describe('the map', () => {
  it('never places the hop to llm-auth, even with a location', () => {
    const [hop, provider] = dests();
    expect([isMappable(hop), isMappable(provider)]).toEqual([false, true]);
    expect(unknownLocation([{ ...hop, geo: null }])).toEqual([]);
  });
});

describe('Trace rows', () => {
  const T = 1_000_000;
  const closed = (id: string, tOpen: number, over: Parameters<typeof flow>[1] = {}) =>
    flow(id, { phase: 'close', tOpen, tClose: tOpen + 3000, lastT: tOpen + 3000, state: 'finished', closeReason: 'eof', ...over });
  const call: TraceCall = {
    eventId: 'c1', sessionId: 's1', toolName: 'web_download', kind: 'fetch', label: 'https://arxiv.org/pdf/1', targets: [{ host: 'arxiv.org', port: null }],
    redacted: false, start: T + 5000, end: T + 9000, timing: 'exact', failed: false, relay: null, nested: [],
    downloads: [{ path: '/work/downloads/1.pdf', bytes: 2_400_000, sha256: 'a'.repeat(64), contentType: 'application/pdf', finalUrl: null }],
  };
  const view: TraceView = {
    token: ID, sessionIds: ['s1'], nav: { index: 0, count: 1, prev: null, next: null },
    turn: { sessionId: 's1', promptEventId: 'p1', responseEventId: null, index: 0, startedAt: T, promptText: 'x', toolCallCount: 1 },
    window: { from: T, to: T + 60_000 },
    items: [
      { kind: 'llm', flowId: 'leg', hopIds: ['hop'] },
      { kind: 'call', call, flowIds: [], fanoutIds: [], openIds: [] },
    ],
    unattributed: [],
    flows: [
      closed('hop', T, { service: 'llm', tool: 'llm', scope: 'cloud', bytes: { up: 2100, down: 9100 }, flags: flags('cloud', { hop: true }), dest: { host: `${G}-llm-auth`, port: 8080, ip: null, resolution: 'disabled' } }),
      closed('leg', T + 30, { service: 'llm-upstream', tool: 'llm', scope: 'cloud', bytes: { up: 2000, down: 9000 }, flags: flags('cloud'), dest: { host: 'api.anthropic.com', port: 443, ip: null, resolution: 'disabled' } }),
    ],
    counts: { calls: 1, flows: 2, refused: 0, blocked: 0, bytesUp: 2000, bytesDown: 9000 },
  };
  const axis = traceAxis(view, T + 60_000);

  it('shows one row per model request, counted once, with both legs behind it', () => {
    const folded = traceRows(view, axis, { toggled: new Set(), onlyTraffic: false, now: T + 60_000 });
    expect(folded[0]).toMatchObject({ id: 'llm:leg', title: 'llm request 1', detail: 'api.anthropic.com', bytes: 11_000, expandable: true, expanded: false });
    expect(folded[0].outcome!.text).toBe('cloud · 3.0 s · through llm-auth');
    const open = traceRows(view, axis, { toggled: new Set(['llm:leg']), onlyTraffic: false, now: T + 60_000 });
    expect(open.slice(1, 3).map((r) => [r.id, r.bar?.tone])).toEqual([['flow:hop', 'local'], ['flow:leg', 'local']]);
  });

  it('says what a download saved', () => {
    const rows = traceRows(view, axis, { toggled: new Set(), onlyTraffic: false, now: T + 60_000 });
    expect(rows.find((r) => r.id === 'call:c1')!.outcome).toMatchObject({ text: 'saved 1.pdf · 2.4 MB' });
  });
});

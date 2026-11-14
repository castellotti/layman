import { describe, expect, it } from 'vitest';
import { exitRing, gateLabel, gloveMap, glovePulses, gloveStations, MAX_GATES, placeCalls } from './activity-glove.js';
import { stationSpecs } from './activity-view.js';
import { reduceBoard } from './activity-board.js';
import { dest } from './net-test-fixtures.js';
import type { GatesView, NetService } from './netobs-types.js';
import type { TimelineEvent } from './types.js';
import { STATION_IDS } from './station.js';

const svc = (service: string, over: Partial<NetService> = {}): NetService => ({ service, listen: ':1', observed: true, ...over });
const hop = { scope: 'local', hop: true } as const;
const fetchCall = (id: string, type: TimelineEvent['type'], t: number, toolName = 'web_fetch'): TimelineEvent =>
  ({ id, type, timestamp: t, sessionId: 's', agentType: 'pi', data: { toolName, toolInput: { url: `https://${id}.dev` } } });
const view = (over: Partial<GatesView> = {}): GatesView => ({ services: PI_SEARCH, destinations: [], calls: [], loose: [], exit: null, route: null, ...over });

/** pi-search as glove renders it: the model's link, search through SearXNG, a fetch proxy, a browser. */
const PI_SEARCH: NetService[] = [
  svc('llm', { tool: 'llm', scope: 'lan', next: ['llm-upstream'] }),
  svc('llm-upstream', { tool: 'llm', harness: false }),
  svc('search', { tool: 'web_search', next: ['searxng-egress'] }),
  svc('searxng-egress', { client: 'searxng', tool: 'search-engine-fanout', harness: false }),
  svc('proxy', { tool: 'web_fetch' }),
  svc('browser', { tool: 'browser', next: ['browser-egress'] }),
  svc('browser-egress', { client: 'playwright', harness: false }),
  svc('ocr', { tool: 'ocr', observed: false }),
];

describe('gloveStations', () => {
  it("makes a station of each service the sandbox reaches itself, in glove's order, but not the model's link", () => {
    const g = gloveStations(PI_SEARCH, []);
    expect(g.gates.map((s) => [s.id, s.label])).toEqual([['gate:search', 'Web search'], ['gate:proxy', 'Web fetch']]);
  });

  it('wears a station by the bytes of its own gate and of the gates it goes on through', () => {
    const g = gloveStations(PI_SEARCH, [
      dest('searx-hop:8080', { services: ['search'], bytesUp: 999, bytesDown: 999, flags: { ...dest('x').flags, ...hop } }),
      dest('duckduckgo.com:443', { services: ['searxng-egress'], bytesUp: 100, bytesDown: 900, flows: 3 }),
      dest('arxiv.org:443', { services: ['proxy'], bytesUp: 10, bytesDown: 5000, flows: 2, blocked: 1 }),
      dest('api.openai.com:443', { services: ['llm-upstream'], bytesUp: 1e6, bytesDown: 1e6 }),
    ]);
    // The hop to SearXNG is counted once, at the egress gate; the model's bytes are no gate's.
    expect(g.gates.map((s) => [s.service, s.bytes, s.flows, s.blocked])).toEqual([['search', 1000, 3, 0], ['proxy', 5010, 2, 1]]);
  });

  it('counts a destination several stations reached at each of them, never split by a guess', () => {
    const g = gloveStations(PI_SEARCH, [dest('arxiv.org:443', { services: ['searxng-egress', 'proxy'], bytesUp: 0, bytesDown: 700, flows: 2 })]);
    expect(g.gates.map((s) => [s.service, s.bytes])).toEqual([['search', 700], ['proxy', 700]]);
  });

  it("keeps a sandbox service's own bytes when another, declared before it, goes on through it", () => {
    const g = gloveStations([
      svc('webfetch-mcp', { tool: 'web_fetch_mcp', next: ['proxy'] }),
      svc('proxy', { tool: 'web_fetch' }),
    ], [dest('arxiv.org:443', { services: ['proxy'], bytesUp: 0, bytesDown: 50 })]);
    expect(g.gates.map((s) => [s.service, s.bytes])).toEqual([['webfetch-mcp', 0], ['proxy', 50]]);
  });

  it("counts a gate's untunnelled flows by isUntunnelled: a known VPN route is not one", () => {
    const direct = [svc('proxy', { tool: 'web_fetch', route: { kind: 'direct' } as NetService['route'] })];
    const g = gloveStations(direct, [
      dest('a.dev:443', { services: ['proxy'], scope: 'direct', flows: 2 }),
      dest('corp.example:443', { services: ['proxy'], scope: 'direct', flows: 5, flags: { ...dest('x').flags, vpn: 'listed' } }),
    ]);
    expect(g.gates[0]).toMatchObject({ route: 'direct', flows: 7, untunnelled: 2 });
  });

  it('makes one station of services with the same name, and folds the quietest past the most it shows', () => {
    const same = gloveStations([svc('search', { tool: 'web_search' }), svc('search-mcp', { tool: 'web_search' })],
      [dest('a.dev:443', { services: ['search-mcp'], bytesUp: 0, bytesDown: 9 })]);
    expect(same.gates).toMatchObject([{ id: 'gate:search', label: 'Web search', bytes: 9 }]);
    const many = Array.from({ length: MAX_GATES + 2 }, (_, i) => svc(`s${i}`));
    const g = gloveStations(many, many.map((s, i) => dest(`h${i}:443`, { services: [s.service], bytesUp: 0, bytesDown: i * 10 })));
    expect(g.gates).toHaveLength(MAX_GATES);
    expect(g.gates.at(-1)).toMatchObject({ id: 'gate:*', label: 'Other gates', bytes: 0 + 10 + 20 });
  });

  it("gives a browser service's bytes to the Browser station rather than a station of its own", () => {
    const g = gloveStations(PI_SEARCH, [dest('example.com:443', { services: ['browser-egress'], bytesUp: 40, bytesDown: 60 })]);
    expect(g.browserBytes).toBe(100);
    expect(g.gates.some((s) => s.service === 'browser')).toBe(false);
  });

  it("finds a consumer's owner by its trigger when glove declared no `next` (a glove from before it)", () => {
    const old = [svc('search', { tool: 'web_search' }), svc('searxng-egress', { client: 'searxng', harness: false })];
    const g = gloveStations(old, [dest('bing.com:443', { services: ['searxng-egress'], bytesUp: 1, bytesDown: 9 })]);
    expect(g.gates).toMatchObject([{ service: 'search', bytes: 10 }]);
  });

  it('colours a gate by the route its traffic leaves by, not the local hop into its sidecar', () => {
    const g = gloveStations([
      svc('search', { tool: 'web_search', mode: 'tcp', next: ['searxng-egress'] }),
      svc('searxng-egress', { client: 'searxng', harness: false }),
    ], []);
    expect(g.gates[0].route).toBe('tunnel');
  });

  it("names a gate by its tool, else its client's name, else glove's service name", () => {
    expect(gateLabel(svc('gh', { tool: 'gh' }))).toBe('GitHub');
    expect(gateLabel(svc('x', { client: 'webfetch' }))).toBe('Web fetcher');
    expect(gateLabel(svc('mystery'))).toBe('mystery');
  });
});

describe('stationSpecs', () => {
  it("is Layman's own stations for a session behind no gate, worn by their counts", () => {
    const board = reduceBoard([{ id: 'e', type: 'tool_call_completed', timestamp: 1, sessionId: 's', agentType: 'pi', data: { toolName: 'web_fetch', toolInput: { url: 'https://a.dev' }, completedAt: 2 } }]);
    const specs = stationSpecs(board, null);
    expect(specs.map((s) => s.id)).toEqual(STATION_IDS);
    expect(specs.find((s) => s.id === 'network')).toMatchObject({ amount: '1', glyph: 'network' });
  });

  it('shows the gates after Network for a gloved session, worn and labelled by bytes', () => {
    const glove = gloveStations(PI_SEARCH, [dest('arxiv.org:443', { services: ['proxy'], bytesUp: 0, bytesDown: 2_500_000, flows: 4 })]);
    const board = reduceBoard([{ id: 'e', type: 'tool_call_completed', timestamp: 1, sessionId: 's', agentType: 'pi', data: { toolName: 'web_fetch', toolInput: { url: 'https://a.dev' }, completedAt: 2 } }]);
    const specs = stationSpecs(board, glove);
    // Network stays where the session's calls land; the gates follow it, so the person stays at the top.
    const ids = specs.map((s) => s.id);
    const at = ids.indexOf('network');
    expect(ids.slice(at, at + 3)).toEqual(['network', 'gate:search', 'gate:proxy']);
    expect(specs[at]).toMatchObject({ amount: '1' });
    const proxy = specs.find((s) => s.id === 'gate:proxy')!;
    expect(proxy).toMatchObject({ label: 'Web fetch', amount: '2.5 MB', color: 'var(--net-tunnel)', glyph: 'network' });
    expect(proxy.wear).toBeGreaterThan(0.6);
    expect(specs.find((s) => s.id === 'gate:search')).toMatchObject({ amount: null, wear: 0 });
  });

  it('shows a gate whose every connection was refused by its refusals, not as unused', () => {
    const glove = gloveStations(PI_SEARCH, [dest('evil.dev:443', { services: ['proxy'], bytesUp: 0, bytesDown: 0, flows: 20, blocked: 20 })]);
    expect(stationSpecs(reduceBoard([]), glove).find((s) => s.id === 'gate:proxy')).toMatchObject({ amount: '20 refused' });
  });

  it("drops Network once every network call is on a gate, and gives a gate its calls' runs, faults and glow", () => {
    const glove = gloveStations(PI_SEARCH, []);
    const board = reduceBoard([
      fetchCall('a', 'tool_call_approved', 10),
      fetchCall('b', 'tool_call_failed', 20),
    ], { place: () => 'gate:proxy' });
    const specs = stationSpecs(board, glove);
    expect(specs.map((s) => s.id)).not.toContain('network');
    expect(specs.find((s) => s.id === 'gate:proxy')).toMatchObject({ runs: 1, faults: 1, lastStart: 20, amount: '2' });
    // A call no gate took keeps Network on the ring.
    const left = stationSpecs(reduceBoard([fetchCall('c', 'tool_call_completed', 30)]), glove);
    expect(left.map((s) => s.id)).toContain('network');
  });

  it('paints a direct gate red only for untunnelled flows: known VPN routes are local, none yet is muted', () => {
    const color = (untunnelled: number, flows: number) => stationSpecs(reduceBoard([]), {
      browserBytes: 0, stationOf: new Map(), toolStation: new Map(), untunnelled: 0, gates: [{ id: 'gate:p', service: 'p', label: 'P', route: 'direct', bytes: 1, flows, blocked: 0, untunnelled }],
    }).find((s) => s.id === 'gate:p')!.color;
    expect(color(1, 3)).toBe('var(--error)');
    expect(color(0, 3)).toBe('var(--net-local)');
    expect(color(0, 0)).toBe('var(--text-muted)');
  });
});

describe('placeCalls', () => {
  it("puts a network call on its join's gate, else on its tool's gate, else leaves it on Network", () => {
    const place = placeCalls(gloveMap(view({ calls: [{ eventId: 'j', services: ['searxng-egress'], refused: 0, egress: 3 }] })));
    expect(place(fetchCall('j', 'tool_call_completed', 1, 'bash'), 'network')).toBe('gate:search');
    expect(place(fetchCall('t', 'tool_call_completed', 1, 'WebFetch'), 'network')).toBe('gate:proxy');
    expect(place(fetchCall('u', 'tool_call_completed', 1, 'bash'), 'network')).toBeNull();
    // A shell command that downloads (an install) stays Shell's.
    expect(place(fetchCall('j', 'tool_call_completed', 1, 'bash'), 'shell')).toBeNull();
  });
});

describe('glovePulses', () => {
  it('reds a call with a refused connection, sends Tool egress hollow along its gate, and draws loose flows hollow', () => {
    const g = gloveMap(view({
      calls: [{ eventId: 'j', services: ['searxng-egress'], refused: 1, egress: 2 }],
      loose: [{ service: 'proxy', t: 950, refused: true, egress: false }, { service: 'nowhere', t: 950, refused: false, egress: false }],
    }));
    const board = reduceBoard([fetchCall('j', 'tool_call_completed', 900, 'web_search')], { place: placeCalls(g) });
    const { extra, refused } = glovePulses(g, board, 1000, 900);
    expect([...refused]).toEqual(['j']);
    expect(extra.map((p) => [p.station, p.hollow, p.bad])).toEqual([['gate:search', true, false], ['gate:proxy', true, true]]);
  });
});

describe('glovePulses, late reads', () => {
  it('draws a loose flow the poll delivers seconds late, replayed from its start, and not one older than that', () => {
    const g = gloveMap(view({ loose: [{ service: 'proxy', t: 1000, refused: false, egress: false }, { service: 'proxy', t: 0, refused: false, egress: false }] }));
    const { extra } = glovePulses(g, reduceBoard([], {}), 6000, 900);
    expect(extra.map((p) => p.age)).toEqual([0, 0]);
    expect(glovePulses(g, reduceBoard([], {}), 30000, 900).extra).toEqual([]);
  });
});

describe('exitRing', () => {
  it('raises the alarm only for untunnelled flows, and says where a verified tunnel leaves', () => {
    const exit = { kind: 'vpn', country: 'Switzerland', city: null, healthy: true };
    expect(exitRing(gloveMap(view({ exit, route: { kind: 'vpn', verified: true } })))).toEqual({ tone: 'tunnel', words: 'exit Switzerland · vpn', alarm: null });
    expect(exitRing(gloveMap(view({ exit, route: { kind: 'vpn', verified: false } }))).tone).toBe('unverified');
    // A direct route whose traffic all rode a known VPN route is local, not an alarm.
    const vpn = dest('corp:443', { services: ['proxy'], scope: 'direct', flags: { ...dest('x').flags, vpn: 'corporate' } });
    expect(exitRing(gloveMap(view({ route: { kind: 'direct', verified: false }, destinations: [vpn] })))).toMatchObject({ tone: 'local', alarm: null });
    const leak = dest('a.dev:443', { services: ['proxy'], scope: 'direct', flows: 2 });
    expect(exitRing(gloveMap(view({ route: { kind: 'direct', verified: false }, destinations: [leak] })))).toMatchObject({ tone: 'alarm', alarm: '2 untunnelled connections' });
  });
});

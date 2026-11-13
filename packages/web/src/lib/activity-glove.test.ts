import { describe, expect, it } from 'vitest';
import { gateLabel, gloveStations } from './activity-glove.js';
import { stationSpecs } from './activity-view.js';
import { reduceBoard } from './activity-board.js';
import { dest } from './net-test-fixtures.js';
import type { NetService } from './netobs-types.js';
import { STATION_IDS } from './station.js';

const svc = (service: string, over: Partial<NetService> = {}): NetService => ({ service, listen: ':1', observed: true, ...over });
const hop = { scope: 'local', hop: true } as const;

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

  it('shows the gates, worn and labelled by bytes, in place of Network for a gloved session', () => {
    const glove = gloveStations(PI_SEARCH, [dest('arxiv.org:443', { services: ['proxy'], bytesUp: 0, bytesDown: 2_500_000, flows: 4 })]);
    const specs = stationSpecs(reduceBoard([]), glove);
    // The gates stand where Network was, so the person stays at the top and the network across.
    const ids = specs.map((s) => s.id);
    expect(ids).not.toContain('network');
    expect(ids.slice(STATION_IDS.indexOf('network'), STATION_IDS.indexOf('network') + 2)).toEqual(['gate:search', 'gate:proxy']);
    const proxy = specs.find((s) => s.id === 'gate:proxy')!;
    expect(proxy).toMatchObject({ label: 'Web fetch', amount: '2.5 MB', color: 'var(--net-tunnel)', glyph: 'network' });
    expect(proxy.wear).toBeGreaterThan(0.6);
    expect(specs.find((s) => s.id === 'gate:search')).toMatchObject({ amount: null, wear: 0 });
  });
});

import { describe, expect, it } from 'vitest';
import {
  bandPath, bandWidth, countLabel, exitSourceHost, layoutTopology, outcomeOf, pathHops, spread, topologyServices, upstreamHost, MIN_WIDTH,
  type Topology,
} from './net-topology.js';
import { dest, rulesView, sessionData } from './net-test-fixtures.js';
import type { DestinationAggregate, NetSessionFile } from './netobs-types.js';
import type { NetSessionData } from './net-state.js';

/** glove's fixture session.json (packages/server/src/netobs/__fixtures__/session.json). */
const SESSION: NetSessionFile = {
  v: 1, type: 'session', env: 'pi-search', session: 'pi-search', harness: 'pi', gate: '0.1.0', record: 'metadata', resolve: 'in-tunnel',
  resolver: 'dns://gluetun:53', exit_identity: 'via-proxy:https://am.i.mullvad.net/json', upstream_kind: 'vpn', rendered_at: null,
  services: [
    { service: 'llm', listen: 'glove-pi-search-llm:8080', observed: true, mode: 'tcp', tool: 'llm', scope: 'local', upstream: 'tcp:host.docker.internal:8080', route: { kind: 'tcp', upstream: 'tcp:host.docker.internal:8080' } },
    { service: 'search', listen: 'glove-pi-search-search:8080', observed: true, mode: 'tcp', tool: 'web_search', scope: 'local', upstream: 'tcp:searxng:8080', route: { kind: 'tcp', upstream: 'tcp:searxng:8080' } },
    { service: 'proxy', listen: 'glove-pi-search-proxy:8888', observed: true, mode: 'http-proxy', tool: 'web_fetch', scope: null, upstream: 'chain:http://egress-proxy:8888', route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' } },
    { service: 'fanout', listen: 'glove-pi-search-fanout:8899', observed: true, harness: false, mode: 'http-proxy', tool: 'search-engine-fanout', scope: null, client: 'searxng', upstream: 'chain:http://egress-proxy:8888', route: { kind: 'vpn', upstream: 'http://egress-proxy:8888' } },
    { service: 'browser', listen: 'glove-pi-search-browser:3001', observed: false },
  ],
};

const proxy = { services: ['proxy'], tools: ['web_fetch'], clients: ['harness'] };
const fan = { services: ['fanout'], tools: ['search-engine-fanout'], clients: ['searxng'], flags: { scope: 'tunnelled' as const, unresolved: false, noHost: false, cleartext: false, fanout: true } };
const local = { scope: 'local', flags: { scope: 'local' as const, unresolved: false, noHost: false, cleartext: false, fanout: false } };
const SF = { lat: 37.77, lon: -122.42, city: 'San Francisco', country: 'United States', countryCode: 'US' };

/** The fixture's destinations, as the server aggregates them. */
function fixtureDests(): DestinationAggregate[] {
  return [
    dest('169.254.169.254:80', { ...proxy, ...local, port: 80, state: 'guard', rule: 'builtin:ssrf-guard', blocked: 1, bytesUp: 39, bytesDown: 177 }),
    dest('gluetun:8000', { ...proxy, ...local, port: 8000, state: 'guard', rule: 'builtin:ssrf-guard', blocked: 1 }),
    dest('@endpoint:proxy', { ...proxy, ...local, host: null, port: null, state: 'guard', rule: 'builtin:malformed-request', blocked: 1 }),
    dest('ads.tracker.example:443', { ...proxy, state: 'user_rule', rule: 'r_01M3FIXTUREADSBLOCK00000000', blocked: 1 }),
    dest('duckduckgo.com:443', { ...proxy, state: 'broken', bytesUp: 65, bytesDown: 47 }),
    dest('llm.operator.lan:8080', { services: ['llm'], tools: ['llm'], clients: ['harness'], ...local, port: 8080, bytesUp: 1523, bytesDown: 98304 }),
    dest('en.wikipedia.org:443', { ...proxy, bytesUp: 1592, bytesDown: 163879 }),
    dest('arxiv.org:443', { ...proxy, flows: 2, bytesUp: 3121, bytesDown: 229454, state: 'active', ips: ['151.101.3.42'], geo: SF, policy: { enforced: { action: 'allow', rule: null }, written: null } }),
    dest('www.nature.com:443', { ...proxy, bytesUp: 1586, bytesDown: 163879 }),
    dest('example.org:80', { ...proxy, port: 80, bytesUp: 65, bytesDown: 163840 }),
    dest('html.duckduckgo.com:443', { ...fan, bytesUp: 1570, bytesDown: 163879 }),
    dest('search.brave.com:443', { ...fan, bytesUp: 1564, bytesDown: 163879 }),
    dest('www.mojeek.com:443', { ...fan, bytesUp: 1560, bytesDown: 163879 }),
    dest('api.qwant.com:443', { ...fan, bytesUp: 1558, bytesDown: 163879 }),
  ];
}

const RULES = rulesView({
  enforced: { v: 1, env: 'pi-search', session: 'pi-search', default: 'allow', rules: [{ id: 'r_01M3FIXTUREADSBLOCK00000000', action: 'block', match: { host: '*.tracker.example' }, note: 'ads' }] },
});

function fixture(over: Partial<NetSessionData> = {}, dests = fixtureDests()): NetSessionData {
  return sessionData({}, {
    session: SESSION, rules: RULES, destinations: new Map(dests.map((d) => [d.key, d])),
    exit: { v: 1, type: 'exit', t: 't', env: 'e', session: 'e', kind: 'vpn', ip: '195.177.93.17', country: 'Switzerland', city: null, lat: 47.36, lon: 8.54, source: 'via-proxy:https://am.i.mullvad.net/json', healthy: true },
    ...over,
  });
}

const byId = (t: Topology, id: string) => {
  const n = t.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}: ${t.nodes.map((x) => x.id).join(', ')}`);
  return n;
};
const overlaps = (a: { y: number; h: number }, b: { y: number; h: number }) => a.y < b.y + b.h && b.y < a.y + a.h;

describe('helpers', () => {
  it('spreads boxes apart in order, and back inside the bottom', () => {
    expect(spread([{ want: 100, h: 40 }, { want: 110, h: 40 }], 0, 1000, 10)).toEqual([80, 130]);
    expect(spread([{ want: 980, h: 40 }, { want: 990, h: 40 }], 0, 1000, 10)).toEqual([910, 960]);
  });
  it('widths by the square root of bytes', () => {
    expect(bandWidth(100, 100)).toBe(30);
    expect(bandWidth(25, 100)).toBe(15);
    expect(bandWidth(0, 100)).toBe(1);
    expect(bandWidth(1, 1e9)).toBe(1.5);
  });
  it('draws an S-curve between box edges', () => {
    expect(bandPath(0, 10, 100, 50)).toBe('M0.0,10.0C50.0,10.0 50.0,50.0 100.0,50.0');
  });
  it('names upstreams and exit sources without looking anything up', () => {
    expect(upstreamHost('tcp:host.docker.internal:8080')).toBe('host.docker.internal');
    expect(upstreamHost('chain:http://egress-proxy:8888', true)).toBe('egress-proxy:8888');
    expect(exitSourceHost('via-proxy:https://am.i.mullvad.net/json')).toBe('am.i.mullvad.net');
    expect(exitSourceHost('via-proxy:am.i.mullvad.net')).toBe('am.i.mullvad.net');
  });
  it('shortens big counts', () => {
    expect([999, 4980, 13601, 123456, 2_400_000].map(countLabel)).toEqual(['999', '5k', '13.6k', '123k', '2.4M']);
  });
  it('classifies how a path ends', () => {
    expect(['guard', 'user_rule', 'default_block', 'broken', 'finished', 'gate_lost'].map((state) => outcomeOf({ state: state as never })))
      .toEqual(['refused', 'refused', 'refused', 'broken', 'reached', 'reached']);
  });
});

describe('the fixture topology', () => {
  const t = layoutTopology(fixture(), 1080, 780);

  it('draws every declared service, the unobserved browser dashed with its eye', () => {
    expect(t.nodes.filter((n) => n.kind === 'service').map((n) => n.title)).toEqual(['llm', 'search', 'proxy', 'fanout', 'browser']);
    const browser = byId(t, 'svc:browser');
    expect([browser.dashed, browser.icon, browser.lines[0].text]).toEqual([true, 'eye-off', 'declared · not watched']);
    expect(byId(t, 'svc:fanout').lines.map((l) => l.text)).toEqual(['SearXNG → gate', 'not the harness']);
    expect(byId(t, 'svc:proxy').lines.map((l) => l.text)).toEqual(['http-proxy · web_fetch', '10 flows · 4 refused']);
    expect(byId(t, 'svc:llm').lines[0].text).toBe('tcp · local');
  });

  it('has the three routes, the verified exit, and the broken path', () => {
    expect(byId(t, 'route:local').lines.map((l) => l.text)).toEqual(['host.docker.internal', 'never mapped']);
    expect(byId(t, 'route:tunnel').title).toBe('VPN tunnel');
    expect(byId(t, 'route:tunnel').lines.map((l) => l.text)).toEqual(['declared: vpn', 'egress-proxy:8888', 'resolver in-tunnel', 'upstream healthy']);
    const direct = byId(t, 'route:direct');
    expect([direct.dashed, direct.icon, direct.lines[0].text]).toEqual([true, 'check', 'no traffic']);
    const exit = byId(t, 'origin:exit');
    expect([exit.title, ...exit.lines.map((l) => l.text)]).toEqual(['Switzerland', 'exit verified', '195.177.93.17', 'via am.i.mullvad.net', 'not Layman’s lookup']);
    const broken = byId(t, 'origin:broken:duckduckgo.com:443');
    expect([broken.icon, broken.title, broken.lines[0].text]).toEqual(['broken', 'duckduckgo.com', 'upstream unreachable']);
  });

  it('puts only reached destinations in the last column: local first, then the harness, then the fan-out', () => {
    expect(t.nodes.filter((n) => n.kind === 'dest').map((n) => n.title)).toEqual([
      'llm.operator.lan:8080', 'arxiv.org', 'en.wikipedia.org', 'www.nature.com', 'example.org',
      'html.duckduckgo.com', 'search.brave.com', 'www.mojeek.com', 'api.qwant.com',
    ]);
    expect(byId(t, 'dest:llm.operator.lan:8080').dashed).toBe(true);
    expect(t.folded).toBe(0);
  });

  it('ends refusals at the policy wall, one label per reason', () => {
    expect(t.wall.labels.map((l) => [l.text, l.sub, l.kind])).toEqual([
      ['glove guard · 3', 'metadata, internal, malformed', 'guard'],
      ['your rule “ads” · 1', null, 'refused'],
    ]);
    expect(t.wall.caption).toBe('default allow · 1 rule');
    const refused = t.bands.filter((b) => b.to === 'wall');
    expect(refused.map((b) => b.kind).sort()).toEqual(['guard', 'guard', 'guard', 'refused']);
    expect(refused.every((b) => b.from === 'svc:proxy')).toBe(true);
  });

  it('colours bands by route, fan-out from its own service, and links search to it', () => {
    const kind = (id: string) => t.bands.find((b) => b.id === id)?.kind;
    expect(kind('sandbox>svc:proxy')).toBe('tunnel');
    expect(kind('sandbox>svc:llm')).toBe('local');
    expect(kind('sandbox>svc:browser')).toBe('unwatched');
    expect(t.bands.some((b) => b.from === 'sandbox' && b.to === 'svc:fanout')).toBe(false);
    expect(kind('svc:fanout>route:tunnel')).toBe('fanout');
    expect(kind('route:tunnel>origin:exit:fanout')).toBe('fanout');
    expect(kind('route:tunnel>origin:broken:duckduckgo.com:443')).toBe('broken');
    expect(kind('route:local>dest:llm.operator.lan:8080')).toBe('local');
    const trigger = t.bands.find((b) => b.kind === 'trigger')!;
    expect([trigger.from, trigger.to, trigger.dashed, trigger.label?.text]).toEqual(['svc:search', 'svc:fanout', true, 'triggers']);
    // Not under a box: `proxy` sits between search and fan-out in glove's declared order.
    const { x, y } = trigger.label!;
    expect(t.nodes.filter((n) => x >= n.x && x <= n.x + n.w && y - 10 <= n.y + n.h && y >= n.y)).toEqual([]);
    expect(t.captions.map((c) => c.text)).toEqual(['662 KB via SearXNG']);
  });

  // glove's `search` scenario: the harness's web_search is a tcp flow to searxng:8080, open while
  // SearXNG's fan-out runs. glove's main fixture has no such flow, so the design's box was untested.
  it('draws the search flow as a local searxng:8080 box, beside the fan-out it triggers', () => {
    const searxng = dest('searxng:8080', { services: ['search'], tools: ['web_search'], clients: ['harness'], ...local, port: 8080, bytesUp: 420, bytesDown: 18_000 });
    const ts = layoutTopology(fixture({}, [...fixtureDests(), searxng]), 1400, 700);
    const box = ts.nodes.find((n) => n.id === 'dest:searxng:8080');
    expect([box?.title, box?.tone]).toEqual(['searxng:8080', 'local']);
    const kind = (id: string) => ts.bands.find((b) => b.id === id)?.kind;
    expect(kind('sandbox>svc:search')).toBe('local');
    expect(kind('route:local>dest:searxng:8080')).toBe('local');
    // The Local box names the first upstream and counts the rest: host.docker.internal (llm) + searxng.
    expect(ts.nodes.find((n) => n.id === 'route:local')?.lines[0].text).toBe('host.docker.internal +1');
    expect(ts.bands.find((b) => b.kind === 'trigger')).toMatchObject({ from: 'svc:search', to: 'svc:fanout' });
    const path = pathHops(fixture({}, [...fixtureDests(), searxng]), 'searxng')!;
    expect(path.hops.map((h) => [h.id, h.title])).toEqual(expect.arrayContaining([['service', 'search service'], ['dest', 'searxng:8080']]));
  });

  it('labels sandbox bands with bytes and sizes them by the square root', () => {
    const p = t.bands.find((b) => b.id === 'sandbox>svc:proxy')!;
    const l = t.bands.find((b) => b.id === 'sandbox>svc:llm')!;
    expect(p.label?.text).toBe('728 KB');
    expect(l.label?.text).toBe('99.8 KB');
    expect(p.width / l.width).toBeCloseTo(Math.sqrt(p.bytes / l.bytes), 5);
  });

  it('carries each destination host on the bands of its path', () => {
    const on = t.bands.filter((b) => b.hosts.includes('arxiv.org')).map((b) => b.id);
    expect(on).toEqual(['sandbox>svc:proxy', 'svc:proxy>route:tunnel', 'route:tunnel>origin:exit:tunnel', 'origin:exit>dest:arxiv.org:443']);
    expect(t.bands.filter((b) => b.live).every((b) => b.hosts.includes('arxiv.org'))).toBe(true);
  });

  it('leaves the bands room to bend between the right-hand columns', () => {
    for (const w of [1000, 1080, 1440]) {
      const l = layoutTopology(fixture(), w, 780);
      const x = Object.fromEntries(l.columns.map((c) => [c.id, c.x]));
      expect(x.dests - (x.origin + 140)).toBeGreaterThanOrEqual(90);
      expect(x.origin - (x.route + 130)).toBeGreaterThanOrEqual(40);
      expect(x.policy).toBeGreaterThan(x.services + 140);
      expect(x.policy).toBeLessThan(x.route);
    }
  });

  it('keeps every box inside the diagram and no two in a column overlapping', () => {
    for (const n of t.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(t.width);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.h).toBeLessThanOrEqual(t.height);
    }
    for (const col of ['services', 'route', 'origin', 'dests']) {
      const ns = t.nodes.filter((n) => n.column === col);
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) expect(overlaps(ns[i], ns[j]), `${ns[i].id} / ${ns[j].id}`).toBe(false);
    }
  });

  it('is deterministic', () => {
    expect(layoutTopology(fixture(), 1080, 780)).toEqual(t);
  });
});

describe('other sessions', () => {
  it('lays out narrow windows at the minimum width, to be scaled rather than scrolled', () => {
    expect(layoutTopology(fixture(), 600, 300).width).toBe(MIN_WIDTH);
  });

  it('says the exit is not verified, and why', () => {
    const off = layoutTopology(fixture({ gate: { ...sessionData().gate, route: { kind: 'vpn', verified: false, exitIdentityOff: true, upstreamHealthy: null } }, exit: null }), 1080, 780);
    const e = byId(off, 'origin:exit');
    expect([e.title, e.tone, ...e.lines.map((l) => l.text)]).toEqual(['Exit', 'warn', 'not verified', 'exit identity is off']);
    expect(byId(off, 'route:tunnel').lines.at(-1)?.text).toBe('upstream health unknown');
  });

  it('draws direct traffic red from the Direct route, with no exit on its way', () => {
    const d = dest('api.github.com:443', { ...proxy, scope: 'direct', flags: { scope: 'direct', unresolved: false, noHost: false, cleartext: false, fanout: false } });
    const t = layoutTopology(fixture({}, [...fixtureDests(), d]), 1080, 780);
    expect(byId(t, 'route:direct').lines[0].text).toBe('1 flow · real IP');
    expect(t.bands.find((b) => b.id === 'route:direct>dest:api.github.com:443')?.kind).toBe('direct');
    expect(t.nodes.filter((n) => n.kind === 'dest').at(-1)?.title).toBe('api.github.com');
  });

  it('folds what does not fit into one "+N more" per route, keeping the busiest', () => {
    const many = Array.from({ length: 60 }, (_, i) => dest(`h${String(i).padStart(2, '0')}.example:443`, { ...proxy, bytesDown: 1000 + i }));
    const t = layoutTopology(fixture({}, many), 1080, 500);
    const shown = t.nodes.filter((n) => n.kind === 'dest');
    const more = t.nodes.filter((n) => n.kind === 'more');
    expect(more.map((n) => n.title)).toEqual([`+${t.folded} more`]);
    expect(shown.length + t.folded).toBe(60);
    expect(shown[0].title).toBe('h59.example');
    expect(more[0].hosts).toContain('h00.example');
    for (let i = 1; i < shown.length + more.length; i++) {
      const col = [...shown, ...more];
      expect(col[i].y).toBeGreaterThanOrEqual(col[i - 1].y + col[i - 1].h);
    }
    expect(more[0].y + more[0].h).toBeLessThanOrEqual(t.height);
  });

  it('shows services seen in traffic that the gate did not declare, and works with no session.json', () => {
    const t = layoutTopology(fixture({ session: null }), 1080, 780);
    expect(t.nodes.filter((n) => n.kind === 'service').map((n) => n.title).sort()).toEqual(['fanout', 'llm', 'proxy']);
    expect(topologyServices({ session: SESSION, destinations: new Map([['x', dest('x:1', { services: ['mystery'] })]]) }).map((s) => s.service))
      .toEqual(['llm', 'search', 'proxy', 'fanout', 'browser', 'mystery']);
  });

  it('draws an empty session: the sandbox, its services, and the Direct route clear', () => {
    const t = layoutTopology(fixture({}, []), 1080, 780);
    expect(t.nodes.filter((n) => n.kind === 'dest')).toEqual([]);
    expect(t.wall.labels).toEqual([]);
    expect(byId(t, 'route:direct').icon).toBe('check');
  });
});

describe('the selected path', () => {
  it('walks sandbox → service → policy → tunnel → exit → destination, saying what is declared and what verified', () => {
    const p = pathHops(fixture(), 'arxiv.org')!;
    expect(p.hops.map((h) => [h.id, h.title, h.detail, h.status, h.evidence])).toEqual([
      ['sandbox', 'pi-search sandbox', 'pi harness', 'gate running · heartbeat 2 s', 'observed'],
      ['service', 'proxy service', 'glove-pi-search-proxy:8888', 'observed · web_fetch', 'observed'],
      ['policy', 'Policy', 'no rule matched', 'allowed by default', 'observed'],
      ['route', 'VPN tunnel', 'egress-proxy:8888', 'declared vpn · upstream healthy', 'declared'],
      ['exit', 'Exit · Switzerland', '195.177.93.17', 'verified by exit identity', 'verified'],
      ['dest', 'arxiv.org', '151.101.3.42 :443', 'San Francisco, United States · offline lookup', 'observed'],
    ]);
  });

  it('stops at the wall for a refusal', () => {
    const p = pathHops(fixture(), 'ads.tracker.example')!;
    expect(p.hops.map((h) => h.id)).toEqual(['sandbox', 'service', 'policy']);
    expect([p.hops[2].detail, p.hops[2].evidence]).toEqual(['your rule “ads”', 'refused']);
    expect(pathHops(fixture(), '169.254.169.254')!.hops[2].detail).toBe('cloud metadata');
  });

  it('stops before the exit for a broken path', () => {
    expect(pathHops(fixture(), 'duckduckgo.com')!.hops.map((h) => [h.id, h.evidence]).slice(-2)).toEqual([['route', 'declared'], ['broken', 'broken']]);
  });

  it('starts a fan-out at SearXNG, not the sandbox', () => {
    expect(pathHops(fixture(), 'www.mojeek.com')!.hops[0].title).toBe('SearXNG (not the harness)');
  });

  it('never maps a local link', () => {
    const p = pathHops(fixture(), 'llm.operator.lan')!;
    expect(p.hops.map((h) => h.id)).toEqual(['sandbox', 'service', 'policy', 'route', 'dest']);
    expect(p.hops[3]).toMatchObject({ title: 'Local link', detail: 'host.docker.internal:8080', evidence: 'declared' });
  });

  it('is null for a host this session never reached', () => {
    expect(pathHops(fixture(), 'nowhere.example')).toBeNull();
  });
});

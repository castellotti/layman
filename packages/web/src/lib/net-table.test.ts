import { describe, expect, it } from 'vitest';
import { LEGEND_BY_KEY, NET_LEGEND, NET_STATE_INFO } from './net-format.js';
import {
  GROUP_FANOUT, GROUP_GUARD, GROUP_LOCAL, buildTable, clockTime, flowLabel, guardReason, isExpanded, matchText,
  rateOf, windowRange, type TableOptions, type TableRow,
} from './net-table.js';
import type { NetSessionData } from './net-state.js';
import type { DestinationAggregate, FlowView, NetSessionFile, NetState } from './netobs-types.js';
import { dest, flow, rulesView, sessionData } from './net-test-fixtures.js';

const T = Date.parse('2026-09-23T14:14:43Z');
const LOCAL = { scope: 'local', unresolved: false, noHost: false, cleartext: false, fanout: false } as const;

/** A session shaped like the Network tab's design, with one destination per flow state. */
function ledger(): NetSessionData {
  const dests: DestinationAggregate[] = [
    dest('arxiv.org:443', { state: 'active', tools: ['web_fetch'], ips: ['151.101.3.42'], flows: 2, openFlows: 1, lastSeen: T,
      bytesUp: 3100, bytesDown: 229_000, spark: [{ t: T - 1000, up: 100, down: 380_000 }, { t: T, up: 100, down: 760_000 }] }),
    dest('en.wikipedia.org:443', { groupKey: 'wikipedia.org', state: 'finished', tools: ['web_fetch'], lastSeen: T - 5000 }),
    dest('example.org:80', { port: 80, state: 'finished', tools: ['web_fetch'], lastSeen: T - 6000,
      flags: { scope: 'tunnelled', unresolved: false, noHost: false, cleartext: true, fanout: false } }),
    dest('duckduckgo.com:443', { state: 'broken', tools: ['web_fetch'], lastSeen: T - 7000,
      flags: { scope: 'tunnelled', unresolved: true, noHost: false, cleartext: false, fanout: false } }),
    dest('search.brave.com:443', { groupKey: 'brave.com', state: 'pooled', tools: ['search-engine-fanout'], lastSeen: T - 4000,
      flags: { scope: 'tunnelled', unresolved: false, noHost: false, cleartext: false, fanout: true } }),
    dest('api.qwant.com:443', { groupKey: 'qwant.com', state: 'finished', tools: ['search-engine-fanout'], lastSeen: T - 8000,
      flags: { scope: 'tunnelled', unresolved: false, noHost: false, cleartext: false, fanout: true } }),
    dest('ads.tracker.example:443', { groupKey: 'tracker.example', state: 'user_rule', rule: 'r_ads', blocked: 1, lastSeen: T - 9000 }),
    dest('www.nature.com:443', { groupKey: 'nature.com', state: 'default_block', blocked: 1, lastSeen: T - 9500 }),
    dest('llm.operator.lan:8080', { groupKey: 'operator.lan', scope: 'local', state: 'active', tools: ['llm'], lastSeen: T, flags: LOCAL }),
    dest('169.254.169.254:80', { groupKey: '169.254.169.254', port: 80, scope: 'local', state: 'guard', rule: 'builtin:ssrf-guard', blocked: 1, lastSeen: T - 10_000, flags: LOCAL }),
    dest('@proxy', { host: null, port: null, groupKey: '@proxy', endpoint: 'glove-pi-search-proxy:8888', scope: 'local', state: 'guard',
      rule: 'builtin:malformed-request', blocked: 1, lastSeen: T - 11_000, flags: { ...LOCAL, noHost: true } }),
    dest('github.com:443', { state: 'finished', scope: 'direct', lastSeen: T - 12_000,
      flags: { scope: 'direct', unresolved: false, noHost: false, cleartext: false, fanout: false } }),
    dest('files.example.net:443', { groupKey: 'example.net', state: 'gate_shutdown', lastSeen: T - 13_000 }),
    dest('cdn.example.io:443', { groupKey: 'example.io', state: 'gate_lost', lastSeen: T - 14_000 }),
  ];
  const flows: FlowView[] = [
    flow('f_01AAAAAAAAAAAAAAAAAAAA9W4R', { tOpen: T - 2000, lastT: T, state: 'active' }),
    flow('f_01AAAAAAAAAAAAAAAAAAAA5D0J', { tOpen: T - 20_000, lastT: T - 15_000, phase: 'close', state: 'finished', closeReason: 'eof' }),
    flow('f_01BBBBBBBBBBBBBBBBBBBBBBBB', { destKey: 'duckduckgo.com:443', state: 'broken', phase: 'close', closeReason: 'upstream_unreachable' }),
    flow('f_01CCCCCCCCCCCCCCCCCCCCCCCC', { destKey: 'en.wikipedia.org:443', state: 'finished', phase: 'close', closeReason: 'eof' }),
  ];
  const session = {
    v: 1, type: 'session', env: 'pi-search', session: 'pi-search', harness: 'pi', gate: '0.1.0', record: 'metadata',
    resolve: 'in-tunnel', resolver: null, exit_identity: 'via-proxy', upstream_kind: 'vpn', rendered_at: null,
    services: [
      { service: 'proxy', listen: 'glove-pi-search-proxy:8888', observed: true },
      { service: 'browser', listen: 'glove-pi-search-browser:3001', observed: false, tool: 'browser' },
    ],
  } satisfies NetSessionFile;
  return sessionData({}, {
    session,
    destinations: new Map(dests.map((d) => [d.key, d])),
    flows: new Map(flows.map((f) => [f.id, f])),
    rules: rulesView({
      file: { v: 1, env: 'pi-search', session: 'pi-search', default: 'allow',
        rules: [{ id: 'r_ads', action: 'block', match: { host: '*.tracker.example' }, note: 'ads' }] } }),
  });
}

const opts = (over: Partial<TableOptions> = {}): TableOptions => ({
  groupBy: 'domain', sortBy: 'recent', filter: 'all', text: '', toggled: new Set(), now: T + 500, ...over,
});
const row = (rows: TableRow[], label: string) => {
  const r = rows.find((x) => x.label === label);
  expect(r, label).toBeDefined();
  return r!;
};

describe('the state legend', () => {
  it("has every row of glove's state table plus cleartext HTTP, each fully described", () => {
    expect(NET_LEGEND).toHaveLength(24);
    for (const s of NET_LEGEND) {
      for (const field of ['label', 'dataRule', 'icon', 'colourVar', 'mapTreatment', 'explanation'] as const) {
        expect(s[field], `${s.key}.${field}`).toBeTruthy();
      }
    }
    expect(new Set(NET_LEGEND.map((s) => s.key)).size).toBe(NET_LEGEND.length);
  });

  it('maps every NetState to a flow-level entry', () => {
    const states: NetState[] = ['active', 'pooled', 'finished', 'guard', 'user_rule', 'default_block', 'broken', 'gate_shutdown', 'gate_lost', 'empty'];
    for (const s of states) expect(NET_STATE_INFO[s].level, s).toBe('flow');
  });

  it('keeps the loud states loud and the guard locked', () => {
    expect(NET_LEGEND.filter((s) => s.loud).map((s) => s.key).sort()).toEqual(['direct', 'rules_rejected']);
    expect(LEGEND_BY_KEY.direct.colourVar).toBe('var(--error)');
    expect(NET_STATE_INFO.guard.toggleKind).toBe('locked');
    expect(NET_STATE_INFO.user_rule.toggleKind).toBe('block');
    expect(NET_STATE_INFO.default_block.toggleKind).toBe('default');
  });
});

describe('buildTable', () => {
  it('renders every flow state but empty (which is folded) in the table, with its legend colour', () => {
    const rows = buildTable(ledger(), opts({ toggled: new Set([GROUP_FANOUT, GROUP_LOCAL]) })).rows;
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.state.text, r.state.colourVar);
    const has = (text: string, colour: string) => expect(seen.get(text), text).toBe(colour);
    has('live · 380 KB/s', NET_STATE_INFO.active.colourVar);
    has('finished · eof', NET_STATE_INFO.finished.colourVar);
    has('finished · cleartext http', LEGEND_BY_KEY.cleartext.colourVar);
    has('path broken · upstream', NET_STATE_INFO.broken.colourVar);
    has('refused by glove guard', NET_STATE_INFO.guard.colourVar);
    has('refused · malformed request', NET_STATE_INFO.guard.colourVar);
    has('blocked · your rule “ads”', NET_STATE_INFO.user_rule.colourVar);
    has('blocked · nothing allowed it', NET_STATE_INFO.default_block.colourVar);
    has('cut · gate shut down', NET_STATE_INFO.gate_shutdown.colourVar);
    has('cut · gate went away (inferred)', NET_STATE_INFO.gate_lost.colourVar);
    has('untunnelled · finished · eof', 'var(--error)');
    has('not watched · no records', LEGEND_BY_KEY.not_watched.colourVar);
    expect([...seen.keys()].some((t) => t.startsWith('pooled · idle'))).toBe(true);
  });

  it('collapses a one-host group into the host, and keeps a registrable domain over its host', () => {
    const rows = buildTable(ledger(), opts()).rows;
    expect(row(rows, 'arxiv.org')).toMatchObject({ kind: 'host', depth: 0, sublabel: '151.101.3.42', toggle: 'allow' });
    expect(row(rows, 'wikipedia.org')).toMatchObject({ kind: 'group', sublabel: '1 host' });
  });

  it('expands a host into its flows, newest first, with abbreviated ids', () => {
    const rows = buildTable(ledger(), opts({ toggled: new Set(['host:arxiv.org:443']) })).rows;
    const i = rows.findIndex((r) => r.label === 'arxiv.org');
    expect(rows.slice(i + 1, i + 3).map((r) => [r.label, r.depth, r.state.text])).toEqual([
      ['flow f_…9W4R', 1, 'open 3 s'],
      ['flow f_…5D0J', 1, 'finished · eof'],
    ]);
  });

  it('says when a destination has more flows than were loaded', () => {
    const data = ledger();
    data.destinations.set('en.wikipedia.org:443', dest('en.wikipedia.org:443', { groupKey: 'wikipedia.org', flows: 5, lastSeen: T - 5000 }));
    const rows = buildTable(data, opts({ toggled: new Set(['domain:wikipedia.org', 'host:en.wikipedia.org:443']) })).rows;
    expect(rows.map((r) => r.label)).toContain('4 earlier flows not loaded');
  });

  it('has the fixed groups, with the guard and not-watched open by default', () => {
    const rows = buildTable(ledger(), opts()).rows;
    expect(row(rows, 'Search fan-out')).toMatchObject({ sublabel: 'via SearXNG · 2 engines', expanded: false, state: { text: 'pooled' } });
    expect(row(rows, 'Local links')).toMatchObject({ sublabel: 'LLM', route: { text: 'local' } });
    const guard = row(rows, 'Refused by glove guard');
    expect(guard).toMatchObject({ expanded: true, toggle: 'locked', route: { text: 'never left' } });
    // A refusal says why glove refused it, not ":80 cleartext": it never left.
    expect(row(rows, '169.254.169.254')).toMatchObject({ depth: 1, sublabel: 'cloud metadata' });
    expect(row(rows, 'proxy endpoint')).toMatchObject({ sublabel: 'no destination', toggle: 'locked' });
    expect(row(rows, 'browser :3001')).toMatchObject({ kind: 'unwatched', toggle: 'none', route: { text: 'unknown' } });
  });

  it('marks untunnelled rows loud, with a Direct route', () => {
    const r = row(buildTable(ledger(), opts()).rows, 'github.com');
    expect(r).toMatchObject({ loud: true, route: { text: 'Direct', colourVar: 'var(--error)' } });
  });

  it('names the user rule by its match pattern, and the toggle by kind', () => {
    const rows = buildTable(ledger(), opts()).rows;
    expect(row(rows, 'tracker.example')).toMatchObject({ sublabel: '1 host', toggle: 'block' });
    const host = buildTable(ledger(), opts({ toggled: new Set(['domain:tracker.example']) })).rows;
    expect(row(host, 'ads.tracker.example')).toMatchObject({ sublabel: '*.tracker.example', toggle: 'block' });
    expect(row(rows, 'nature.com')).toMatchObject({ toggle: 'default' });
  });

  it('says "all traffic cut" for the kill switch’s rules, not their note', () => {
    const data = ledger();
    data.destinations.set('cut.example:443', dest('cut.example:443', { state: 'user_rule', rule: 'r_layman_cut_X_1', blocked: 1, lastSeen: T }));
    expect(row(buildTable(data, opts()).rows, 'cut.example')).toMatchObject({ sublabel: null, state: { text: 'blocked · all traffic cut' } });
  });

  it('counts and applies the filter chips', () => {
    const model = buildTable(ledger(), opts());
    expect(model.counts).toEqual({ all: 14, live: 3, blocked: 4, broken: 1, local: 1 });
    const blocked = buildTable(ledger(), opts({ filter: 'blocked' }));
    expect(blocked.shown).toBe(4);
    // "Not watched" has no records to match, so it only shows unfiltered.
    expect(blocked.rows.some((r) => r.kind === 'unwatched')).toBe(false);
  });

  it('filters by text over host, IP, tool and rule note', () => {
    const shown = (text: string) => buildTable(ledger(), opts({ text })).shown;
    expect(shown('ARXIV')).toBe(1);
    expect(shown('151.101')).toBe(1);
    expect(shown('fanout')).toBe(2);
    expect(shown('ads')).toBe(1); // the note on r_ads
    expect(shown('nothing-matches')).toBe(0);
  });

  it('sorts groups by recency or by bytes', () => {
    const top = (sortBy: 'recent' | 'bytes') => buildTable(ledger(), opts({ sortBy })).rows[0].label;
    expect(top('recent')).toBe('arxiv.org');
    const data = ledger();
    data.destinations.set('github.com:443', { ...data.destinations.get('github.com:443')!, bytesDown: 9e9 });
    expect(buildTable(data, opts({ sortBy: 'bytes' })).rows[0].label).toBe('github.com');
  });

  it('groups by route and by tool', () => {
    const byRoute = buildTable(ledger(), opts({ groupBy: 'route' })).rows.filter((r) => r.depth === 0).map((r) => r.label);
    expect(byRoute).toEqual(expect.arrayContaining(['VPN', 'Direct', 'Local links', 'Refused by glove guard']));
    const byTool = buildTable(ledger(), opts({ groupBy: 'tool' })).rows.filter((r) => r.depth === 0).map((r) => r.label);
    expect(byTool).toEqual(expect.arrayContaining(['web_fetch', 'Search fan-out']));
  });

  it('lists folded empty connections only on request', () => {
    const data = ledger();
    data.flows.set('f_01EMPTYEMPTYEMPTYEMPTYEMPT', flow('f_01EMPTYEMPTYEMPTYEMPTYEMPT', {
      destKey: null, state: 'empty', phase: 'close', closeReason: 'timeout', dest: { host: null, port: null, ip: null, resolution: 'unavailable' },
    }));
    expect(buildTable(data, opts()).rows.some((r) => r.label === 'Empty connections')).toBe(false);
    const rows = buildTable(data, opts({ showEmpty: true })).rows;
    expect(row(rows, 'flow f_…EMPT')).toMatchObject({ depth: 1, state: { text: 'empty · timeout' } });
  });

  it('an empty session has no rows', () => {
    const rows = buildTable(sessionData(), opts()).rows;
    expect(rows).toEqual([]);
  });
});

describe('table helpers', () => {
  it('formats ids, clock times, guard reasons and matches', () => {
    expect(flowLabel('f_01M3FIXTURE00000000009W4R')).toBe('flow f_…9W4R');
    expect(clockTime(new Date(2026, 8, 23, 14, 4, 3).getTime())).toBe('14:04:03');
    expect(guardReason({ host: 'gluetun', rule: 'builtin:ssrf-guard' })).toBe('internal name');
    expect(guardReason({ host: '10.0.0.1', rule: 'builtin:ssrf-guard' })).toBe('private address');
    expect(matchText({ match: { ip: '10.0.0.0/8', port: 443 } })).toBe('ip 10.0.0.0/8 · port 443');
    expect(matchText({ match: {} })).toBe('everything');
  });

  it('measures a live rate over the last three seconds', () => {
    expect(rateOf([{ t: 0, up: 999, down: 0 }, { t: 9000, up: 1000, down: 2000 }], 10_000)).toBe(1000);
  });

  it('flips a group from its default expansion', () => {
    expect(isExpanded(GROUP_GUARD, new Set())).toBe(true);
    expect(isExpanded(GROUP_GUARD, new Set([GROUP_GUARD]))).toBe(false);
    expect(isExpanded('domain:x', new Set(['domain:x']))).toBe(true);
  });
});

describe('windowRange', () => {
  const heights = [30, ...Array(999).fill(28)];
  it('covers the viewport plus overscan, with spacers for the rest', () => {
    const w = windowRange(heights, 30 + 28 * 100, 280, 5);
    expect(w.start).toBe(96);
    expect(w.end).toBe(111 + 5);
    expect(w.padTop).toBe(30 + 28 * 95);
    expect(w.padTop + heights.slice(w.start, w.end).reduce((a, b) => a + b, 0) + w.padBottom)
      .toBe(heights.reduce((a, b) => a + b, 0));
  });
  it('starts at the top', () => {
    expect(windowRange(heights, 0, 100, 2)).toMatchObject({ start: 0, padTop: 0 });
  });
  it('handles an empty list and a scroll past the end', () => {
    expect(windowRange([], 0, 100)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(windowRange([28, 28], 5000, 100, 1)).toMatchObject({ end: 2, padBottom: 0 });
  });
});

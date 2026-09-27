import { describe, expect, it } from 'vitest';
import { callForFlow, defaultSelection, flowOutcome, isRowExpanded, tickLabel, traceAxis, traceRows } from './net-trace.js';
import { flow } from './net-test-fixtures.js';
import type { FlowView, TraceCall, TraceView } from './netobs-types.js';

const T = 1_000_000;
const call = (eventId: string, kind: TraceCall['kind'], label: string, start: number, over: Partial<TraceCall> = {}): TraceCall => ({
  eventId, sessionId: 's1', toolName: kind === 'search' ? 'web_search' : kind === 'fetch' ? 'web_fetch' : 'Bash', kind, label,
  targets: [], redacted: false, start, end: start + 800, timing: 'exact', failed: false, ...over,
});
const closed = (id: string, host: string | null, tOpen: number, over: Partial<FlowView> = {}) =>
  flow(id, { phase: 'close', tOpen, tClose: tOpen + 600, lastT: tOpen + 600, closeReason: 'eof', state: 'finished', dest: { host, port: 443, ip: '151.101.3.42', resolution: 'in-tunnel' }, ...over });
const FAN = { scope: 'tunnelled' as const, unresolved: false, noHost: false, cleartext: false, fanout: true };
const LOCAL = { scope: 'local' as const, unresolved: false, noHost: false, cleartext: false, fanout: false };

function view(): TraceView {
  const flows = [
    closed('llm1', 'llm.operator.lan', T + 100, { service: 'llm', flags: LOCAL }),
    closed('s', 'searxng', T + 1100, { service: 'search', flags: LOCAL }),
    closed('f1', 'html.duckduckgo.com', T + 1300, { service: 'fanout', flags: FAN }),
    closed('f2', 'search.brave.com', T + 1350, { service: 'fanout', flags: FAN }),
    closed('a', 'arxiv.org', T + 3000),
    closed('g', '169.254.169.254', T + 4000, { state: 'guard', rule: 'builtin:ssrf-guard', closeReason: 'blocked', dest: { host: '169.254.169.254', port: 80, ip: null, resolution: 'literal' } }),
    closed('ads', 'ads.tracker.example', T + 4100, { state: 'user_rule', rule: 'r_ads', closeReason: 'blocked' }),
    closed('x', 'www.nature.com', T + 5000),
  ];
  return {
    token: 'pi-search', sessionIds: ['s1'],
    turns: [{ sessionId: 's1', promptEventId: 'p1', responseEventId: 'r1', index: 2, startedAt: T, promptText: 'onion routing', toolCallCount: 4 }],
    turn: { sessionId: 's1', promptEventId: 'p1', responseEventId: 'r1', index: 2, startedAt: T, promptText: 'onion routing', toolCallCount: 4 },
    window: { from: T - 1000, to: T + 60_000 },
    items: [
      { kind: 'llm', flowId: 'llm1' },
      { kind: 'call', call: call('c1', 'search', 'history of onion routing', T + 1000), flowIds: ['s'], fanoutIds: ['f1', 'f2'], openIds: [] },
      { kind: 'call', call: call('c2', 'fetch', 'https://arxiv.org/abs/1', T + 2900), flowIds: ['a'], fanoutIds: [], openIds: [] },
      { kind: 'call', call: call('c3', 'fetch', 'http://169.254.169.254/latest/meta-data/', T + 3900), flowIds: ['g'], fanoutIds: [], openIds: [] },
      { kind: 'call', call: call('c4', 'fetch', 'https://ads.tracker.example/p.gif', T + 4050), flowIds: ['ads'], fanoutIds: [], openIds: [] },
      { kind: 'call', call: call('c5', 'other', 'ls -la', T + 4500), flowIds: [], fanoutIds: [], openIds: [] },
    ],
    unattributed: ['x'], flows,
    counts: { calls: 5, flows: 8, refused: 1, blocked: 1, bytesUp: 0, bytesDown: 0 },
  };
}

const RULES = [{ id: 'r_ads', action: 'block' as const, match: { host: '*.tracker.example' }, note: 'ads' }];

describe('the axis', () => {
  it('runs from the turn start to its last event, in round ticks', () => {
    const a = traceAxis(view(), T + 60_000);
    expect(a.t0).toBe(T);
    expect(a.span).toBe(6000);
    expect(a.ticks).toEqual([0, 2000, 4000]);
    expect(a.ticks.map(tickLabel)).toEqual(['0 s', '2 s', '4 s']);
    expect(tickLabel(90_000)).toBe('1.5 min');
  });
});

describe('rows', () => {
  const v = view();
  const axis = traceAxis(v, T + 60_000);
  const rows = traceRows(v, axis, { toggled: new Set(), onlyTraffic: false, rules: RULES, routeKind: 'vpn', now: T + 60_000 });

  it('interleaves LLM requests and calls in time order, each call over its flows', () => {
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.kind}:${r.title}`)).toEqual([
      'llm:llm request 1',
      'call:web_search', '  flow:searxng', '  fanout:fan-out · 2 engines',
      'call:web_fetch', '  flow:arxiv.org',
      'call:web_fetch', '  flow:169.254.169.254:80',
      'call:web_fetch', '  flow:ads.tracker.example',
      'call:Bash',
      'group:Unattributed', '  flow:www.nature.com',
    ]);
  });

  it('says what happened to each flow in the legend\'s terms', () => {
    const out = (title: string) => rows.find((r) => r.title === title)?.outcome?.text;
    expect(out('169.254.169.254:80')).toBe('refused by glove guard');
    expect(out('ads.tracker.example')).toBe('blocked · your rule “ads”');
    expect(out('arxiv.org')).toBe('finished · eof');
    expect(out('searxng')).toBe('local · eof');
    expect(out('web_search')).toBe('1 local + 2 fan-out');
    const noLocal = view();
    noLocal.items = noLocal.items.map((i) => (i.kind === 'call' && i.call.kind === 'search' ? { ...i, flowIds: [] } : i));
    expect(traceRows(noLocal, axis, { toggled: new Set(), onlyTraffic: false, now: T + 60_000 }).find((r) => r.title === 'web_search')?.outcome?.text).toBe('2 fan-out');
    expect(out('fan-out · 2 engines')).toBe('via SearXNG · VPN');
    expect(out('llm request 1')).toBe('local · 0.6 s');
  });

  it('places bars on the axis', () => {
    const a = rows.find((r) => r.title === 'arxiv.org')!.bar!;
    expect([a.x0, a.x1]).toEqual([0.5, 0.6]);
    expect(rows.find((r) => r.title === '169.254.169.254:80')!.bar!.refused).toBe(true);
  });

  it('folds the fan-out by default and opens it on request; calls fold the other way', () => {
    expect(isRowExpanded('fan:c1', new Set())).toBe(false);
    expect(isRowExpanded('call:c1', new Set())).toBe(true);
    const open = traceRows(v, axis, { toggled: new Set(['fan:c1', 'call:c2']), onlyTraffic: false, now: T + 60_000 });
    expect(open.filter((r) => r.depth === 2).map((r) => r.title)).toEqual(['html.duckduckgo.com', 'search.brave.com']);
    expect(open.some((r) => r.title === 'arxiv.org')).toBe(false);
  });

  it('says why a redacted fetch has no flows', () => {
    const v2 = view();
    v2.items.push({ kind: 'call', call: call('c6', 'fetch', 'http://[REDACTED]/x', T + 4600, { redacted: true }), flowIds: [], fanoutIds: [], openIds: [] });
    const r = traceRows(v2, axis, { toggled: new Set(), onlyTraffic: false, now: T + 60_000 });
    expect(r.find((x) => x.id === 'call:c6')?.outcome?.text).toBe('host redacted · not joined');
  });

  it('says a call rode a connection that was already open, rather than "no traffic seen"', () => {
    const v2 = view();
    // A second search while SearXNG's connection and two pooled engines are still open, then a fetch reusing arxiv.org.
    v2.items.push(
      { kind: 'call', call: call('c7', 'search', 'onion routing papers', T + 1200), flowIds: [], fanoutIds: [], openIds: ['s', 'f1', 'f2'] },
      { kind: 'call', call: call('c8', 'fetch', 'https://arxiv.org/pdf/1', T + 3100), flowIds: [], fanoutIds: [], openIds: ['a'] },
    );
    const r = traceRows(v2, axis, { toggled: new Set(), onlyTraffic: true, now: T + 60_000 });
    expect(r.find((x) => x.id === 'call:c7')?.outcome?.text).toBe('no new connection · searxng + 2 fan-out already open');
    expect(r.find((x) => x.id === 'call:c8')?.outcome?.text).toBe('no new connection · arxiv.org already open');
    // Not expandable: the flows stay under the call that opened them, so no row appears twice.
    expect(r.find((x) => x.id === 'call:c8')?.expandable).toBe(false);
    expect(r.filter((x) => x.id === 'flow:a')).toHaveLength(1);
  });

  it('hides calls that made no traffic when asked, never the unattributed', () => {
    const only = traceRows(v, axis, { toggled: new Set(), onlyTraffic: true, now: T + 60_000 });
    expect(only.some((r) => r.title === 'Bash')).toBe(false);
    expect(only.some((r) => r.id === 'unattributed')).toBe(true);
  });
});

describe('selection', () => {
  it('opens on the guard refusal, then a rule block, else nothing', () => {
    const v = view();
    expect(defaultSelection(v)).toBe('flow:g');
    v.flows = v.flows.map((f) => (f.id === 'g' ? { ...f, state: 'finished' } : f));
    expect(defaultSelection(v)).toBe('flow:ads');
    v.flows = v.flows.map((f) => ({ ...f, state: 'finished' }));
    expect(defaultSelection(v)).toBeNull();
  });
  it('names the call behind a flow, or none for the unattributed', () => {
    const v = view();
    expect(callForFlow(v, 'f2')?.label).toBe('history of onion routing');
    expect(callForFlow(v, 'x')).toBeNull();
  });
  it('words every refusal and failure', () => {
    const f = (over: Partial<FlowView>) => flowOutcome(closed('z', 'h', T, over)).text;
    expect(f({ state: 'default_block' })).toBe('blocked · the default');
    expect(f({ state: 'broken', closeReason: 'upstream_unreachable' })).toBe('path broken · upstream');
    expect(f({ state: 'gate_shutdown' })).toBe('cut · gate shutdown');
    expect(f({ flags: { scope: 'tunnelled', unresolved: false, noHost: false, cleartext: true, fanout: false } })).toBe('finished · cleartext');
    expect(f({ flags: { scope: 'direct', unresolved: false, noHost: false, cleartext: false, fanout: false } })).toBe('finished · untunnelled');
  });
});

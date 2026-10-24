import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSessionStore, viewModeForName, viewNameForMode, instanceUrlOf } from './sessionStore.js';
import { useNetStore } from './netStore.js';
import type { NetSessionSummary } from '../lib/netobs-types.js';

const summary = (token: string) => ({ token, live: false, firstSeen: 0, lastSeen: 0 }) as NetSessionSummary;
import { routeForState, historyModeFor } from '../hooks/useLaymanRoute.js';
import { buildPath, parsePath, VIEW_NAMES } from '../lib/layman-url.js';
import type { TimelineEvent, EventType, LaymanConfig } from '../lib/types.js';

/**
 * Inbound (hydrateFromRoute) and outbound (routeForState) are two halves of one
 * mapping, so they are tested together: the property that matters is that a
 * hydrated route survives being read back out, or a deep link decays on the
 * first re-render.
 */

let clock = 1000;
function ev(type: EventType, data: Record<string, unknown> = {}, id?: string): TimelineEvent {
  clock += 10;
  return {
    id: id ?? `${type}-${clock}`,
    type,
    timestamp: clock,
    sessionId: 'sess-1',
    agentType: 'claude-code',
    data,
  } as TimelineEvent;
}

const TURN_EVENTS: TimelineEvent[] = [
  ev('user_prompt', { prompt: 'plug the holes' }, 'p1'),
  ev('tool_call_completed', { toolName: 'Bash' }, 't1'),
  ev('agent_response', { prompt: 'all done' }, 'r1'),
];

/** Stubs the two endpoints hydrateFromRoute reaches for. */
function stubFetch(handlers: {
  events?: TimelineEvent[];
  resolve?: unknown;
  resolveStatus?: number;
}) {
  const fetchMock = vi.fn((input: string) => {
    if (input.includes('/time-metrics')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(null) } as Response);
    }
    if (input.includes('/events')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ events: handlers.events ?? [] }),
      } as Response);
    }
    if (input.includes('/api/resolve')) {
      return Promise.resolve({
        ok: (handlers.resolveStatus ?? 200) < 400,
        json: () => Promise.resolve(handlers.resolve ?? null),
      } as Response);
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useSessionStore.setState({
    viewMode: 'dashboard',
    flowchartOpen: false,
    bookmarksOpen: false,
    promptsOpen: false,
    viewingSessionId: null,
    activeSessionId: null,
    historicalEvents: [],
    events: [],
    selectedTurnPromptEventId: null,
    selectedHighlightId: null,
    routeFolderId: null,
    routeError: null,
    routeHydrating: false,
    bookmarksScrollToEventId: null,
    expandedLogEventIds: 'all',
    config: null,
    netToken: null,
    netDest: null,
    netRange: null,
    sessions: [],
    dashboardFocusedSession: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('view name ↔ view mode', () => {
  it('round-trips every name in the URL grammar', () => {
    for (const name of VIEW_NAMES) {
      expect(viewNameForMode(viewModeForName(name))).toBe(name);
    }
  });
});

describe('instanceUrlOf', () => {
  it('prefers configured publicUrl and strips trailing slashes', () => {
    expect(instanceUrlOf({ publicUrl: 'http://nyx.local:8880/' } as LaymanConfig))
      .toBe('http://nyx.local:8880');
  });

  it('falls back to the browsing origin when publicUrl is empty', () => {
    // Correct for the single-machine case and for a hub browsed over the LAN.
    // Tests run under the node environment, so the origin has to be stubbed.
    vi.stubGlobal('window', { location: { origin: 'http://nyx.local:8880' } });
    expect(instanceUrlOf({ publicUrl: '' } as LaymanConfig)).toBe('http://nyx.local:8880');
    expect(instanceUrlOf(null)).toBe('http://nyx.local:8880');
  });
});

describe('hydrateFromRoute', () => {
  it('opens a session transcript and loads its recorded events', async () => {
    stubFetch({ events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute({ kind: 'session', sessionId: 'sess-1' }, {});

    const state = useSessionStore.getState();
    expect(state.viewMode).toBe('sessions');
    expect(state.bookmarksOpen).toBe(true);
    expect(state.viewingSessionId).toBe('sess-1');
    expect(state.historicalEvents).toHaveLength(3);
    expect(state.routeError).toBeNull();
    expect(state.routeHydrating).toBe(false);
  });

  it('focuses the addressed turn and marks it for scrolling', async () => {
    stubFetch({ events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute(
      { kind: 'turn', sessionId: 'sess-1', promptEventId: 'p1' }, {},
    );

    const state = useSessionStore.getState();
    expect(state.selectedTurnPromptEventId).toBe('p1');
    expect(state.bookmarksScrollToEventId).toBe('p1');
  });

  it('canonicalises a collapsed duplicate prompt id to the surviving turn', async () => {
    // A link minted before the duplicate-collapse fix names the second copy.
    stubFetch({
      events: [
        ev('user_prompt', { prompt: 'go' }, 'dup-a'),
        ev('user_prompt', { prompt: 'go' }, 'dup-b'),
        ev('agent_response', { prompt: 'done' }, 'dup-r'),
      ],
    });

    await useSessionStore.getState().hydrateFromRoute(
      { kind: 'turn', sessionId: 'sess-1', promptEventId: 'dup-b' }, {},
    );

    expect(useSessionStore.getState().selectedTurnPromptEventId).toBe('dup-a');
    expect(useSessionStore.getState().routeError).toBeNull();
  });

  it('falls back to live in-memory events when nothing is recorded', async () => {
    // sessionRecording off: the session exists only in the live store.
    stubFetch({ events: [] });
    useSessionStore.setState({ events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute({ kind: 'session', sessionId: 'sess-1' }, {});

    expect(useSessionStore.getState().historicalEvents).toHaveLength(3);
    expect(useSessionStore.getState().routeError).toBeNull();
  });

  it('reports an unknown session against the named instance', async () => {
    stubFetch({ events: [] });
    useSessionStore.setState({ config: { publicUrl: 'http://nyx.local:8880' } as LaymanConfig });

    await useSessionStore.getState().hydrateFromRoute({ kind: 'session', sessionId: 'ghost-session' }, {});

    const { routeError, routeHydrating } = useSessionStore.getState();
    expect(routeError?.message).toContain('ghost-se');
    expect(routeError?.instanceUrl).toBe('http://nyx.local:8880');
    expect(routeHydrating).toBe(false);
  });

  it('reports a turn that is not in the session it names', async () => {
    stubFetch({ events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute(
      { kind: 'turn', sessionId: 'sess-1', promptEventId: 'not-a-prompt' }, {},
    );

    expect(useSessionStore.getState().routeError?.message).toContain('not-a-pr');
  });

  it('routes an event id into the transcript, scrolled to that event', async () => {
    stubFetch({ events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute(
      { kind: 'event', sessionId: 'sess-1', eventId: 't1' }, {},
    );

    const state = useSessionStore.getState();
    expect(state.viewMode).toBe('sessions');
    expect(state.bookmarksScrollToEventId).toBe('t1');
  });

  it('honours ?view=logs by opening the live Logs view instead', async () => {
    stubFetch({ events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute(
      { kind: 'event', sessionId: 'sess-1', eventId: 't1' }, { view: 'logs' },
    );

    const state = useSessionStore.getState();
    expect(state.viewMode).toBe('stream');
    expect(state.activeSessionId).toBe('sess-1');
    expect(state.scrollToEventId).toBe('t1');
    expect(state.logsOverride).toBe(true);
  });

  it('selects a highlight in the Prompts view', async () => {
    stubFetch({ resolve: { kind: 'highlight', id: 'h1', sessionId: 'sess-1', promptEventId: 'p1' } });

    await useSessionStore.getState().hydrateFromRoute({ kind: 'highlight', highlightId: 'h1' }, {});

    const state = useSessionStore.getState();
    expect(state.viewMode).toBe('prompts');
    expect(state.selectedHighlightId).toBe('h1');
  });

  it('opens a highlight as its underlying turn when ?view says so', async () => {
    stubFetch({
      resolve: { kind: 'highlight', id: 'h1', sessionId: 'sess-1', promptEventId: 'p1' },
      events: TURN_EVENTS,
    });

    await useSessionStore.getState().hydrateFromRoute(
      { kind: 'highlight', highlightId: 'h1' }, { view: 'sessions' },
    );

    const state = useSessionStore.getState();
    expect(state.viewMode).toBe('sessions');
    expect(state.selectedTurnPromptEventId).toBe('p1');
  });

  it('resolves a bookmark to the session it points at', async () => {
    stubFetch({ resolve: { kind: 'bookmark', id: 'b1', sessionId: 'sess-1' }, events: TURN_EVENTS });

    await useSessionStore.getState().hydrateFromRoute({ kind: 'bookmark', bookmarkId: 'b1' }, {});

    expect(useSessionStore.getState().viewingSessionId).toBe('sess-1');
  });

  it('sends a highlight folder to Prompts and a bookmark folder to Sessions', async () => {
    stubFetch({ resolve: { kind: 'highlight_folder', id: 'hf1' } });
    await useSessionStore.getState().hydrateFromRoute({ kind: 'folder', folderId: 'hf1' }, {});
    expect(useSessionStore.getState().viewMode).toBe('prompts');
    expect(useSessionStore.getState().routeFolderId).toBe('hf1');

    stubFetch({ resolve: { kind: 'folder', id: 'f1' } });
    await useSessionStore.getState().hydrateFromRoute({ kind: 'folder', folderId: 'f1' }, {});
    expect(useSessionStore.getState().viewMode).toBe('sessions');
    expect(useSessionStore.getState().routeFolderId).toBe('f1');
  });

  it('reports an id this instance cannot resolve', async () => {
    stubFetch({ resolve: null, resolveStatus: 404 });

    await useSessionStore.getState().hydrateFromRoute({ kind: 'bookmark', bookmarkId: 'nope1234' }, {});

    expect(useSessionStore.getState().routeError).not.toBeNull();
  });

  it('applies ?view to the dashboard route', async () => {
    stubFetch({});

    await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, { view: 'flow' });

    expect(useSessionStore.getState().viewMode).toBe('flowchart');
    expect(useSessionStore.getState().flowchartOpen).toBe(true);
  });
});

describe('routeForState', () => {
  it('emits the turn address while a turn is selected, the session address otherwise', () => {
    useSessionStore.setState({ viewMode: 'sessions', viewingSessionId: 'sess-1', selectedTurnPromptEventId: 'p1' });
    expect(routeForState(useSessionStore.getState()).route)
      .toEqual({ kind: 'turn', sessionId: 'sess-1', promptEventId: 'p1' });

    useSessionStore.setState({ selectedTurnPromptEventId: null });
    expect(routeForState(useSessionStore.getState()).route)
      .toEqual({ kind: 'session', sessionId: 'sess-1' });
  });

  it('emits the highlight address from the Prompts view', () => {
    useSessionStore.setState({ viewMode: 'prompts', selectedHighlightId: 'h1' });
    expect(routeForState(useSessionStore.getState()).route)
      .toEqual({ kind: 'highlight', highlightId: 'h1' });
  });

  it('emits ?view for the live views and a bare path for the dashboard', () => {
    useSessionStore.setState({ viewMode: 'stream' });
    const logs = routeForState(useSessionStore.getState());
    expect(buildPath(logs.route, logs.opts)).toBe('/?view=logs');

    useSessionStore.setState({ viewMode: 'dashboard' });
    const dashboard = routeForState(useSessionStore.getState());
    expect(buildPath(dashboard.route, dashboard.opts)).toBe('/');
  });

  it('addresses the session when Logs/Flow are showing one', () => {
    useSessionStore.setState({ viewMode: 'stream', activeSessionId: 'sess-1' });
    const logs = routeForState(useSessionStore.getState());
    expect(buildPath(logs.route, logs.opts)).toBe('/s/sess-1?view=logs');

    useSessionStore.setState({ viewMode: 'flowchart', activeSessionId: 'sess-1' });
    const flow = routeForState(useSessionStore.getState());
    expect(buildPath(flow.route, flow.opts)).toBe('/s/sess-1?view=flow');
  });

  it('emits the folder address while a folder is open', () => {
    useSessionStore.setState({ viewMode: 'sessions', routeFolderId: 'f1' });
    expect(routeForState(useSessionStore.getState()).route)
      .toEqual({ kind: 'folder', folderId: 'f1' });
  });

  it('never re-emits arrival-only options', () => {
    // ?play=1 must not be re-broadcast on unrelated state changes or a deep link
    // would re-trigger speech every render.
    useSessionStore.setState({ viewMode: 'sessions', viewingSessionId: 'sess-1', selectedTurnPromptEventId: 'p1' });
    expect(routeForState(useSessionStore.getState()).opts).toEqual({});
  });
});

describe('hydrate → read back', () => {
  it('a hydrated turn deep link rebuilds the same path', async () => {
    stubFetch({ events: TURN_EVENTS });
    const path = '/s/sess-1/t/p1';

    const parsed = parsePath(path);
    await useSessionStore.getState().hydrateFromRoute(parsed!.route, parsed!.opts);

    const { route, opts } = routeForState(useSessionStore.getState());
    expect(buildPath(route, opts)).toBe(path);
  });

  it('a hydrated Logs deep link rebuilds the same path', async () => {
    stubFetch({ events: TURN_EVENTS });
    const path = '/s/sess-1?view=logs';

    const parsed = parsePath(path);
    await useSessionStore.getState().hydrateFromRoute(parsed!.route, parsed!.opts);

    const { route, opts } = routeForState(useSessionStore.getState());
    expect(buildPath(route, opts)).toBe(path);
  });

  it('a hydrated folder deep link rebuilds the same path', async () => {
    stubFetch({ resolve: { kind: 'folder', id: 'f1' } });
    const path = '/f/f1';

    const parsed = parsePath(path);
    await useSessionStore.getState().hydrateFromRoute(parsed!.route, parsed!.opts);

    const { route, opts } = routeForState(useSessionStore.getState());
    expect(buildPath(route, opts)).toBe(path);
  });

  it('leaving a session for the dashboard drops the stale folder/turn state', async () => {
    stubFetch({ resolve: { kind: 'folder', id: 'f1' } });
    await useSessionStore.getState().hydrateFromRoute({ kind: 'folder', folderId: 'f1' }, {});
    expect(useSessionStore.getState().routeFolderId).toBe('f1');

    await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, {});

    const state = useSessionStore.getState();
    expect(state.routeFolderId).toBeNull();
    expect(state.viewingSessionId).toBeNull();
    const { route, opts } = routeForState(state);
    expect(buildPath(route, opts)).toBe('/');
  });
});

describe('network views (glove)', () => {
  const readBack = () => {
    const { route, opts } = routeForState(useSessionStore.getState());
    return buildPath(route, opts);
  };

  it.each([
    '/?view=network&glove=pi-search',
    '/?view=map&glove=pi-search&dest=arxiv.org',
    '/?view=topology&glove=pi-search-review',
    '/?view=trace&glove=pi-search',
    '/?view=topology&glove=pi-search&from=2026-10-21T00:27:03.338Z&to=2026-10-22T06:09:02.474Z',
    '/?view=map&glove=pi-search&dest=arxiv.org&from=2026-10-21T08:00:00.000Z&to=now',
  ])('a hydrated %s deep link rebuilds the same path', async (path) => {
    const parsed = parsePath(path);
    await useSessionStore.getState().hydrateFromRoute(parsed!.route, parsed!.opts);
    expect(useSessionStore.getState().viewMode).toBe(parsed!.opts.view);
    expect(readBack()).toBe(path);
  });

  it('a network URL with no glove session hydrates to "pick the default"', async () => {
    await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, { view: 'network' });
    expect(useSessionStore.getState().netToken).toBeNull();
    expect(readBack()).toBe('/?view=network');
    useSessionStore.getState().setNetToken('pi-search');
    expect(readBack()).toBe('/?view=network&glove=pi-search');
  });

  it('switching tab keeps the glove session and the selected destination', async () => {
    await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, { view: 'network', glove: 'pi-search', dest: 'arxiv.org' });
    useSessionStore.getState().setViewMode('topology');
    expect(readBack()).toBe('/?view=topology&glove=pi-search&dest=arxiv.org');
  });

  it('choosing another glove session clears the destination selection and the time range', () => {
    useSessionStore.setState({ viewMode: 'map', netToken: 'a', netDest: 'arxiv.org', netRange: { from: 0, to: null } });
    useSessionStore.getState().setNetToken('b');
    expect(readBack()).toBe('/?view=map&glove=b');
  });

  it('filling in the default glove session keeps a range and destination the link named', async () => {
    const range = { from: Date.parse('2026-10-21T00:00:00.000Z'), to: null };
    await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, { view: 'network', dest: 'arxiv.org', range });
    useSessionStore.getState().setNetToken('pi-search'); // what NetworkView does with the default
    expect(readBack()).toBe('/?view=network&glove=pi-search&dest=arxiv.org&from=2026-10-21T00:00:00.000Z&to=now');
  });

  it('switching tab keeps the time range; clearing it is All records again', async () => {
    const range = { from: Date.parse('2026-10-21T08:00:00.000Z'), to: Date.parse('2026-10-21T09:00:00.000Z') };
    await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, { view: 'topology', glove: 'g', range });
    for (const mode of ['network', 'map', 'trace', 'topology'] as const) {
      useSessionStore.getState().setViewMode(mode);
      expect(useSessionStore.getState().netRange).toEqual(range);
    }
    useSessionStore.getState().setNetRange(null);
    expect(readBack()).toBe('/?view=topology&glove=g');
  });

  it('a stale folder id never outranks a network view', async () => {
    stubFetch({ resolve: { kind: 'folder', id: 'f1' } });
    await useSessionStore.getState().hydrateFromRoute({ kind: 'folder', folderId: 'f1' }, {});
    useSessionStore.getState().setViewMode('network');
    useSessionStore.getState().setNetToken('pi-search');
    expect(readBack()).toBe('/?view=network&glove=pi-search');
  });

  describe('arriving from another view', () => {
    const gloved = (sessionId: string, sessionName: string) => ({ sessionId, cwd: '/w', lastSeen: 0, agentType: 'pi', sessionName });
    beforeEach(() => {
      useNetStore.setState({ sessions: [summary('pi-search-c0ffee'), summary('direct-c0ffee')], notObservable: [{ token: 'dark-c0ffee', harness: null }] as never, sessionsKnown: true });
    });
    afterEach(() => useNetStore.setState({ sessions: [], notObservable: [], sessionsKnown: false }));

    it('shows the gloved session being looked at, in one update, clearing the old one’s range', () => {
      const range = { from: 0, to: null };
      useSessionStore.setState({ viewMode: 'stream', netToken: 'direct-c0ffee', netDest: 'x.org', netRange: range, activeSessionId: 's1', sessions: [gloved('s1', 'pi-search-c0ffee')] });
      const states: string[] = [];
      const off = useSessionStore.subscribe(() => states.push(readBack()));
      useSessionStore.getState().setViewMode('topology');
      off();
      expect(states).toEqual(['/?view=topology&glove=pi-search-c0ffee']);
      // Between the tabs, the choice holds.
      useSessionStore.getState().setNetToken('direct-c0ffee');
      useSessionStore.getState().setViewMode('map');
      expect(readBack()).toBe('/?view=map&glove=direct-c0ffee');
    });

    it('keeps the range when it is the session already shown', () => {
      const range = { from: 5, to: null };
      useSessionStore.setState({ viewMode: 'stream', netToken: 'pi-search-c0ffee', netRange: range, activeSessionId: 's1', sessions: [gloved('s1', 'pi-search-c0ffee')] });
      useSessionStore.getState().setViewMode('network');
      expect(useSessionStore.getState().netRange).toEqual(range);
    });

    it('shows a session that is not observable, which the default would skip', () => {
      useSessionStore.setState({ viewMode: 'stream', netToken: null, activeSessionId: 's1', sessions: [gloved('s1', 'dark-c0ffee')] });
      useSessionStore.getState().setViewMode('network');
      expect(useSessionStore.getState().netToken).toBe('dark-c0ffee');
    });

    it('from the Dashboard, uses its focused session, not the one Logs last showed', () => {
      useSessionStore.setState({ viewMode: 'dashboard', netToken: 'direct-c0ffee', activeSessionId: 's1', dashboardFocusedSession: null, sessions: [gloved('s1', 'pi-search-c0ffee')] });
      useSessionStore.getState().setViewMode('network');
      expect(useSessionStore.getState().netToken).toBe('direct-c0ffee');
      useSessionStore.setState({ viewMode: 'dashboard', dashboardFocusedSession: 's1' });
      useSessionStore.getState().setViewMode('network');
      expect(useSessionStore.getState().netToken).toBe('pi-search-c0ffee');
    });

    it('leaves the choice alone for a session that is not gloved, or before the glove sessions are known', () => {
      useSessionStore.setState({ viewMode: 'stream', netToken: 'direct-c0ffee', activeSessionId: 's1', sessions: [gloved('s1', 'renamed')] });
      useSessionStore.getState().setViewMode('network');
      expect(useSessionStore.getState().netToken).toBe('direct-c0ffee');
      useNetStore.setState({ sessions: [], notObservable: [], sessionsKnown: false });
      useSessionStore.setState({ viewMode: 'stream', sessions: [gloved('s1', 'pi-search-c0ffee')] });
      useSessionStore.getState().setViewMode('network');
      expect(useSessionStore.getState().netToken).toBe('direct-c0ffee');
    });

    it('a deep link with ?glove= wins', async () => {
      useSessionStore.setState({ activeSessionId: 's1', sessions: [gloved('s1', 'direct-c0ffee')] });
      await useSessionStore.getState().hydrateFromRoute({ kind: 'dashboard' }, { view: 'topology', glove: 'pi-search-c0ffee' });
      expect(readBack()).toBe('/?view=topology&glove=pi-search-c0ffee');
    });
  });

  it('"Network for this turn" opens Topology on the session and range in one history step', () => {
    useSessionStore.setState({ viewMode: 'stream', netToken: 'other-c0ffee', netDest: 'x.org', activeSessionId: null });
    const states: string[] = [];
    const off = useSessionStore.subscribe(() => states.push(readBack()));
    useSessionStore.getState().showNetworkRange('pi-search-c0ffee', { from: Date.parse('2026-10-21T08:00:00.000Z'), to: Date.parse('2026-10-21T08:05:00.000Z') });
    off();
    expect(states).toEqual(['/?view=topology&glove=pi-search-c0ffee&from=2026-10-21T08:00:00.000Z&to=2026-10-21T08:05:00.000Z']);
  });

  it('leaving the network views keeps the choice for next time but drops it from the URL', () => {
    useSessionStore.setState({ viewMode: 'map', netToken: 'pi-search', netDest: 'arxiv.org' });
    useSessionStore.getState().setViewMode('dashboard');
    expect(readBack()).toBe('/');
    useSessionStore.getState().setViewMode('map');
    expect(readBack()).toBe('/?view=map&glove=pi-search&dest=arxiv.org');
  });
});

describe('historyModeFor', () => {
  const at = (path: string) => parsePath(path)!;
  const mode = (from: string, to: string) => {
    const next = at(to);
    return historyModeFor(at(from), next.route, next.opts);
  };

  it('replaces when only the network tab or the destination changes', () => {
    expect(mode('/?view=network&glove=a', '/?view=map&glove=a')).toBe('replace');
    expect(mode('/?view=map&glove=a', '/?view=map&glove=a&dest=x.org')).toBe('replace');
  });
  it('pushes when the glove session changes', () => {
    expect(mode('/?view=map&glove=a', '/?view=map&glove=b')).toBe('push');
  });
  it('pushes when the time range is set, changed or cleared, so Back returns to the previous one', () => {
    const r1 = '&from=2026-10-21T08:00:00.000Z&to=now';
    const r2 = '&from=2026-10-21T09:00:00.000Z&to=2026-10-21T10:00:00.000Z';
    expect(mode('/?view=map&glove=a', `/?view=map&glove=a${r1}`)).toBe('push');
    expect(mode(`/?view=map&glove=a${r1}`, `/?view=map&glove=a${r2}`)).toBe('push');
    expect(mode(`/?view=map&glove=a${r1}`, '/?view=map&glove=a')).toBe('push');
    // Switching tab within one range is still view state.
    expect(mode(`/?view=map&glove=a${r1}`, `/?view=topology&glove=a${r1}`)).toBe('replace');
  });
  it('replaces when the default glove session is filled in (no Back trap)', () => {
    expect(mode('/?view=network', '/?view=network&glove=a')).toBe('replace');
  });
  it('still pushes between Layman sessions', () => {
    expect(mode('/s/one', '/s/two')).toBe('push');
    expect(mode('/s/one', '/s/one?view=logs')).toBe('replace');
  });
});

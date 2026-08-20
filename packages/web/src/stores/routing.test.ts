import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSessionStore, viewModeForName, viewNameForMode, instanceUrlOf } from './sessionStore.js';
import { routeForState } from '../hooks/useLaymanRoute.js';
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

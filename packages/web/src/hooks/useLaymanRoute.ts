import { useEffect, useRef } from 'react';
import { useSessionStore, viewNameForMode, instanceUrlOf } from '../stores/sessionStore.js';
import type { SessionState } from '../stores/sessionStore.js';
import { buildPath, parsePath } from '../lib/layman-url.js';
import type { LaymanRoute, RouteOptions } from '../lib/layman-url.js';
import { ttsPlayer, speechOptionsFrom } from '../lib/tts.js';
import { toSpeakableText } from '../lib/tts-text.js';
import type { Turn } from '../lib/types.js';

/**
 * Binds the address bar to the store, in two deliberately asymmetric directions:
 *
 * - **inbound**, once on mount and on every `popstate`: parse the URL and hand it
 *   to `hydrateFromRoute`.
 * - **outbound**, on every store change: derive the URL from the same fields and
 *   write it back.
 *
 * The asymmetry is the point. If the outbound half ran while the inbound half was
 * applying, a half-hydrated store would overwrite the URL that is still being
 * read — hence `applyingRoute`, which is module-level rather than a ref because
 * there is exactly one address bar per document.
 *
 * `routeGeneration` guards the async gap the same way `TtsPlayer` does: a rapid
 * popstate (mashing Back/Forward) can start a second `apply()` before the first
 * one's `await hydrateFromRoute(...)` resolves. Without it, the stale call's
 * continuation could still win — clearing `applyingRoute` out from under the
 * newer call, or pushing its now-superseded route to the address bar.
 */
let applyingRoute = false;
let routeGeneration = 0;

/**
 * The addressed entity, ignoring view/query options. Two paths with the same
 * entity key are the same place, so moving between them replaces the history
 * entry instead of pushing one — Back should leave a session, not unwind a
 * sequence of panel toggles.
 */
function entityKey(route: LaymanRoute): string {
  switch (route.kind) {
    case 'dashboard': return 'dashboard';
    case 'session':   return `s:${route.sessionId}`;
    case 'turn':      return `s:${route.sessionId}:t:${route.promptEventId}`;
    case 'event':     return `s:${route.sessionId}:e:${route.eventId}`;
    case 'highlight': return `h:${route.highlightId}`;
    case 'bookmark':  return `b:${route.bookmarkId}`;
    case 'folder':    return `f:${route.folderId}`;
  }
}

/**
 * The URL for the current store state.
 *
 * `?play=1` and `?t=` are deliberately never emitted: they are arrival
 * instructions, and re-emitting them would re-trigger speech (or a re-scroll) on
 * every unrelated state change.
 */
export function routeForState(state: SessionState): { route: LaymanRoute; opts: RouteOptions } {
  if (state.routeFolderId) {
    return { route: { kind: 'folder', folderId: state.routeFolderId }, opts: {} };
  }

  if (state.viewMode === 'sessions' && state.viewingSessionId) {
    const sessionId = state.viewingSessionId;
    return state.selectedTurnPromptEventId
      ? { route: { kind: 'turn', sessionId, promptEventId: state.selectedTurnPromptEventId }, opts: {} }
      : { route: { kind: 'session', sessionId }, opts: {} };
  }

  if ((state.viewMode === 'stream' || state.viewMode === 'flowchart') && state.activeSessionId) {
    return {
      route: { kind: 'session', sessionId: state.activeSessionId },
      opts: { view: viewNameForMode(state.viewMode) },
    };
  }

  if (state.viewMode === 'prompts' && state.selectedHighlightId) {
    return { route: { kind: 'highlight', highlightId: state.selectedHighlightId }, opts: {} };
  }

  const view = viewNameForMode(state.viewMode);
  return { route: { kind: 'dashboard' }, opts: view === 'dashboard' ? {} : { view } };
}

/** How long a `?play=1` arrival waits for config before giving up. */
const CONFIG_WAIT_MS = 10_000;

/**
 * Config arrives over the WebSocket, which on a cold page load has usually not
 * connected by the time the inbound route is applied. Reading it directly would
 * find `null` and silently decide speech was disabled — so wait for it.
 */
function waitForConfig(): Promise<SessionState['config']> {
  const immediate = useSessionStore.getState().config;
  if (immediate) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsubscribe(); resolve(null); }, CONFIG_WAIT_MS);
    const unsubscribe = useSessionStore.subscribe(() => {
      const config = useSessionStore.getState().config;
      if (!config) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(config);
    });
  });
}

/**
 * The turn a `?play=1` arrival should read aloud, or null if the address does
 * not name one.
 *
 * Deliberately asks the server for the turn rather than reading the events
 * hydration happened to load: `/h/<id>?play=1` lands in the Prompts view, which
 * never populates `historicalEvents` at all, and a link minted before a
 * duplicate-prompt collapse names an id the client would have to re-resolve
 * anyway. One request answers both cases.
 */
async function turnToPlay(route: LaymanRoute): Promise<Turn | null> {
  let sessionId: string | undefined;
  let promptEventId: string | undefined;

  if (route.kind === 'turn') {
    ({ sessionId, promptEventId } = route);
  } else if (route.kind === 'highlight') {
    try {
      const res = await fetch(`/api/resolve?id=${encodeURIComponent(route.highlightId)}`);
      if (!res.ok) return null;
      const resolved = await res.json() as { sessionId?: string; promptEventId?: string };
      sessionId = resolved.sessionId;
      promptEventId = resolved.promptEventId;
    } catch {
      return null;
    }
  }

  if (!sessionId || !promptEventId) return null;

  try {
    const res = await fetch(
      `/api/turns/${encodeURIComponent(sessionId)}/${encodeURIComponent(promptEventId)}`,
    );
    if (!res.ok) return null;
    return (await res.json() as { turn?: Turn }).turn ?? null;
  } catch {
    return null;
  }
}

/**
 * Speak the addressed turn on arrival.
 *
 * A fresh tab has had no user gesture, so `play()` will usually be refused —
 * that is handled, not avoided: the player keeps the utterance queued and the
 * TTS bar offers "Enable audio", which is one click away from speech.
 */
async function playAddressedTurn(route: LaymanRoute): Promise<void> {
  const config = await waitForConfig();
  if (!config?.tts.enabled) return;

  const turn = await turnToPlay(route);
  if (!turn?.responseEventId) return;

  const text = toSpeakableText(turn.responseText, {
    codeBlocks: config.tts.codeBlocks,
    maxChars: config.tts.maxChars,
  });
  if (!text) return;

  ttsPlayer.enqueue({
    id: turn.responseEventId,
    text,
    label: text.length > 60 ? `${text.slice(0, 59)}…` : text,
    opts: speechOptionsFrom(config.tts),
  });
}

export function useLaymanRoute(): void {
  const syncRef = useRef<(() => void) | null>(null);

  // ── Inbound ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const apply = async (): Promise<void> => {
      const myGeneration = ++routeGeneration;
      const parsed = parsePath(window.location.pathname, window.location.search);
      applyingRoute = true;
      try {
        if (!parsed) {
          // The server's SPA fallback serves index.html for any unmatched path,
          // so an unparseable URL lands here rather than on a 404 page.
          useSessionStore.setState({
            routeError: {
              message: `${window.location.pathname} is not a Layman address.`,
              instanceUrl: instanceUrlOf(useSessionStore.getState().config),
            },
          });
          return;
        }
        await useSessionStore.getState().hydrateFromRoute(parsed.route, parsed.opts);
      } finally {
        // Only the latest call may release the guard — an older call finishing
        // late must not clear it out from under a newer one still in flight.
        if (myGeneration === routeGeneration) applyingRoute = false;
      }

      // A newer apply() has since started (another popstate arrived while this
      // one awaited hydration); its own result is authoritative, so this call's
      // continuation must not sync or speak on its behalf.
      if (myGeneration !== routeGeneration) return;

      // Hydration can canonicalise the address (a collapsed duplicate prompt id
      // resolves to the surviving turn), so push the settled state back out.
      syncRef.current?.();

      // `?play=1` is consumed here and nowhere else. It runs after the sync
      // above, so the URL has already shed the parameter — speech is an arrival
      // effect, and re-emitting it would re-trigger on every later re-render.
      // Not awaited: hydration is done, and speech must not gate the UI.
      if (parsed.opts.play && !useSessionStore.getState().routeError) {
        void playAddressedTurn(parsed.route);
      }
    };

    void apply();

    const onPopState = () => { void apply(); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // ── Outbound ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const sync = () => {
      if (applyingRoute) return;
      const state = useSessionStore.getState();
      if (state.routeHydrating) return;
      // A broken URL is left alone so RouteErrorPanel's message can be read (or
      // copied) against the address that actually failed, rather than '/'.
      if (state.routeError) return;

      const { route, opts } = routeForState(state);
      const next = buildPath(route, opts);
      if (next === `${window.location.pathname}${window.location.search}`) return;

      const current = parsePath(window.location.pathname, window.location.search);
      const sameEntity = current !== null && entityKey(current.route) === entityKey(route);
      if (sameEntity) window.history.replaceState(null, '', next);
      else window.history.pushState(null, '', next);
    };

    syncRef.current = sync;
    sync();
    const unsubscribe = useSessionStore.subscribe(sync);
    return () => {
      syncRef.current = null;
      unsubscribe();
    };
  }, []);
}

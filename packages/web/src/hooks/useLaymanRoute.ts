import { useEffect, useRef } from 'react';
import { useSessionStore, viewNameForMode, instanceUrlOf } from '../stores/sessionStore.js';
import type { SessionState } from '../stores/sessionStore.js';
import { buildPath, parsePath } from '../lib/layman-url.js';
import type { LaymanRoute, RouteOptions } from '../lib/layman-url.js';

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
 */
let applyingRoute = false;

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
  if (state.viewMode === 'sessions' && state.viewingSessionId) {
    const sessionId = state.viewingSessionId;
    return state.selectedTurnPromptEventId
      ? { route: { kind: 'turn', sessionId, promptEventId: state.selectedTurnPromptEventId }, opts: {} }
      : { route: { kind: 'session', sessionId }, opts: {} };
  }

  if (state.viewMode === 'prompts' && state.selectedHighlightId) {
    return { route: { kind: 'highlight', highlightId: state.selectedHighlightId }, opts: {} };
  }

  const view = viewNameForMode(state.viewMode);
  return { route: { kind: 'dashboard' }, opts: view === 'dashboard' ? {} : { view } };
}

export function useLaymanRoute(): void {
  const syncRef = useRef<(() => void) | null>(null);

  // ── Inbound ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const apply = async (): Promise<void> => {
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
        applyingRoute = false;
      }
      // Hydration can canonicalise the address (a collapsed duplicate prompt id
      // resolves to the surviving turn), so push the settled state back out.
      syncRef.current?.();
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

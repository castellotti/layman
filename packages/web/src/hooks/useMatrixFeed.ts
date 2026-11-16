import { useEffect, useRef, useState } from 'react';
import { matrixUrl, type MatrixRow, type MatrixWindow } from '../lib/matrix-feed.js';
import { getJson } from './useNetTrace.js';
import { useLiveEventCount } from './useActivityBoard.js';

/** The beat that alone meets "a host reached now falls within about two seconds". */
export const FEED_POLL_MS = 2000;
/** After an event arrives for the session: long enough that a burst is one request. */
const EVENT_DEBOUNCE_MS = 150;

/**
 * The Styx matrix feed for one session (none: every live session) over a window.
 *
 * Asked at once when the session or window changes, every 2 s, and 150 ms after a new event for the
 * session reaches the page (a tool call arrives over the WebSocket the moment the server records
 * it), all only while the tab is visible. Never two requests at once: a trigger that arrives
 * mid-request runs exactly one more when it returns. The previous rows stay until the next answer
 * (no flicker); the answer of a superseded request is dropped. A gloved session's glove poll is 1 s on
 * the server, so the beat carries it: the network views own the one `net:subscribe`, which this never opens.
 */
export function useMatrixFeed(sessionId: string | null, window: MatrixWindow): { rows: MatrixRow[]; loading: boolean; error: string | null } {
  const url = matrixUrl({ sessionId, window });
  const [state, setState] = useState<{ url: string; rows: MatrixRow[]; error: string | null } | null>(null);
  const request = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let running = false;
    let again = false;
    const run = (): void => {
      if (running) { again = true; return; }
      running = true;
      getJson<MatrixRow[]>(url)
        .then((rows) => { if (live) setState({ url, rows, error: null }); })
        .catch((e: Error) => { if (live) setState((s) => ({ url, rows: s?.url === url ? s.rows : [], error: e.message })); })
        .finally(() => {
          running = false;
          if (live && again) { again = false; run(); }
        });
    };
    const ask = (): void => { if (document.visibilityState === 'visible') run(); };
    request.current = ask;
    run();
    const timer = setInterval(ask, FEED_POLL_MS);
    document.addEventListener('visibilitychange', ask);
    return () => {
      live = false;
      request.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [url]);

  // A new event for this session: ask again soon, once for a burst. Not on mount (the effect above asked).
  const events = useLiveEventCount(sessionId);
  const seen = useRef(events);
  useEffect(() => {
    if (seen.current === events) return;
    seen.current = events;
    const t = setTimeout(() => request.current(), EVENT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [events]);

  const ours = state?.url === url ? state : null;
  return { rows: ours?.rows ?? [], loading: ours === null, error: ours?.error ?? null };
}

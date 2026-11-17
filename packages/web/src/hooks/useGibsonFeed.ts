import { useEffect, useRef, useState } from 'react';
import { gibsonLogUrl, gibsonUrls, type HostRow, type LinkRow, type LogRow } from '../lib/gibson-feed.js';
import type { MatrixWindow } from '../lib/matrix-feed.js';
import { getJson } from './useNetTrace.js';
import { useLiveEventCount } from './useActivityBoard.js';
import { FEED_POLL_MS } from './useMatrixFeed.js';

/** After an event arrives for the session: long enough that a burst is one request. */
const EVENT_DEBOUNCE_MS = 150;
/** A tower's log changes slower than the city and is read only for the one selected. */
export const LOG_POLL_MS = 5000;

/**
 * The poll both hooks share, written as `useMatrixFeed` is: `key` names what is asked (nothing, when null),
 * `read` asks it. Asked at once when the key changes, every `every` ms, and 150 ms after `events` (a count that
 * grows with each new event for the session) changes, all only while the tab is visible. Never two requests at once: a
 * trigger that arrives mid-request runs exactly one more when it returns. The previous answer stays until the
 * next (no flicker); the answer of a superseded request is dropped.
 */
function usePoll<T>(
  key: string | null, read: () => Promise<T>, every: number, events: number,
): { value: T | null; loading: boolean; error: string | null } {
  const [state, setState] = useState<{ key: string; value: T | null; error: string | null } | null>(null);
  const request = useRef<() => void>(() => {});
  const reader = useRef(read);
  reader.current = read;
  // `events` as of this render, for the effect below to start from.
  const seen = useRef(events);
  const latest = useRef(events);
  latest.current = events;

  useEffect(() => {
    if (key === null) return;
    let live = true;
    let running = false;
    let again = false;
    const run = (): void => {
      if (running) { again = true; return; }
      running = true;
      reader.current()
        .then((value) => { if (live) setState({ key, value, error: null }); })
        .catch((e: Error) => { if (live) setState((s) => ({ key, value: s?.key === key ? s.value : null, error: e.message })); })
        .finally(() => {
          running = false;
          if (live && again) { again = false; run(); }
        });
    };
    const ask = (): void => { if (document.visibilityState === 'visible') run(); };
    request.current = ask;
    // This request covers every event so far: only a later one asks again.
    seen.current = latest.current;
    run();
    const timer = setInterval(ask, every);
    document.addEventListener('visibilitychange', ask);
    return () => {
      live = false;
      request.current = () => {};
      clearInterval(timer);
      document.removeEventListener('visibilitychange', ask);
    };
  }, [key, every]);

  // A new event for this session: ask again soon, once for a burst. Not on mount (the effect above asked).
  useEffect(() => {
    if (seen.current === events) return;
    seen.current = events;
    const t = setTimeout(() => request.current(), EVENT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [events]);

  const ours = key !== null && state?.key === key ? state : null;
  return { value: ours?.value ?? null, loading: key !== null && ours === null, error: ours?.error ?? null };
}

/**
 * The Gibson feed for one session (none: every live session) over a window: hosts and links asked together,
 * so a tower never appears without its routes. Its beat is `useMatrixFeed`'s.
 */
export function useGibsonFeed(sessionId: string | null, window: MatrixWindow): { hosts: HostRow[]; links: LinkRow[]; loading: boolean; error: string | null } {
  const urls = gibsonUrls({ sessionId, window });
  const events = useLiveEventCount(sessionId);
  const { value, loading, error } = usePoll(
    urls.hosts + '|' + urls.links,
    () => Promise.all([getJson<HostRow[]>(urls.hosts), getJson<LinkRow[]>(urls.links)]).then(([hosts, links]) => ({ hosts, links })),
    FEED_POLL_MS, events,
  );
  return { hosts: value?.hosts ?? EMPTY_HOSTS, links: value?.links ?? EMPTY_LINKS, loading, error };
}

const EMPTY_HOSTS: HostRow[] = [];
const EMPTY_LINKS: LinkRow[] = [];
const EMPTY_LOG: LogRow[] = [];

/**
 * One tower's log: at once when `host` changes, then every 5 s while it is set; `host` null asks nothing. The
 * rows are filtered to `host` here as well, so an answer that raced a selection change never shows another
 * tower's lines.
 */
export function useGibsonLog(sessionId: string | null, window: MatrixWindow, host: string | null): { rows: LogRow[]; loading: boolean; error: string | null } {
  const url = host ? gibsonLogUrl({ sessionId, window, host }) : null;
  const { value, loading, error } = usePoll(url, () => getJson<LogRow[]>(url ?? ''), LOG_POLL_MS, 0);
  const want = host?.toLowerCase();
  const rows = value && want ? value.filter((r) => r.host.toLowerCase() === want) : EMPTY_LOG;
  return { rows, loading, error };
}

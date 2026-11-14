import { useEffect, useState } from 'react';
import { useNetStore } from '../stores/netStore.js';
import { gloveMap, GLOVE_READ_MS, type GloveMap } from '../lib/activity-glove.js';
import type { GatesView, NetRange } from '../lib/netobs-types.js';
import { getJson, pollSettled } from './useNetTrace.js';

/** How often a live gloved session's gates are read again while the map is visible. */
const REFRESH_MS = GLOVE_READ_MS;

/**
 * What the map shows of the glove session a Layman session runs in, or null when it runs in none.
 * A gloved session's Layman `sessionName` is its glove id (as Trace joins them). Read from Layman's
 * own `/api/net/sessions/:token/gates` (the services, each destination's traffic, this session's
 * calls joined to their flows, the last minute's loose flows, the exit without its address), never
 * the network views' one subscription, which they own; only Layman is ever asked. `since` (ms, the
 * session's first event) leaves out the hosts an earlier run in the same sandbox reached. A `range`
 * (one turn's, `mapTurn`) narrows it to that turn: its flows still in memory, its calls, as Trace counts it.
 */
export function useGloveMap(sessionId: string | null, sessionName: string | null | undefined, live: boolean, since: number, range: NetRange | null = null): GloveMap | null {
  const token = useNetStore((s) => (sessionName && s.sessions.some((x) => x.token === sessionName) ? sessionName : null));
  const [state, setState] = useState<{ key: string; map: GloveMap } | null>(null);
  const span = range ? `&from=${range.from}${range.to === null ? '' : `&to=${range.to}`}` : '';
  // A turn that has ended is read once; the session, or a turn still running, while it is live.
  const polls = live && (range === null || range.to === null);
  const key = token && sessionId ? `${token}@${sessionId}@${since}${span}` : null;
  useEffect(() => {
    if (!token || !sessionId || !key) return;
    // A hidden tab skips a refresh, never the first read: a finished session polls only once.
    // An unchanged read keeps the last state, so an idle sandbox does not redraw the view every poll.
    let loaded = false;
    let last = '';
    const url = `/api/net/sessions/${encodeURIComponent(token)}/gates?since=${since}&session=${encodeURIComponent(sessionId)}${span}`;
    return pollSettled((isLive) => (loaded && document.hidden ? Promise.resolve()
      : getJson<GatesView>(url)
        .then((r) => {
          const read = JSON.stringify(r);
          if (!isLive() || read === last) return;
          last = read;
          setState({ key, map: gloveMap(r) });
        })
        .catch(() => { /* kept: the last gates read, or none */ })
        .finally(() => { loaded = true; })), polls ? REFRESH_MS : 0);
  }, [token, sessionId, key, since, span, polls]);
  return key && state?.key === key ? state.map : null;
}

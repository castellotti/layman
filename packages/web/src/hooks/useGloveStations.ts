import { useEffect, useState } from 'react';
import { useNetStore } from '../stores/netStore.js';
import { gloveStations, type GatesResponse, type GloveStations } from '../lib/activity-glove.js';
import { getJson, pollSettled } from './useNetTrace.js';

/** How often a live gloved session's gates are read again while the map is visible. */
const REFRESH_MS = 10_000;

/**
 * The gates of the glove session a Layman session runs in, or null when it runs in none. A gloved
 * session's Layman `sessionName` is its glove id (as Trace joins them). Read from Layman's own
 * `/api/net/sessions/:token/gates` (the services and each destination's traffic, nothing more),
 * never the network views' one subscription, which they own; only Layman is ever asked. `since`
 * (ms, the session's first event) leaves out the hosts an earlier run in the same sandbox reached.
 */
export function useGloveStations(sessionName: string | null | undefined, live: boolean, since: number): GloveStations | null {
  const token = useNetStore((s) => (sessionName && s.sessions.some((x) => x.token === sessionName) ? sessionName : null));
  const [state, setState] = useState<{ key: string; stations: GloveStations } | null>(null);
  const key = token ? `${token}@${since}` : null;
  useEffect(() => {
    if (!token || !key) return;
    // A hidden tab skips a refresh, never the first read: a finished session polls only once.
    let loaded = false;
    return pollSettled((isLive) => (loaded && document.hidden ? Promise.resolve()
      : getJson<GatesResponse>(`/api/net/sessions/${encodeURIComponent(token)}/gates?since=${since}`)
        .then((r) => { if (isLive()) setState({ key, stations: gloveStations(r.services, r.destinations) }); })
        .catch(() => { /* kept: the last gates read, or none */ })
        .finally(() => { loaded = true; })), live ? REFRESH_MS : 0);
  }, [token, key, since, live]);
  return key && state?.key === key ? state.stations : null;
}

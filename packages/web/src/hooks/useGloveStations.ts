import { useEffect, useState } from 'react';
import { useNetStore } from '../stores/netStore.js';
import { gloveStations, type GloveStations } from '../lib/activity-glove.js';
import type { NetSnapshot } from '../lib/netobs-types.js';
import { getJson, pollSettled } from './useNetTrace.js';

/** How often a live gloved session's gates are read again while the map is visible. */
const REFRESH_MS = 10_000;

/**
 * The gates of the glove session a Layman session runs in, or null when it runs in none. A gloved
 * session's Layman `sessionName` is its glove id (as Trace joins them). Read from Layman's own REST
 * snapshot (`/api/net/sessions/:token`), never the network views' one subscription, which they own;
 * only Layman is ever asked.
 */
export function useGloveStations(sessionName: string | null | undefined, live: boolean): GloveStations | null {
  const token = useNetStore((s) => (sessionName && s.sessions.some((x) => x.token === sessionName) ? sessionName : null));
  const [state, setState] = useState<{ token: string; stations: GloveStations } | null>(null);
  useEffect(() => {
    if (!token) return;
    return pollSettled((isLive) => (document.hidden ? Promise.resolve() : getJson<NetSnapshot>(`/api/net/sessions/${encodeURIComponent(token)}`)
      .then((snap) => { if (isLive()) setState({ token, stations: gloveStations(snap.session?.services ?? [], snap.destinations) }); })
      .catch(() => { /* kept: the last gates read, or none */ })), live ? REFRESH_MS : 0);
  }, [token, live]);
  return token && state?.token === token ? state.stations : null;
}

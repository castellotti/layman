import { useEffect, useMemo, useRef, useState } from 'react';
import type { HostRow, LinkRow } from '../lib/gibson-feed.js';
import { ARRIVAL_MS, EMPTY_PLACEMENT, FRESH_MS, buildCity, createTraffic, place, type City, type Placement, type Traffic } from '../lib/gibson-city.js';

/** The beat of what has a clock but no data: a fresh tower's colour ending, an arrival's glow. */
export const BEAT_MS = 100;

/** What outlives a refresh. */
interface Kept {
  key: string;
  placement: Placement;
  /** Hosts the city has shown for this key; null until the first answer, so nothing is fresh on the first draw. */
  known: Set<string> | null;
  /** When (Date.now) each fresh host appeared. */
  freshAt: Map<string, number>;
}

const fresh = (key: string): Kept => ({ key, placement: EMPTY_PLACEMENT, known: null, freshAt: new Map() });

/**
 * The city every Gibson renderer draws, and what must outlive a refresh for it to be the same city: who stands
 * where (`place`, the only thing that changes placement), the hosts known (so a new one is fresh for 6 s), the
 * traffic, and the hosts a car just reached. Reset at render when `resetKey` changes, so the answer for a new
 * session or window is never placed on the old one's streets. `failed`: the feed's first answer failed, so
 * there is nothing known yet and the next real one must not look all new. `tick` rebuilds the city on the
 * beat while something is fresh or brightening, and once more when it ends.
 */
export function useGibsonCity({ hosts, links, resetKey, failed, beatArrivals = true }: {
  hosts: readonly HostRow[];
  links: readonly LinkRow[];
  resetKey: string;
  failed: boolean;
  /** Rebuild on the beat while a car's arrival glows. 2D draws the glow from the city; 3D's shader does, so it need not. */
  beatArrivals?: boolean;
}): { city: City; placement: Placement; freshAt: ReadonlyMap<string, number>; arrivedAt: React.MutableRefObject<Map<string, number>>; traffic: React.MutableRefObject<Traffic> } {
  const [tick, setTick] = useState(0);
  const kept = useRef<Kept>(fresh(resetKey));
  if (kept.current.key !== resetKey) kept.current = fresh(resetKey);
  const arrivedAt = useRef(new Map<string, number>());
  const traffic = useRef(createTraffic());

  const placement = useMemo(() => {
    const st = kept.current;
    st.placement = place(st.placement, hosts, links);
    if (st.known === null) { if (!failed) st.known = new Set(hosts.map((h) => h.host)); }
    else for (const h of hosts) if (!st.known.has(h.host)) { st.known.add(h.host); st.freshAt.set(h.host, Date.now()); }
    return st.placement;
  }, [hosts, links, resetKey, failed]);

  // `tick` is in the dependencies: it is how a clock (a fresh colour ending) rebuilds the city.
  const city = useMemo(() => {
    const now = Date.now();
    const freshHosts = new Set<string>();
    for (const [h, at] of kept.current.freshAt) if (now - at < FRESH_MS) freshHosts.add(h);
    return buildCity(placement, hosts, links, freshHosts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, hosts, links, tick]);

  // A new session or window: the traffic and what a car reached belong to the last one.
  useEffect(() => {
    arrivedAt.current = new Map();
    traffic.current = createTraffic();
  }, [resetKey]);

  // The clocks: while something is fresh or brightening, rebuild every beat, and once more when it ends.
  useEffect(() => {
    let was = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      for (const [h, at] of kept.current.freshAt) if (now - at >= FRESH_MS) kept.current.freshAt.delete(h);
      for (const [h, at] of arrivedAt.current) if (now - at >= ARRIVAL_MS) arrivedAt.current.delete(h);
      const on = kept.current.freshAt.size > 0 || (beatArrivals && arrivedAt.current.size > 0);
      if (on || was) setTick((n) => n + 1);
      was = on;
    }, BEAT_MS);
    return () => clearInterval(timer);
  }, [beatArrivals]);

  return { city, placement, freshAt: kept.current.freshAt, arrivedAt, traffic };
}

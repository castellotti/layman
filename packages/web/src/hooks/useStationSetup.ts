import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import { NO_SETUP, type StationSetup } from '../lib/station.js';

/** The person's Memory settings (`activity` config) as a station setup, stable until they change. */
export function useStationSetup(): StationSetup {
  const activity = useSessionStore((s) => s.config?.activity);
  return useMemo(
    () => (activity ? { memoryPaths: activity.memoryPaths ?? [], memoryServers: activity.memoryServers ?? [] } : NO_SETUP),
    [activity],
  );
}

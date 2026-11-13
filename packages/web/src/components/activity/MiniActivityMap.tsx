import { useActivityBoard } from '../../hooks/useActivityBoard.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { mapTitle } from '../../lib/activity-view.js';
import { STATION_IDS } from '../../lib/station.js';
import type { TimelineEvent } from '../../lib/types.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { ActivityMap } from './ActivityMap.js';

/** The width a Dashboard pane's map takes. */
export const MINI_MAP_WIDTH = 180;

/**
 * A small activity map for a Dashboard pane: the session's stations without names (each has its
 * tooltip), its worn spokes, faults, running calls and pulses. A click opens the session's full map.
 * `liveEvents` are the pane's own, so the map does not filter the store again.
 */
export function MiniActivityMap({ sessionId, name, live, liveEvents }: { sessionId: string; name: string; live: boolean; liveEvents: TimelineEvent[] }) {
  const { board } = useActivityBoard(sessionId, !live, liveEvents);
  const [ref, size] = useElementSize<HTMLDivElement>();
  const open = () => useSessionStore.getState().navigateFromDashboardToActivity(sessionId);
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`Open the activity map of ${name}`}
      title="Open the activity map"
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      style={{ position: 'relative', width: MINI_MAP_WIDTH, flexShrink: 0, borderLeft: '1px solid var(--border-subtle)', cursor: 'pointer' }}
    >
      {size.width > 0 && size.height > 0 && (
        <div style={{ position: 'absolute', inset: 4 }}>
          <ActivityMap board={board} stations={STATION_IDS} width={size.width - 8} height={size.height - 8}
            live={live} title={mapTitle(name, board)} compact />
        </div>
      )}
    </div>
  );
}

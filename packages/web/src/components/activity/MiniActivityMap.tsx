import { useActivityBoard } from '../../hooks/useActivityBoard.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { mapTitle } from '../../lib/activity-view.js';
import { STATION_IDS } from '../../lib/station.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { ActivityMap } from './ActivityMap.js';
import { asButton } from '../primitives/index.js';

/** The width a Dashboard pane's map takes. */
export const MINI_MAP_WIDTH = 180;

/**
 * A small activity map for a Dashboard pane: the session's stations without names (each has its
 * tooltip), its worn spokes, faults, running calls and pulses. A click opens the session's full map.
 */
export function MiniActivityMap({ sessionId, name, live }: { sessionId: string; name: string; live: boolean }) {
  const { board } = useActivityBoard(sessionId, !live);
  const [ref, size] = useElementSize<HTMLDivElement>();
  const open = () => useSessionStore.getState().navigateFromDashboardToActivity(sessionId);
  return (
    <div
      ref={ref}
      {...asButton(`Open the activity map of ${name}`, open)}
      title="Open the activity map"
      style={{ position: 'relative', width: MINI_MAP_WIDTH, flexShrink: 0, borderLeft: 'var(--stroke) solid var(--border-subtle)', cursor: 'pointer' }}
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

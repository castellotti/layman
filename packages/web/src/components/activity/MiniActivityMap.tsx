import { useActivityBoard } from '../../hooks/useActivityBoard.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { mapTitle } from '../../lib/activity-view.js';
import { STATION_IDS } from '../../lib/station.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { ActivityMap } from './ActivityMap.js';

/**
 * A small activity map for a Dashboard pane: the session's stations without names (each has its
 * tooltip), its worn spokes, faults, running calls and pulses. A click opens the session's full map.
 */
export function MiniActivityMap({ sessionId, name, live }: { sessionId: string; name: string; live: boolean }) {
  const { board } = useActivityBoard(sessionId, !live);
  const [ref, size] = useElementSize<HTMLDivElement>();
  const open = () => {
    const { setActiveSession, setViewMode } = useSessionStore.getState();
    setActiveSession(sessionId);
    setViewMode('activity');
  };
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      title="Open the activity map"
      onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      style={{ position: 'relative', width: 180, flexShrink: 0, borderLeft: '1px solid var(--border-subtle)', cursor: 'pointer' }}
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

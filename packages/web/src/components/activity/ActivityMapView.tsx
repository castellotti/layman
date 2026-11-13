import React, { useCallback, useMemo } from 'react';
import { sp } from '../../lib/density.js';
import { fetchRecordedSessionEvents, useSessionStore } from '../../stores/sessionStore.js';
import { useActivityBoard } from '../../hooks/useActivityBoard.js';
import { useStationSetup } from '../../hooks/useStationSetup.js';
import { foldRows } from '../../lib/activity-board.js';
import { ENTRY_STATUS, entryLabel, mapTitle, pickSession, stationSpecs } from '../../lib/activity-view.js';
import { useGloveStations } from '../../hooks/useGloveStations.js';
import { useStoredFlag } from '../../hooks/useStored.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { STATION_STYLE } from '../../lib/station-style.js';
import { contextPctColor, getSessionDisplayName, isSessionLive } from '../../lib/session-state.js';
import { countLabel, formatDuration } from '../../lib/format.js';
import type { TimelineEvent } from '../../lib/types.js';
import { ActivityMap } from './ActivityMap.js';
import { StationGlyph } from './StationGlyph.js';

const NAMES_ONLY_KEY = 'layman.activity.namesOnly';
const FEED_ROWS = 40;
/** Below this width the feed goes under the map rather than beside it. */
const STACK_BELOW = 760;

function Fact({ label, value, color = 'var(--text-body)' }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', gap: sp(5), alignItems: 'baseline' }}>
      <span style={{ color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ color, fontFamily: 'var(--font-mono)' }}>{value}</span>
    </span>
  );
}

/**
 * The activity map of one session: what kind of work it did, where, and what is running now. The
 * session is the one open in the app (the header's picker), else the newest live one.
 */
export default function ActivityMapView() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const setSelectedEvent = useSessionStore((s) => s.setSelectedEvent);
  const selectedEventId = useSessionStore((s) => s.selectedEventId);
  const sessionId = pickSession(activeSessionId, sessions);
  const session = sessions.find((s) => s.sessionId === sessionId);
  // A session the server no longer lists is over.
  const live = !!session && isSessionLive(session);
  const { board, events, loading } = useActivityBoard(sessionId, !live);
  // Behind a glove gate, the sandbox's own services are stations too, worn by real bytes since the
  // session began: its first event, by the transcript's own time where a passive watcher kept it.
  const since = useMemo(() => {
    let first = Infinity;
    for (const e of events) first = Math.min(first, e.timestamp, typeof e.data.transcriptAt === 'number' ? e.data.transcriptAt : Infinity);
    return Number.isFinite(first) ? first : 0;
  }, [events]);
  const glove = useGloveStations(loading ? null : session?.sessionName, live, since);
  const stations = useMemo(() => stationSpecs(board, glove), [board, glove]);
  const setup = useStationSetup();
  const [namesOnly, toggleNamesOnly] = useStoredFlag(NAMES_ONLY_KEY, false);
  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  const [mapRef, size] = useElementSize<HTMLDivElement>();
  const stacked = body.width > 0 && body.width < STACK_BELOW;

  const rows = useMemo(() => foldRows(board.entries, FEED_ROWS), [board]);
  // Only the rows' own events, walked from the newest end (where the feed's rows are): a session can
  // hold 10,000 events, and this runs on each new one.
  const byId = useMemo(() => {
    const wanted = new Set(rows.map((r) => r.entry.eventId));
    const out = new Map<string, TimelineEvent>();
    for (let i = events.length - 1; i >= 0 && out.size < wanted.size; i--) {
      if (wanted.has(events[i].id)) out.set(events[i].id, events[i]);
    }
    return out;
  }, [rows, events]);

  /**
   * Opens a row in Investigation, which reads events from the store. The board's copy is the lean
   * recording (no outputs), so an event the store does not hold loads the session's full recording
   * into it first, as opening the session by link does.
   */
  const open = useCallback(async (eventId: string) => {
    if (eventId === selectedEventId) { setSelectedEvent(null); return; }
    const { events: liveEvents, historicalEvents, setHistoricalEvents } = useSessionStore.getState();
    const held = liveEvents.some((e) => e.id === eventId) || historicalEvents.some((e) => e.id === eventId);
    if (!held && sessionId) {
      const full = await fetchRecordedSessionEvents(sessionId);
      if (!full?.some((e) => e.id === eventId)) return;
      setHistoricalEvents(full);
    }
    setSelectedEvent(eventId);
  }, [selectedEventId, sessionId, setSelectedEvent]);

  if (!sessionId) {
    return <div className="flex items-center justify-center h-full text-text-faint text-xs">No session yet.</div>;
  }

  const name = session ? getSessionDisplayName(session) : sessionId.slice(0, 8);
  const title = mapTitle(name, board);

  return (
    <div className="flex flex-col h-full min-w-0" style={{ background: 'var(--bg)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: sp(16), flexWrap: 'wrap', padding: sp('8px 16px'), borderBottom: 'var(--stroke) solid var(--border)', fontSize: 11, fontFamily: 'var(--font-ui)' }}
      >
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{name}</span>
        <span style={{ color: live ? 'var(--ok)' : 'var(--text-faint)' }}>{live ? 'live' : 'ended'}</span>
        <Fact label="turns" value={board.turns} />
        {board.model && <Fact label="model" value={board.model} />}
        {board.context !== undefined && <Fact label="context" value={`${Math.round(board.context)}%`} color={contextPctColor(board.context, 'var(--text-body)')} />}
        {board.pushed > 0 && <Fact label="memory pushed" value={countLabel(board.pushed)} />}
        {board.agents > 0 && <Fact label="subagents" value={board.agents} />}
        {loading && <span style={{ color: 'var(--text-faint)' }}>loading the recording…</span>}
        <span style={{ flex: 1 }} />
        <label data-print-hide style={{ display: 'inline-flex', alignItems: 'center', gap: sp(6), color: 'var(--text-muted)', cursor: 'pointer' }}
          title="Show only names: a file's last two folders, a host, a command's name. Nothing of what was typed, read or run.">
          <input type="checkbox" checked={namesOnly} onChange={toggleNamesOnly} />
          Names only
        </label>
      </div>

      <div ref={bodyRef} className="activity-body flex flex-1 min-h-0" style={{ flexDirection: stacked ? 'column' : 'row' }}>
        {/* The map takes the room it is given and never sizes its box itself, or a growing feed
            beside it would grow the map, which would grow the box. */}
        <div ref={mapRef} className="activity-map-pane" style={{ flex: stacked ? '0 0 55%' : '3 1 0', position: 'relative', minWidth: 0, minHeight: 0 }}>
          {size.width > 0 && size.height > 0 && (
            <div style={{ position: 'absolute', inset: 8 }}>
              <ActivityMap board={board} stations={stations} width={size.width - 16} height={size.height - 16} live={live} title={title} />
            </div>
          )}
        </div>

        <div
          role="list"
          aria-label="Recent activity"
          style={{
            flex: stacked ? '1 1 0' : '2 1 0', minWidth: 0, minHeight: 0, overflowY: 'auto', fontSize: 11, fontFamily: 'var(--font-ui)',
            ...(stacked ? { borderTop: 'var(--stroke) solid var(--border-subtle)' } : { borderLeft: 'var(--stroke) solid var(--border-subtle)' }),
          }}
        >
          {rows.length === 0 && <div style={{ padding: sp(16), color: 'var(--text-faint)' }}>{loading ? '' : 'Nothing recorded yet.'}</div>}
          {rows.map(({ entry, times, tookMs }) => {
            const style = STATION_STYLE[entry.station];
            const label = entryLabel(byId.get(entry.eventId), entry.station, namesOnly, setup);
            const selected = entry.eventId === selectedEventId;
            return (
              // Not a <button>: print hides every button, and a row is content. Keyboard reaches it.
              <div
                key={`${entry.eventId}:${entry.station}`}
                role="listitem"
                tabIndex={0}
                aria-current={selected || undefined}
                onClick={() => void open(entry.eventId)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(entry.eventId); } }}
                style={{
                  display: 'grid', gridTemplateColumns: '14px 64px 1fr auto', alignItems: 'center', gap: sp(8),
                  width: '100%', padding: sp('5px 12px'), textAlign: 'left', cursor: 'pointer',
                  background: selected ? 'var(--bg-selected)' : 'transparent',
                  border: 'none', borderBottom: 'var(--stroke) solid var(--border-subtle)', color: 'var(--text-body)',
                }}
              >
                <span style={{ color: style.color, display: 'inline-flex' }}><StationGlyph station={entry.station} size={12} decorative /></span>
                <span style={{ color: style.color }}>{style.label}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
                  {entry.from === 'agents' && <span style={{ color: STATION_STYLE.agents.color }}>subagent · </span>}
                  {label}
                  {times > 1 && <span style={{ color: 'var(--text-faint)' }}>{` +${times - 1}`}</span>}
                </span>
                <span style={{ color: ENTRY_STATUS[entry.status].color, fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'nowrap' }}>
                  {ENTRY_STATUS[entry.status].word || (tookMs > 0 ? formatDuration(tookMs) : '')}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

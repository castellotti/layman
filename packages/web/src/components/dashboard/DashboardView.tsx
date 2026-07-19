import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SessionListRow } from './SessionListRow.js';
import { PreviewPane } from './PreviewPane.js';
import { SearchInput } from '../primitives/index.js';
import { PanelDivider } from '../layout/PanelDivider.js';
import { saveAndBookmarkSession } from '../../lib/bookmarks-api.js';
import { useDragReorder } from '../../hooks/useDragReorder.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import './dashboard.css';

const SESSION_LIST_WIDTH_DEFAULT = 410;
const SESSION_LIST_MIN = 220;
const SESSION_LIST_MAX = 480;
const MIN_PANE_HEIGHT = 240;

type SortMode = 'recent' | 'custom';

interface DashboardViewProps {
  onSend: (msg: ClientMessage) => void;
  /** Adjustable session-list ↔ preview divider (§1.2 item 1). Falls back to a fixed
   *  default when Dashboard is used outside the expanding layout (e.g. embedded). */
  sessionListWidth?: number;
  onResizeSessionList?: (width: number) => void;
}

export function DashboardView({ onSend, sessionListWidth, onResizeSessionList }: DashboardViewProps) {
  const {
    sessions,
    events: allEvents,
    sessionMetrics,
    dashboardSessionOrder,
    setDashboardSessionOrder,
    dashboardDismissedSessions,
    dismissDashboardSession,
    navigateFromDashboardToLogs,
    navigateToLogsForSession,
    driftState,
    config,
  } = useSessionStore();

  // Which sessions have their preview pane open
  const [openPanes, setOpenPanes] = useState<Set<string>>(new Set());
  // Sessions we've already auto-opened at least once — prevents reopening a pane
  // the user explicitly closed when orderedSessions merely reorders.
  const autoOpenedRef = useRef<Set<string>>(new Set());
  // Sort + filter
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [filter, setFilter] = useState('');

  const panelRef = useRef<HTMLDivElement>(null);

  // Events grouped by session
  const eventsBySession = useMemo(() => {
    const map = new Map<string, typeof allEvents>();
    for (const event of allEvents) {
      if (!map.has(event.sessionId)) map.set(event.sessionId, []);
      map.get(event.sessionId)!.push(event);
    }
    return map;
  }, [allEvents]);

  // Filtered + sorted session list
  const orderedSessions = useMemo(() => {
    const activeSessions = sessions.filter(
      s => s.active !== false && !dashboardDismissedSessions.has(s.sessionId)
    );

    let filtered = activeSessions;
    if (filter.trim()) {
      const q = filter.toLowerCase();
      filtered = activeSessions.filter(s =>
        (s.sessionName ?? '').toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
      );
    }

    const sorted = [...filtered].sort((a, b) => {
      if (sortMode === 'custom') {
        const orderMap = new Map(dashboardSessionOrder.map((id, i) => [id, i]));
        const aO = orderMap.get(a.sessionId) ?? 999;
        const bO = orderMap.get(b.sessionId) ?? 999;
        return aO - bO;
      }
      // Default: most recently active
      return b.lastSeen - a.lastSeen;
    });
    return sorted;
  }, [sessions, dashboardSessionOrder, dashboardDismissedSessions, sortMode, filter]);

  // Auto-open pane for newly detected sessions (only the first time each session is seen —
  // reordering orderedSessions, e.g. via attention sort, must not reopen a pane the user closed).
  useEffect(() => {
    const newSessions = orderedSessions.filter(s => !autoOpenedRef.current.has(s.sessionId));
    if (newSessions.length > 0) {
      newSessions.forEach(s => autoOpenedRef.current.add(s.sessionId));
      setOpenPanes(prev => {
        const next = new Set(prev);
        newSessions.forEach(s => next.add(s.sessionId));
        return next;
      });
    }
  }, [orderedSessions]);

  // Auto-close panes for ended/dismissed sessions
  useEffect(() => {
    const activeIds = new Set(orderedSessions.map(s => s.sessionId));
    setOpenPanes(prev => {
      const next = new Set<string>();
      prev.forEach(id => { if (activeIds.has(id)) next.add(id); });
      return next.size === prev.size ? prev : next;
    });
  }, [orderedSessions]);

  const handleToggle = useCallback((sessionId: string) => {
    setOpenPanes(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const handleClosePane = useCallback((sessionId: string) => {
    setOpenPanes(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const handleOpenInLogs = useCallback((sessionId: string) => {
    navigateToLogsForSession(sessionId);
  }, [navigateToLogsForSession]);

  const handleOpenEventInLogs = useCallback((sessionId: string, eventId: string) => {
    navigateFromDashboardToLogs(sessionId, eventId);
  }, [navigateFromDashboardToLogs]);

  // Drag handlers — keyed by sessionId (not array index) so a session added/removed
  // by a live WebSocket update mid-drag can't cause the wrong session to be moved.
  const { dragId, dragOverId, handleDragStart, handleDragOver, handleDragEnd } = useDragReorder(
    useCallback((movedId, targetId) => {
      // Resolve relative drag direction from the CURRENT visible order, not a
      // position captured at drag-start time.
      const fromIdx = orderedSessions.findIndex(s => s.sessionId === movedId);
      const toIdx = orderedSessions.findIndex(s => s.sessionId === targetId);
      if (fromIdx === -1 || toIdx === -1) return;

      // Reorder relative to the FULL session order, not just the filtered/visible
      // subset in orderedSessions — otherwise sessions hidden by an active filter
      // would be dropped from dashboardSessionOrder entirely.
      const allIds = sessions.map(s => s.sessionId);
      const knownIds = new Set(dashboardSessionOrder);
      const baseOrder = [...dashboardSessionOrder, ...allIds.filter(id => !knownIds.has(id))];

      const newOrder = baseOrder.filter(id => id !== movedId);
      const targetPos = newOrder.indexOf(targetId);
      const insertAt = fromIdx < toIdx ? targetPos + 1 : targetPos;
      newOrder.splice(insertAt, 0, movedId);

      setDashboardSessionOrder(newOrder);
      setSortMode('custom');
    }, [orderedSessions, sessions, dashboardSessionOrder, setDashboardSessionOrder])
  );

  // Calculate preview pane heights
  const openSessionIds = orderedSessions.filter(s => openPanes.has(s.sessionId)).map(s => s.sessionId);
  const openCount = openSessionIds.length;

  const listWidth = sessionListWidth ?? SESSION_LIST_WIDTH_DEFAULT;

  return (
    <div className="dashboard-root" style={{ display: 'flex', height: '100%' }}>
      {/* ── Left: session list ── */}
      <div
        style={{
          width: listWidth,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: onResizeSessionList ? undefined : '1px solid var(--border)',
          background: 'var(--bg-raised)',
          overflow: 'hidden',
        }}
      >
        {/* List header */}
        <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder="Filter sessions…"
            width="100%"
          />
        </div>

        {/* Session rows */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {orderedSessions.length === 0 ? (
            <EmptyState />
          ) : (
            orderedSessions.map((session) => (
              <SessionListRow
                key={session.sessionId}
                session={session}
                events={eventsBySession.get(session.sessionId) ?? []}
                metrics={sessionMetrics.get(session.sessionId)}
                isOpen={openPanes.has(session.sessionId)}
                isDragging={dragId === session.sessionId}
                isDragOver={dragOverId === session.sessionId}
                onToggle={handleToggle}
                onOpenInLogs={handleOpenInLogs}
                onDragStart={() => handleDragStart(session.sessionId)}
                onDragOver={() => handleDragOver(session.sessionId)}
                onDragEnd={handleDragEnd}
              />
            ))
          )}
        </div>
      </div>

      {onResizeSessionList && (
        <PanelDivider
          value={listWidth}
          min={SESSION_LIST_MIN}
          max={SESSION_LIST_MAX}
          direction={1}
          onChange={onResizeSessionList}
          title="Drag to resize · resets to default when Dashboard is re-shown"
        />
      )}

      {/* ── Right: preview panes ── */}
      <div
        ref={panelRef}
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'auto',
          background: 'var(--bg)',
        }}
      >
        {openCount === 0 ? (
          <PreviewEmpty />
        ) : (
          openSessionIds.map(sessionId => {
            const session = orderedSessions.find(s => s.sessionId === sessionId);
            if (!session) return null;
            return (
              <PreviewPane
                key={sessionId}
                session={session}
                events={eventsBySession.get(sessionId) ?? []}
                metrics={sessionMetrics.get(sessionId)}
                driftState={driftState.get(sessionId)}
                driftEnabled={!!config?.driftMonitoring?.enabled}
                onClose={handleClosePane}
                onOpenInLogs={handleOpenInLogs}
                onOpenEventInLogs={handleOpenEventInLogs}
                minHeight={MIN_PANE_HEIGHT}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, padding: 24 }}>
      <svg width="40" height="40" viewBox="0 0 56 56" fill="none" style={{ opacity: 0.12, color: 'var(--accent)' }}>
        <circle cx="28" cy="28" r="24" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="28" cy="28" r="15" stroke="currentColor" strokeWidth="1"/>
        <circle cx="28" cy="28" r="5" stroke="currentColor" strokeWidth="1"/>
        <line x1="28" y1="4" x2="28" y2="52" stroke="currentColor" strokeWidth="0.5"/>
        <line x1="4" y1="28" x2="52" y2="28" stroke="currentColor" strokeWidth="0.5"/>
      </svg>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-faint)' }}>No active sessions</span>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-faint)', textAlign: 'center', maxWidth: 220, lineHeight: 1.6 }}>
        Sessions will appear here when agents connect.
      </span>
    </div>
  );
}

function PreviewEmpty() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-faint)' }}>
        Click a session to open its preview
      </span>
    </div>
  );
}

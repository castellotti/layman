import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useEventStore } from '../../hooks/useEventStore.js';
import { SessionCard } from './SessionCard.js';
import { SidePanel } from './SidePanel.js';
import './dashboard.css';

export function DashboardView() {
  const {
    sessions,
    dashboardFocusedSession,
    setDashboardFocusedSession,
    dashboardSessionOrder,
    setDashboardSessionOrder,
    navigateFromDashboard,
  } = useSessionStore();

  const { events: allEvents } = useEventStore({
    promptsOnly: false,
    responsesOnly: false,
    requestsOnly: false,
    riskyOnly: false,
  });

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Sort sessions: active first, then by custom order, then by last seen
  const orderedSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      // Active sessions first
      const aActive = a.active !== false ? 1 : 0;
      const bActive = b.active !== false ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;

      // Then by custom order
      const orderMap = new Map(dashboardSessionOrder.map((id, i) => [id, i]));
      const aOrder = orderMap.get(a.sessionId) ?? 999;
      const bOrder = orderMap.get(b.sessionId) ?? 999;
      if (aOrder !== bOrder) return aOrder - bOrder;

      // Then by most recent activity
      return b.lastSeen - a.lastSeen;
    });
    return sorted;
  }, [sessions, dashboardSessionOrder]);

  // Events grouped by session
  const eventsBySession = useMemo(() => {
    const map = new Map<string, typeof allEvents>();
    for (const event of allEvents) {
      if (!map.has(event.sessionId)) map.set(event.sessionId, []);
      map.get(event.sessionId)!.push(event);
    }
    return map;
  }, [allEvents]);

  // Focus toggle
  const handleFocus = useCallback((sessionId: string) => {
    setDashboardFocusedSession(
      dashboardFocusedSession === sessionId ? null : sessionId
    );
  }, [dashboardFocusedSession, setDashboardFocusedSession]);

  // Drill-down to flowchart + investigation
  const handleDrilldown = useCallback((sessionId: string, eventId: string) => {
    navigateFromDashboard(sessionId, eventId);
  }, [navigateFromDashboard]);

  // Drag handlers
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((index: number) => {
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      const newOrder = orderedSessions.map(s => s.sessionId);
      const [moved] = newOrder.splice(dragIndex, 1);
      newOrder.splice(dragOverIndex, 0, moved);
      setDashboardSessionOrder(newOrder);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, dragOverIndex, orderedSessions, setDashboardSessionOrder]);

  // Count active sessions
  const activeCount = useMemo(
    () => sessions.filter(s => s.active !== false).length,
    [sessions]
  );

  // Auto-update timer for "time since" displays
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="dashboard-root flex flex-col h-full relative">
      {/* Scanline overlay */}
      <div className="dash-scanline" />

      <div className="flex flex-1 min-h-0 relative z-10">
        {/* Main area: Session cards grid */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Dashboard header bar */}
          <div className="flex items-center gap-3 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--dash-border-subtle)' }}>
            <span style={{
              fontFamily: 'var(--dash-font-display)',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--dash-accent)',
              letterSpacing: '0.5px',
            }}>
              DASHBOARD
            </span>
            <span style={{
              fontFamily: 'var(--dash-font-data)',
              fontSize: 10,
              color: 'var(--dash-text-muted)',
            }}>
              {sessions.length} session{sessions.length !== 1 ? 's' : ''}
              {activeCount > 0 && (
                <span style={{ color: 'var(--dash-success)', marginLeft: 6 }}>
                  {activeCount} active
                </span>
              )}
            </span>

            {dashboardFocusedSession && (
              <>
                <span style={{ color: 'var(--dash-text-muted)', fontSize: 10 }}>\u00b7</span>
                <span style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 10,
                  color: 'var(--dash-accent)',
                }}>
                  Focused: {orderedSessions.find(s => s.sessionId === dashboardFocusedSession)?.cwd?.split('/').pop() ?? dashboardFocusedSession.slice(0, 8)}
                </span>
                <button
                  onClick={() => setDashboardFocusedSession(null)}
                  style={{
                    fontFamily: 'var(--dash-font-data)',
                    fontSize: 9,
                    color: 'var(--dash-text-secondary)',
                    background: 'var(--dash-bg)',
                    border: '1px solid var(--dash-border-subtle)',
                    padding: '2px 6px',
                    borderRadius: 3,
                    cursor: 'pointer',
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>

          {/* Cards grid */}
          <div className="flex-1 overflow-y-auto p-4">
            {orderedSessions.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="grid gap-4" style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
                maxWidth: '100%',
              }}>
                {orderedSessions.map((session, index) => (
                  <SessionCard
                    key={session.sessionId}
                    session={session}
                    events={eventsBySession.get(session.sessionId) ?? []}
                    isFocused={dashboardFocusedSession === session.sessionId}
                    onFocus={handleFocus}
                    onDrilldown={handleDrilldown}
                    index={index}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    isDragging={dragIndex === index}
                    isDragOver={dragOverIndex === index}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right side panel */}
        <div className="w-64 shrink-0 flex flex-col min-h-0">
          <SidePanel
            events={allEvents}
            focusedSessionId={dashboardFocusedSession}
          />
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4">
      <div style={{
        fontSize: 48,
        opacity: 0.15,
        lineHeight: 1,
      }}>
        \u25C9
      </div>
      <div style={{
        fontFamily: 'var(--dash-font-display)',
        fontSize: 14,
        color: 'var(--dash-text-muted)',
        textAlign: 'center',
      }}>
        No active sessions
      </div>
      <div style={{
        fontFamily: 'var(--dash-font-data)',
        fontSize: 11,
        color: 'var(--dash-text-muted)',
        textAlign: 'center',
        maxWidth: 280,
        lineHeight: 1.6,
      }}>
        Sessions will appear here when agents connect. Start a Claude Code, Codex, or other supported agent session.
      </div>
    </div>
  );
}

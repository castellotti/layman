import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SessionCard } from './SessionCard.js';
import { SidePanel } from './SidePanel.js';
import './dashboard.css';

export function DashboardView() {
  const {
    sessions,
    events: allEvents,
    dashboardFocusedSession,
    setDashboardFocusedSession,
    dashboardSessionOrder,
    setDashboardSessionOrder,
    dashboardDismissedSessions,
    dismissDashboardSession,
    navigateFromDashboard,
    navigateFromDashboardToLogs,
  } = useSessionStore();

  // Drag state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const orderedSessions = useMemo(() => {
    // Only show active, non-dismissed sessions in the dashboard — ended sessions are visible in Logs
    const activeSessions = sessions.filter(s => s.active !== false && !dashboardDismissedSessions.has(s.sessionId));
    const sorted = [...activeSessions].sort((a, b) => {
      // Respect custom drag order
      const orderMap = new Map(dashboardSessionOrder.map((id, i) => [id, i]));
      const aOrder = orderMap.get(a.sessionId) ?? 999;
      const bOrder = orderMap.get(b.sessionId) ?? 999;
      if (aOrder !== bOrder) return aOrder - bOrder;

      // Fall back to most recently seen
      return b.lastSeen - a.lastSeen;
    });
    return sorted;
  }, [sessions, dashboardSessionOrder, dashboardDismissedSessions]);

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

  // Dismiss a session card (hides it; auto-restores on new activity)
  const handleDismiss = useCallback((sessionId: string) => {
    dismissDashboardSession(sessionId);
    if (dashboardFocusedSession === sessionId) setDashboardFocusedSession(null);
  }, [dismissDashboardSession, dashboardFocusedSession, setDashboardFocusedSession]);

  // Drill-down to flowchart + investigation
  const handleDrilldown = useCallback((sessionId: string, eventId: string) => {
    navigateFromDashboard(sessionId, eventId);
  }, [navigateFromDashboard]);

  // Drill-down to Logs (for prompt/response clicks)
  const handleDrilldownToLogs = useCallback((sessionId: string, eventId: string) => {
    navigateFromDashboardToLogs(sessionId, eventId);
  }, [navigateFromDashboardToLogs]);

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

  // Count total (all known) sessions vs displayed (active only)
  const totalSessionCount = sessions.length;
  const inactiveCount = useMemo(
    () => sessions.filter(s => s.active === false).length,
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
              {orderedSessions.length} active
              {inactiveCount > 0 && (
                <span style={{ color: 'var(--dash-text-muted)', marginLeft: 6 }}>
                  · {totalSessionCount} total
                </span>
              )}
            </span>

            {dashboardFocusedSession && (
              <>
                <span style={{ color: 'var(--dash-text-muted)', fontSize: 10 }}>{'\u00b7'}</span>
                <span style={{
                  fontFamily: 'var(--dash-font-data)',
                  fontSize: 10,
                  color: 'var(--dash-accent)',
                }}>
                  Focused: {(() => { const fs = orderedSessions.find(s => s.sessionId === dashboardFocusedSession); return fs?.sessionName || fs?.cwd?.split('/').pop() || dashboardFocusedSession.slice(0, 8); })()}
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
          {(() => {
            const isFew = orderedSessions.length > 0 && orderedSessions.length <= 2;
            return (
            <div
              className="flex-1 p-4"
              style={{ overflow: isFew ? 'hidden' : 'auto' }}
            >
            {orderedSessions.length === 0 ? (
              <EmptyState />
            ) : (
              <div
                className="grid gap-4"
                style={{
                  gridTemplateColumns: orderedSessions.length === 1
                    ? '1fr'
                    : orderedSessions.length === 2
                    ? 'repeat(2, 1fr)'
                    : 'repeat(auto-fill, minmax(380px, 1fr))',
                  height: isFew ? '100%' : 'auto',
                  gridTemplateRows: isFew ? '1fr' : 'auto',
                  maxWidth: '100%',
                }}
                onClick={() => setDashboardFocusedSession(null)}
              >
                {orderedSessions.map((session, index) => (
                  <SessionCard
                    key={session.sessionId}
                    session={session}
                    events={eventsBySession.get(session.sessionId) ?? []}
                    isFocused={dashboardFocusedSession === session.sessionId}
                    onFocus={handleFocus}
                    onDismiss={handleDismiss}
                    onDrilldown={handleDrilldown}
                    onDrilldownToLogs={handleDrilldownToLogs}
                    index={index}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDragEnd={handleDragEnd}
                    isDragging={dragIndex === index}
                    isDragOver={dragOverIndex === index}
                    totalCards={orderedSessions.length}
                  />
                ))}
              </div>
            )}
            </div>
            );
          })()}
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
      <svg
        width="56"
        height="56"
        viewBox="0 0 56 56"
        fill="none"
        style={{ opacity: 0.15, color: 'var(--dash-accent)' }}
        aria-hidden="true"
      >
        <circle cx="28" cy="28" r="24" stroke="currentColor" strokeWidth="1.5"/>
        <circle cx="28" cy="28" r="15" stroke="currentColor" strokeWidth="1"/>
        <circle cx="28" cy="28" r="5" stroke="currentColor" strokeWidth="1"/>
        <line x1="28" y1="4" x2="28" y2="52" stroke="currentColor" strokeWidth="0.5"/>
        <line x1="4" y1="28" x2="52" y2="28" stroke="currentColor" strokeWidth="0.5"/>
      </svg>
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
        Sessions will appear here when agents connect. Start a Claude Code, Codex, or other supported harness session.
      </div>
    </div>
  );
}

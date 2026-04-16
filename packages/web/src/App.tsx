import React, { useRef, useState, useCallback, useEffect, Suspense, lazy } from 'react';
import { Header } from './components/layout/Header.js';
import { EventStream } from './components/layout/EventStream.js';
const FlowchartView = lazy(() => import('./components/flowchart/FlowchartView.js').then(m => ({ default: m.FlowchartView })));
const TimelineView = lazy(() => import('./components/flowchart/TimelineView.js').then(m => ({ default: m.TimelineView })));
const DashboardView = lazy(() => import('./components/dashboard/DashboardView.js').then(m => ({ default: m.DashboardView })));
import { InvestigationPanel } from './components/layout/InvestigationPanel.js';
import { SetupBanner } from './components/layout/SetupBanner.js';
import { SetupWizard } from './components/wizard/SetupWizard.js';
import { SettingsDrawer } from './components/controls/SettingsDrawer.js';
import { BookmarksPanel } from './components/bookmarks/BookmarksPanel.js';
import { AccessLogPanel } from './components/access/AccessLogPanel.js';
import { DriftBlockDialog } from './components/drift/DriftBlockDialog.js';
import { ChangelogModal } from './components/shared/ChangelogModal.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { usePendingApprovals } from './hooks/usePendingApprovals.js';
import { hasChangelog } from './hooks/useChangelog.js';
import type { SetupStatus } from './lib/types.js';

const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'mistral-vibe': 'Mistral Vibe',
  cline: 'Cline',
  codex: 'Codex',
  opencode: 'OpenCode',
};

function StatusBar() {
  const { events, sessionStatus, serverVersion, sessions, activeSessionId, sessionMetrics, dashboardDismissedSessions } = useSessionStore((s) => ({
    events: s.events,
    sessionStatus: s.sessionStatus,
    serverVersion: s.serverVersion,
    sessions: s.sessions,
    activeSessionId: s.activeSessionId,
    sessionMetrics: s.sessionMetrics,
    dashboardDismissedSessions: s.dashboardDismissedSessions,
  }));
  const { count } = usePendingApprovals();
  const [changelogOpen, setChangelogOpen] = useState(false);

  // Determine the single active harness (if unambiguous).
  // Exclude sessions marked inactive OR dismissed by the user (dismissed = user explicitly closed them).
  const activeSessions = sessions.filter((s) => s.active !== false && !dashboardDismissedSessions.has(s.sessionId));
  let activeAgentType: string | null = null;
  let effectiveSessionId: string | null = activeSessionId;
  if (activeSessionId) {
    const sess = sessions.find((s) => s.sessionId === activeSessionId);
    activeAgentType = sess?.agentType ?? null;
  } else if (activeSessions.length > 0) {
    const types = [...new Set(activeSessions.map((s) => s.agentType))];
    if (types.length === 1) {
      activeAgentType = types[0];
      effectiveSessionId = activeSessions[activeSessions.length - 1].sessionId;
    }
  }

  const metrics = effectiveSessionId ? sessionMetrics.get(effectiveSessionId) : undefined;
  const harnessVersion = activeAgentType === 'claude-code' ? metrics?.claudeCodeVersion : undefined;
  const modelName = metrics?.modelDisplayName;
  const displayName = activeAgentType ? (HARNESS_DISPLAY_NAMES[activeAgentType] ?? activeAgentType) : null;
  const canShowChangelog = activeAgentType ? hasChangelog(activeAgentType) : false;

  return (
    <>
      <div data-print-hide className="flex items-center justify-between px-4 py-1.5 bg-[#161b22] border-t border-[#30363d] text-[10px] text-[#8b949e] shrink-0">
        <div className="flex items-center gap-3">
          {count > 0 && (
            <span className="text-[#d29922] font-medium animate-pulse">
              ⚡ {count} pending {count === 1 ? 'approval' : 'approvals'}
            </span>
          )}
          <span>{events.length} events</span>
          {sessionStatus && (
            <>
              <span>·</span>
              <span>Uptime: {sessionStatus.uptime}s</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-[#484f58]">
          {displayName && (
            <>
              {canShowChangelog ? (
                <button
                  onClick={() => setChangelogOpen(true)}
                  className="hover:text-[#8b949e] transition-colors"
                  title={`View ${displayName} changelog`}
                >
                  {displayName}{harnessVersion ? ` v${harnessVersion}` : ''}
                </button>
              ) : (
                <span>{displayName}{harnessVersion ? ` v${harnessVersion}` : ''}</span>
              )}
              <span className="text-[#30363d]">|</span>
            </>
          )}
          {modelName && (
            <>
              <span className="text-[#6e7681]">{modelName}</span>
              <span className="text-[#30363d]">|</span>
            </>
          )}
          <span>Layman {serverVersion ? `v${serverVersion}` : ''}</span>
        </div>
      </div>
      {changelogOpen && activeAgentType && (
        <ChangelogModal
          agentType={activeAgentType}
          activeVersion={harnessVersion}
          onClose={() => setChangelogOpen(false)}
        />
      )}
    </>
  );
}

export function App() {
  const { send } = useWebSocket();
  const investigationOpen = useSessionStore((s) => s.investigationOpen);
  const flowchartOpen = useSessionStore((s) => s.flowchartOpen);
  const setFlowchartOpen = useSessionStore((s) => s.setFlowchartOpen);
  const flowchartViewMode = useSessionStore((s) => s.flowchartViewMode);
  const setFlowchartViewMode = useSessionStore((s) => s.setFlowchartViewMode);
  const dashboardOpen = useSessionStore((s) => s.dashboardOpen);
  const setDashboardOpen = useSessionStore((s) => s.setDashboardOpen);
  const returnToDashboard = useSessionStore((s) => s.returnToDashboard);
  const returnFromDashboardDrilldown = useSessionStore((s) => s.returnFromDashboardDrilldown);
  const setSetupStatus = useSessionStore((s) => s.setSetupStatus);
  const [leftWidthPct, setLeftWidthPct] = useState(60);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Fetch setup status on mount
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/setup/status');
        if (res.ok) {
          const status = await res.json() as SetupStatus;
          setSetupStatus(status);
        }
      } catch {
        // Server may not be reachable yet
      }
    })();
  }, [setSetupStatus]);

  const handleSetupInstall = useCallback(() => {
    send({ type: 'setup:install' });
  }, [send]);

  const onDividerMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    e.preventDefault();
  }, []);

  // Global keyboard shortcuts: F=flowchart, G/T=graph/timeline, D=dashboard
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case 'd':
          setDashboardOpen(true);
          setFlowchartOpen(false);
          break;
        case 's':
          setDashboardOpen(false);
          setFlowchartOpen(false);
          break;
        case 'f':
          setDashboardOpen(false);
          setFlowchartOpen(true);
          break;
        case 'g':
          if (flowchartOpen && !dashboardOpen) setFlowchartViewMode('graph');
          break;
        case 't':
          if (flowchartOpen && !dashboardOpen) setFlowchartViewMode('timeline');
          break;
        case 'escape':
          if (returnToDashboard) {
            returnFromDashboardDrilldown();
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [flowchartOpen, dashboardOpen, returnToDashboard, setFlowchartOpen, setFlowchartViewMode, setDashboardOpen, returnFromDashboardDrilldown]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidthPct(Math.max(25, Math.min(85, pct)));
    };
    const onMouseUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Dashboard view takes over the entire content area
  if (dashboardOpen) {
    return (
      <div className="flex flex-col h-screen bg-[#0d1117] text-[#e6edf3] overflow-hidden">
        <Header />
        <SetupBanner onInstall={handleSetupInstall} />
        <div className="flex-1 overflow-hidden">
          <Suspense fallback={<div className="flex items-center justify-center h-full text-[#484f58] text-xs">Loading dashboard...</div>}>
            <DashboardView onSend={send} />
          </Suspense>
        </div>
        <StatusBar />
        <SettingsDrawer onSend={send} />
        <BookmarksPanel onSend={send} />
        <AccessLogPanel />
        <SetupWizard onSend={send} />
        <DriftBlockDialog onSend={send} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-[#e6edf3] overflow-hidden">
      <Header />
      <SetupBanner onInstall={handleSetupInstall} />

      {/* Back to Dashboard banner when drilled down from Dashboard */}
      {returnToDashboard && (
        <div data-print-hide className="flex items-center gap-2 px-4 py-1.5 shrink-0" style={{ background: '#0c1018', borderBottom: '1px solid #1a2535' }}>
          <button
            className="dash-back-btn"
            onClick={returnFromDashboardDrilldown}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06Z"/></svg>
            Back to Dashboard
          </button>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: '#5a6a7a' }}>ESC</span>
        </div>
      )}

      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        {/* Left panel: Event timeline or Flowchart */}
        <div
          className="flex flex-col min-w-0 overflow-hidden"
          style={{ width: investigationOpen ? `${leftWidthPct}%` : '100%' }}
        >
          {flowchartOpen ? (
            <div className="flex flex-col h-full">
              {/* Graph / Timeline tab bar */}
              <div data-print-hide className="flex items-center gap-1 px-3 py-1.5 bg-[#161b22] border-b border-[#30363d] shrink-0">
                <button
                  onClick={() => setFlowchartViewMode('graph')}
                  className={`text-[10px] font-mono px-2.5 py-1 rounded transition-colors ${
                    flowchartViewMode === 'graph'
                      ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
                      : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                  }`}
                >
                  Graph
                </button>
                <button
                  onClick={() => setFlowchartViewMode('timeline')}
                  className={`text-[10px] font-mono px-2.5 py-1 rounded transition-colors ${
                    flowchartViewMode === 'timeline'
                      ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
                      : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                  }`}
                >
                  Timeline
                </button>
                <span className="text-[9px] text-[#484f58] ml-2">G / T</span>
              </div>
              <div className="flex-1 min-h-0">
                <Suspense fallback={<div className="flex items-center justify-center h-full text-[#484f58] text-xs">Loading...</div>}>
                  {flowchartViewMode === 'graph' ? <FlowchartView /> : <TimelineView />}
                </Suspense>
              </div>
            </div>
          ) : (
            <EventStream onSend={send} />
          )}
        </div>

        {/* Drag handle */}
        {investigationOpen && (
          <div
            data-print-hide
            className="w-1 shrink-0 bg-[#30363d] hover:bg-[#58a6ff]/50 active:bg-[#58a6ff] cursor-col-resize transition-colors select-none"
            onMouseDown={onDividerMouseDown}
          />
        )}

        {/* Right panel: Investigation */}
        {investigationOpen && (
          <div data-print-hide className="flex flex-col flex-1 min-w-0 overflow-hidden">
            <InvestigationPanel onSend={send} />
          </div>
        )}
      </div>

      <StatusBar />

      {/* Settings drawer */}
      <SettingsDrawer onSend={send} />

      {/* Bookmarks panel */}
      <BookmarksPanel onSend={send} />

      {/* Access log panel */}
      <AccessLogPanel />

      {/* First-run setup wizard */}
      <SetupWizard onSend={send} />

      {/* Drift block pop-up */}
      <DriftBlockDialog onSend={send} />
    </div>
  );
}

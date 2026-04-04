import React, { useRef, useState, useCallback, useEffect, Suspense, lazy } from 'react';
import { Header } from './components/layout/Header.js';
import { EventStream } from './components/layout/EventStream.js';
const FlowchartView = lazy(() => import('./components/flowchart/FlowchartView.js').then(m => ({ default: m.FlowchartView })));
const TimelineView = lazy(() => import('./components/flowchart/TimelineView.js').then(m => ({ default: m.TimelineView })));
import { InvestigationPanel } from './components/layout/InvestigationPanel.js';
import { SetupBanner } from './components/layout/SetupBanner.js';
import { SetupModal } from './components/layout/SetupModal.js';
import { SettingsDrawer } from './components/controls/SettingsDrawer.js';
import { BookmarksPanel } from './components/bookmarks/BookmarksPanel.js';
import { AccessLogPanel } from './components/access/AccessLogPanel.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { usePendingApprovals } from './hooks/usePendingApprovals.js';
import type { SetupStatus } from './lib/types.js';

function StatusBar() {
  const { events, sessionStatus } = useSessionStore((s) => ({
    events: s.events,
    sessionStatus: s.sessionStatus,
  }));
  const { count } = usePendingApprovals();

  return (
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
      <span className="text-[#484f58]">Layman v0.1.0</span>
    </div>
  );
}

export function App() {
  const { send } = useWebSocket();
  const investigationOpen = useSessionStore((s) => s.investigationOpen);
  const flowchartOpen = useSessionStore((s) => s.flowchartOpen);
  const setFlowchartOpen = useSessionStore((s) => s.setFlowchartOpen);
  const flowchartViewMode = useSessionStore((s) => s.flowchartViewMode);
  const setFlowchartViewMode = useSessionStore((s) => s.setFlowchartViewMode);
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

  // Global keyboard shortcuts: F to toggle flowchart, G/T to switch graph/timeline
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case 'f':
          setFlowchartOpen(!flowchartOpen);
          break;
        case 'g':
          if (flowchartOpen) setFlowchartViewMode('graph');
          break;
        case 't':
          if (flowchartOpen) setFlowchartViewMode('timeline');
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [flowchartOpen, setFlowchartOpen, setFlowchartViewMode]);

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

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-[#e6edf3] overflow-hidden">
      <Header />
      <SetupBanner onInstall={handleSetupInstall} />

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

      {/* First-run setup modal */}
      <SetupModal />
    </div>
  );
}

import React, { useRef, useState, useCallback, useEffect, Suspense, lazy } from 'react';
import { Header } from './components/layout/Header.js';
import { ExpandingLayout } from './components/layout/ExpandingLayout.js';
const FlowchartView = lazy(() => import('./components/flowchart/FlowchartView.js').then(m => ({ default: m.FlowchartView })));
import { InvestigationPanel } from './components/layout/InvestigationPanel.js';
import { SetupBanner } from './components/layout/SetupBanner.js';
import { SetupWizard } from './components/wizard/SetupWizard.js';
import { SettingsDrawer } from './components/controls/SettingsDrawer.js';
import { SessionsView } from './components/sessions/SessionsView.js';
import { PromptsView } from './components/sessions/PromptsView.js';
import { AccessLogPanel } from './components/access/AccessLogPanel.js';
import { DriftBlockDialog } from './components/drift/DriftBlockDialog.js';
import { ChangelogModal } from './components/shared/ChangelogModal.js';
import { RouteErrorPanel } from './components/layout/RouteErrorPanel.js';
import { TTSBar } from './components/tts/TTSBar.js';
import { BoltIcon } from './components/primitives/index.js';
import { useSessionStore } from './stores/sessionStore.js';
import type { SessionState } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useLaymanRoute } from './hooks/useLaymanRoute.js';
import { useTTS } from './hooks/useTTS.js';
import { usePendingApprovals } from './hooks/usePendingApprovals.js';
import { hasChangelog, HARNESS_DISPLAY_NAMES } from './hooks/useChangelog.js';
import { shallow } from 'zustand/shallow';
import type { SetupStatus } from './lib/types.js';
import type { ClientMessage } from './lib/ws-protocol.js';

const WS_STATUS_CONFIG = {
  connecting:   { color: 'var(--warn)',  glow: true,  text: 'Connecting'   },
  connected:    { color: 'var(--ok)',    glow: true,  text: 'Connected'    },
  disconnected: { color: 'var(--text-faint)', glow: false, text: 'Disconnected' },
  error:        { color: 'var(--error)', glow: false, text: 'Error'        },
};

function StatusBar() {
  // Derive only scalars inside the selector so useShallow can compare primitives.
  // This prevents re-renders from Map/Array reference churn (sessionMetrics rebuilds
  // on every assistant turn; sessions rebuilds on every session change).
  const { eventCount, sessionStatus, serverVersion, wsStatus, activeAgentType, harnessVersion, modelName } =
    useSessionStore(
      (s: SessionState) => {
        const dismissed = s.dashboardDismissedSessions;
        // Exclude inactive or user-dismissed sessions
        const activeSessions = s.sessions.filter(
          (sess) => sess.active !== false && !dismissed.has(sess.sessionId)
        );

        // Determine the single active harness (if unambiguous).
        // effectiveSessionId starts null so a dismissed activeSessionId never leaks into metrics.
        let agentType: string | null = null;
        let effectiveSessionId: string | null = null;
        if (s.activeSessionId && !dismissed.has(s.activeSessionId)) {
          const sess = s.sessions.find((x) => x.sessionId === s.activeSessionId);
          agentType = sess?.agentType ?? null;
          effectiveSessionId = s.activeSessionId;
        } else {
          const types = [...new Set(activeSessions.map((x) => x.agentType))];
          if (types.length === 1) {
            agentType = types[0];
            effectiveSessionId = activeSessions[activeSessions.length - 1].sessionId;
          }
        }

        const metrics = effectiveSessionId ? s.sessionMetrics.get(effectiveSessionId) : undefined;
        return {
          eventCount: s.events.length,
          sessionStatus: s.sessionStatus,
          serverVersion: s.serverVersion,
          wsStatus: s.wsStatus,
          activeAgentType: agentType,
          harnessVersion: agentType === 'claude-code' ? metrics?.claudeCodeVersion : undefined,
          modelName: metrics?.modelDisplayName,
        };
      },
      shallow
    );

  const { count } = usePendingApprovals();
  const [changelogOpen, setChangelogOpen] = useState<string | null>(null);

  const displayName = activeAgentType ? (HARNESS_DISPLAY_NAMES[activeAgentType] ?? activeAgentType) : null;
  const canShowChangelog = activeAgentType !== null && hasChangelog(activeAgentType);

  const { color: wsColor, glow: wsGlow, text: wsText } = WS_STATUS_CONFIG[wsStatus];

  const dotStyle: React.CSSProperties = {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: wsColor,
    flexShrink: 0,
    boxShadow: wsGlow ? `0 0 8px ${wsColor}b3` : 'none',
  };

  return (
    <>
      <div
        data-print-hide
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 16px',
          background: 'var(--bg-raised)',
          borderTop: '1px solid var(--border)',
          fontSize: 10,
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {count > 0 && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--warn)', fontWeight: 500 }}>
              <BoltIcon size={10} />
              {count} pending {count === 1 ? 'approval' : 'approvals'}
            </span>
          )}
          <span>{eventCount} events</span>
          {sessionStatus && (
            <>
              <span style={{ color: 'var(--border-strong)' }}>·</span>
              <span>Uptime: {sessionStatus.uptime}s</span>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-faint)' }}>
          <TTSBar />
          {displayName && (
            <>
              {canShowChangelog ? (
                <button
                  onClick={() => setChangelogOpen(activeAgentType)}
                  style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, padding: 0 }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
                  title={`View ${displayName} changelog`}
                >
                  {displayName}{harnessVersion ? ` v${harnessVersion}` : ''}
                </button>
              ) : (
                <span>{displayName}{harnessVersion ? ` v${harnessVersion}` : ''}</span>
              )}
              <span style={{ color: 'var(--border)' }}>·</span>
            </>
          )}
          {modelName && (
            <>
              <span style={{ color: 'var(--text-muted)' }}>{modelName}</span>
              <span style={{ color: 'var(--border)' }}>·</span>
            </>
          )}
          <button
            onClick={() => setChangelogOpen('layman')}
            style={{ color: 'inherit', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, padding: 0 }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
            title="View Layman release notes"
          >
            Layman {serverVersion ? `v${serverVersion}` : ''}
          </button>
          <span style={{ color: 'var(--border)' }}>·</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={dotStyle} />
            <span style={{ color: wsColor }}>{wsText}</span>
          </div>
        </div>
      </div>
      {changelogOpen && (
        <ChangelogModal
          agentType={changelogOpen}
          activeVersion={changelogOpen === 'layman' ? (serverVersion || undefined) : harnessVersion}
          onClose={() => setChangelogOpen(null)}
        />
      )}
    </>
  );
}

interface AppShellProps {
  children: React.ReactNode;
  onSend: (msg: ClientMessage) => void;
  onInstall: () => void;
}

function AppShell({ children, onSend, onInstall }: AppShellProps) {
  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <Header />
      <SetupBanner onInstall={onInstall} />
      {children}
      <StatusBar />
      <SettingsDrawer onSend={onSend} />
      <AccessLogPanel />
      <SetupWizard onSend={onSend} />
      <DriftBlockDialog onSend={onSend} />
      <RouteErrorPanel />
    </div>
  );
}

export function App() {
  const { send } = useWebSocket();
  // Binds the address bar to the store in both directions (see useLaymanRoute).
  useLaymanRoute();
  // Queues new agent responses for speech when auto-speak is on.
  useTTS();
  const investigationOpen = useSessionStore((s) => s.investigationOpen);
  const flowchartOpen = useSessionStore((s) => s.flowchartOpen);
  const bookmarksOpen = useSessionStore((s) => s.bookmarksOpen);
  const promptsOpen = useSessionStore((s) => s.promptsOpen);
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

  // Sessions view takes over the entire content area
  if (bookmarksOpen) {
    return (
      <AppShell onSend={send} onInstall={handleSetupInstall}>
        <div className="flex-1 overflow-hidden">
          <SessionsView onSend={send} />
        </div>
      </AppShell>
    );
  }

  // Prompts view takes over the entire content area
  if (promptsOpen) {
    return (
      <AppShell onSend={send} onInstall={handleSetupInstall}>
        <div className="flex-1 overflow-hidden">
          <PromptsView />
        </div>
      </AppShell>
    );
  }

  // Back to Dashboard banner when drilled down from Dashboard
  const backBanner = returnToDashboard && (
    <div
      data-print-hide
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 16px', background: 'var(--bg-raised)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}
    >
      <button
        onClick={returnFromDashboardDrilldown}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '3px 10px', borderRadius: 4,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          color: 'var(--text)',
          background: 'var(--bg-selected)',
          border: '1px solid var(--border-strong)',
          cursor: 'pointer',
        }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M7.78 12.53a.75.75 0 0 1-1.06 0L2.47 8.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 1.06L4.81 7h7.44a.75.75 0 0 1 0 1.5H4.81l2.97 2.97a.75.75 0 0 1 0 1.06Z"/></svg>
        Back to Dashboard
      </button>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>ESC</span>
    </div>
  );

  // Flow view takes over the entire content area (unrelated to the expanding
  // Dashboard/Logs/Investigation/Settings layout — keeps its own simple split)
  if (flowchartOpen) {
    return (
      <AppShell onSend={send} onInstall={handleSetupInstall}>
        {backBanner}
        <div ref={containerRef} className="flex flex-1 overflow-hidden">
          <div
            className="flex flex-col min-w-0 overflow-hidden"
            style={{ width: investigationOpen ? `${leftWidthPct}%` : '100%' }}
          >
            <Suspense fallback={<div className="flex items-center justify-center h-full text-[#484f58] text-xs">Loading...</div>}>
              <FlowchartView />
            </Suspense>
          </div>

          {investigationOpen && (
            <div
              data-print-hide
              className="w-1 shrink-0 bg-[#30363d] hover:bg-[#58a6ff]/50 active:bg-[#58a6ff] cursor-col-resize transition-colors select-none"
              onMouseDown={onDividerMouseDown}
            />
          )}

          {investigationOpen && (
            <div data-print-hide className="flex flex-col flex-1 min-w-0 overflow-hidden">
              <InvestigationPanel onSend={send} />
            </div>
          )}
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell onSend={send} onInstall={handleSetupInstall}>
      {backBanner}
      <ExpandingLayout onSend={send} />
    </AppShell>
  );
}

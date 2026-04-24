import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SessionLaymansTerms } from '../shared/SessionLaymansTerms.js';

function getSessionName(cwd: string, sessionId: string, agentType?: string, showAgentPrefix?: boolean, sessionName?: string): string {
  const name = sessionName || (cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : sessionId.slice(0, 8));
  if (showAgentPrefix && agentType) {
    const prefix = agentType === 'claude-code' ? '[CC]' : agentType === 'codex' ? '[CX]' : agentType === 'opencode' ? '[OC]' : agentType === 'cline' ? '[CL]' : `[${agentType.slice(0, 2).toUpperCase()}]`;
    return `${prefix} ${name}`;
  }
  return name;
}

// Dashboard icon: 2×2 grid of squares
function IconDashboard() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

// Live Session icon: stacked lines with a live pulse dot
function IconLiveSession() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <rect x="4" y="2.5" width="10" height="1.5" rx="0.75" />
      <rect x="4" y="7.25" width="10" height="1.5" rx="0.75" />
      <rect x="4" y="12" width="10" height="1.5" rx="0.75" />
      <circle cx="1.75" cy="3.25" r="1.25" />
      <circle cx="1.75" cy="8" r="1.25" />
      <circle cx="1.75" cy="12.75" r="1.25" />
    </svg>
  );
}

// Flowchart icon: directed node graph (two nodes connected with a branch)
function IconFlowchart() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      {/* Top node */}
      <rect x="5.5" y="0.75" width="5" height="3.5" rx="1" fill="currentColor" stroke="none" />
      {/* Arrow down */}
      <line x1="8" y1="4.25" x2="8" y2="6.5" />
      {/* Fork left */}
      <line x1="8" y1="6.5" x2="3" y2="8" />
      {/* Fork right */}
      <line x1="8" y1="6.5" x2="13" y2="8" />
      {/* Left node */}
      <rect x="0.75" y="8" width="4.5" height="3" rx="1" fill="currentColor" stroke="none" />
      {/* Right node */}
      <rect x="10.75" y="8" width="4.5" height="3" rx="1" fill="currentColor" stroke="none" />
      {/* Join lines */}
      <line x1="3" y1="11" x2="3" y2="13" />
      <line x1="13" y1="11" x2="13" y2="13" />
      <line x1="3" y1="13" x2="13" y2="13" />
      <line x1="8" y1="13" x2="8" y2="15.25" />
      {/* Bottom node */}
      <rect x="5.5" y="12.75" width="5" height="2.5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

type ViewMode = 'dashboard' | 'stream' | 'flowchart';

export function Header() {
  const {
    wsStatus, serverVersion, setSettingsOpen, setBookmarksOpen,
    sessions, activeSessionId, setActiveSession,
    sessionSummary, sessionSummaryHistory, sessionSummaryError, isSummarizingSession, fetchSessionSummary,
    clearSessionSummaryError,
    flowchartOpen, setFlowchartOpen,
    dashboardOpen, setDashboardOpen,
    dashboardFocusedSession, setDashboardFocusedSession,
    sessionMetrics,
    investigatedSessions,
  } = useSessionStore();

  const statusConfig = {
    connecting: { dot: 'bg-[#d29922]', text: 'Connecting...', textColor: 'text-[#d29922]' },
    connected: { dot: 'bg-[#3fb950]', text: 'Connected', textColor: 'text-[#3fb950]' },
    disconnected: { dot: 'bg-[#8b949e]', text: 'Disconnected', textColor: 'text-[#8b949e]' },
    error: { dot: 'bg-[#f85149]', text: 'Error', textColor: 'text-[#f85149]' },
  };

  const { dot, text, textColor } = statusConfig[wsStatus];

  const currentView: ViewMode = dashboardOpen ? 'dashboard' : flowchartOpen ? 'flowchart' : 'stream';

  const setView = (view: ViewMode) => {
    if (view === 'dashboard') {
      setDashboardOpen(true);
      setFlowchartOpen(false);
    } else if (view === 'stream') {
      setDashboardOpen(false);
      setFlowchartOpen(false);
    } else {
      setDashboardOpen(false);
      setFlowchartOpen(true);
    }
  };

  // Current session history entries (filtered to active session)
  const historyForSession = sessionSummaryHistory.filter(
    (h) => h.sessionId === activeSessionId || (!h.sessionId && !activeSessionId)
  );

  const views: { key: ViewMode; label: string; icon: React.ReactNode; shortcut: string }[] = [
    { key: 'dashboard', label: 'Dashboard', icon: <IconDashboard />, shortcut: 'D' },
    { key: 'stream',    label: 'Logs',      icon: <IconLiveSession />, shortcut: 'S' },
    { key: 'flowchart', label: 'Flow',      icon: <IconFlowchart />,  shortcut: 'F' },
  ];

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 bg-[#161b22] border-b border-[#30363d] shrink-0">
      {/* Left: logo + status + session selector (hidden in dashboard) */}
      <div className="flex items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <span
            className="text-sm font-bold text-[#e6edf3] tracking-tight cursor-pointer hover:text-white transition-colors"
            onClick={() => { window.location.href = window.location.origin + '/?t=' + Date.now(); }}
            title="Reload"
          >LAYMAN</span>
          {serverVersion && (
            <a
              href="https://github.com/castellotti/layman"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-[#484f58] font-mono hover:text-[#8b949e] transition-colors"
              title="View on GitHub"
            >v{serverVersion}</a>
          )}
        </div>

        <div className="h-4 w-px bg-[#30363d]" />

        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${dot} ${wsStatus === 'connecting' ? 'animate-pulse' : ''}`} />
          <span className={`text-xs ${textColor}`}>{text}</span>
        </div>

        {/* Session dropdown */}
        {sessions.length > 0 && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />
            {(() => {
              const agentTypes = new Set(sessions.map((s) => s.agentType));
              const showAgentPrefix = agentTypes.size > 1;
              const value = dashboardOpen ? (dashboardFocusedSession ?? '') : (activeSessionId ?? '');
              return (
                <select
                  value={value}
                  onChange={(e) => {
                    if (dashboardOpen) {
                      setDashboardFocusedSession(e.target.value || null);
                    } else {
                      setActiveSession(e.target.value || null);
                    }
                  }}
                  className="text-xs bg-[#21262d] border border-[#30363d] text-[#e6edf3] rounded px-2 py-0.5 focus:outline-none focus:border-[#58a6ff] cursor-pointer"
                  title="Filter by session"
                >
                  {sessions.length > 1 && (
                    <option value="">All sessions</option>
                  )}
                  {sessions.map((s) => {
                    const effectiveName = s.sessionName || sessionMetrics.get(s.sessionId)?.sessionName;
                    const investigated = investigatedSessions.has(s.sessionId);
                    return (
                      <option key={s.sessionId} value={s.sessionId}>
                        {investigated ? '⊙ ' : ''}{getSessionName(s.cwd, s.sessionId, s.agentType, showAgentPrefix, effectiveName)}{s.cwd ? ` · ${s.sessionId.slice(0, 6)}` : ''}
                      </option>
                    );
                  })}
                </select>
              );
            })()}
          </>
        )}
      </div>

      {/* Center: Layman's Terms (hidden in dashboard) */}
      <div className="flex-1 flex items-center justify-center min-w-0 px-2">
        {!dashboardOpen && (
          <SessionLaymansTerms
            summary={sessionSummary}
            summaryHistory={historyForSession}
            summaryError={sessionSummaryError}
            isSummarizing={isSummarizingSession}
            onGenerate={() => void fetchSessionSummary(activeSessionId)}
            onClearError={clearSessionSummaryError}
            className="max-w-xl w-full justify-center"
          />
        )}
      </div>

      {/* Right: view radio group + divider + sessions + settings */}
      <div className="flex items-center gap-2 shrink-0">
        {wsStatus === 'disconnected' && (
          <span className="text-xs text-[#d29922] bg-[#d29922]/10 border border-[#d29922]/30 px-2 py-0.5 rounded-full">
            Auto-reconnecting...
          </span>
        )}

        {/* View radio group */}
        <div className="flex items-center rounded-md overflow-hidden border border-[#30363d]">
          {views.map(({ key, label, icon, shortcut }) => {
            const isActive = currentView === key;
            return (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors text-xs font-mono ${
                  isActive
                    ? key === 'dashboard'
                      ? 'bg-[#00e5ff]/15 text-[#00e5ff]'
                      : 'bg-[#58a6ff]/15 text-[#58a6ff]'
                    : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                }`}
                title={`${label} (${shortcut})`}
              >
                {icon}
                <span className="hidden sm:inline">{label}</span>
              </button>
            );
          })}
        </div>

        {/* Divider */}
        <div className="h-5 w-px bg-[#30363d]" />

        <button
          onClick={() => setBookmarksOpen(true)}
          className="p-1.5 rounded-md text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
          title="Session History"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Zm0 4.75A.75.75 0 0 1 2.25 7.25h11.5a.75.75 0 0 1 0 1.5H2.25A.75.75 0 0 1 1.5 8Zm0 4.75a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Z"/></svg>
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          className="p-1.5 rounded-md text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}

import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SessionLaymansTerms } from '../shared/SessionLaymansTerms.js';

function getSessionName(cwd: string, sessionId: string, agentType?: string, showAgentPrefix?: boolean): string {
  const name = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : sessionId.slice(0, 8);
  if (showAgentPrefix && agentType) {
    const prefix = agentType === 'claude-code' ? '[CC]' : agentType === 'codex' ? '[CX]' : agentType === 'opencode' ? '[OC]' : agentType === 'cline' ? '[CL]' : `[${agentType.slice(0, 2).toUpperCase()}]`;
    return `${prefix} ${name}`;
  }
  return name;
}

export function Header() {
  const {
    wsStatus, serverVersion, setSettingsOpen, setBookmarksOpen,
    sessions, activeSessionId, setActiveSession,
    sessionSummary, sessionSummaryHistory, sessionSummaryError, isSummarizingSession, fetchSessionSummary,
    clearSessionSummaryError,
    flowchartOpen, setFlowchartOpen,
    dashboardOpen, setDashboardOpen,
  } = useSessionStore();

  const statusConfig = {
    connecting: { dot: 'bg-[#d29922]', text: 'Connecting...', textColor: 'text-[#d29922]' },
    connected: { dot: 'bg-[#3fb950]', text: 'Connected', textColor: 'text-[#3fb950]' },
    disconnected: { dot: 'bg-[#8b949e]', text: 'Disconnected', textColor: 'text-[#8b949e]' },
    error: { dot: 'bg-[#f85149]', text: 'Error', textColor: 'text-[#f85149]' },
  };

  const { dot, text, textColor } = statusConfig[wsStatus];

  // Current session history entries (filtered to active session)
  const historyForSession = sessionSummaryHistory.filter(
    (h) => h.sessionId === activeSessionId || (!h.sessionId && !activeSessionId)
  );

  return (
    <header className="flex items-center gap-3 px-4 py-2.5 bg-[#161b22] border-b border-[#30363d] shrink-0">
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

        {sessions.length > 0 && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />
            {(() => {
              const agentTypes = new Set(sessions.map((s) => s.agentType));
              const showAgentPrefix = agentTypes.size > 1;
              return (
                <select
                  value={activeSessionId ?? ''}
                  onChange={(e) => setActiveSession(e.target.value || null)}
                  className="text-xs bg-[#21262d] border border-[#30363d] text-[#e6edf3] rounded px-2 py-0.5 focus:outline-none focus:border-[#58a6ff] cursor-pointer"
                  title="Filter by session"
                >
                  {sessions.length > 1 && (
                    <option value="">All sessions</option>
                  )}
                  {sessions.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {getSessionName(s.cwd, s.sessionId, s.agentType, showAgentPrefix)}{s.cwd ? ` · ${s.sessionId.slice(0, 6)}` : ''}
                    </option>
                  ))}
                </select>
              );
            })()}
          </>
        )}
      </div>

      {/* Session Layman's Terms — center (hidden in dashboard all-sessions mode to avoid summarizing unrelated sessions) */}
      <div className="flex-1 flex items-center justify-center min-w-0 px-2">
        {dashboardOpen && sessions.length > 1 && !activeSessionId ? (
          <span className="text-[10px] text-[#484f58] font-mono">
            Select a session to summarize
          </span>
        ) : (
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

      <div className="flex items-center gap-2 shrink-0">
        {wsStatus === 'disconnected' && (
          <span className="text-xs text-[#d29922] bg-[#d29922]/10 border border-[#d29922]/30 px-2 py-0.5 rounded-full">
            Auto-reconnecting...
          </span>
        )}
        <button
          onClick={() => setDashboardOpen(!dashboardOpen)}
          className={`p-1.5 rounded-md transition-colors ${
            dashboardOpen
              ? 'text-[#00e5ff] bg-[#00e5ff]/10'
              : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d]'
          }`}
          title="Dashboard View (D)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="9" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="9" width="6" height="6" rx="1" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
        </button>
        <button
          onClick={() => { if (!dashboardOpen) setFlowchartOpen(!flowchartOpen); }}
          className={`p-1.5 rounded-md transition-colors ${
            flowchartOpen && !dashboardOpen
              ? 'text-[#58a6ff] bg-[#58a6ff]/10'
              : dashboardOpen
              ? 'text-[#484f58] cursor-not-allowed'
              : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d]'
          }`}
          title="Flowchart View (F)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 2.5A1.5 1.5 0 012.5 1h2A1.5 1.5 0 016 2.5v1A1.5 1.5 0 014.5 5h-2A1.5 1.5 0 011 3.5v-1zm0 5A1.5 1.5 0 012.5 6h2A1.5 1.5 0 016 7.5v1A1.5 1.5 0 014.5 10h-2A1.5 1.5 0 011 8.5v-1zm9-5A1.5 1.5 0 0111.5 1h2A1.5 1.5 0 0115 2.5v1A1.5 1.5 0 0113.5 5h-2A1.5 1.5 0 0110 3.5v-1zm0 5A1.5 1.5 0 0111.5 6h2A1.5 1.5 0 0115 7.5v1A1.5 1.5 0 0113.5 10h-2A1.5 1.5 0 0110 8.5v-1zM6 3h4M6 8h4" />
            <path d="M6 3h4" stroke="currentColor" strokeWidth="1" fill="none" />
            <path d="M6 8h4" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        </button>
        <button
          onClick={() => setBookmarksOpen(true)}
          className="p-1.5 rounded-md text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
          title="Sessions"
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

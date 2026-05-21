import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { SessionLaymansTerms } from '../shared/SessionLaymansTerms.js';
import { saveAndBookmarkSession } from '../../lib/bookmarks-api.js';

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

type ViewMode = 'dashboard' | 'stream' | 'flowchart' | 'sessions';

export function Header() {
  const {
    wsStatus, setSettingsOpen, setBookmarksOpen, bookmarksOpen,
    sessions, activeSessionId, setActiveSession,
    sessionSummary, sessionSummaryHistory, sessionSummaryError, isSummarizingSession, fetchSessionSummary,
    clearSessionSummaryError,
    flowchartOpen, setFlowchartOpen,
    dashboardOpen, setDashboardOpen,
    dashboardFocusedSession, setDashboardFocusedSession,
    sessionMetrics,
    investigatedSessions,
    bookmarks,
  } = useSessionStore();

  const bookmarkedSessionIds = useMemo(
    () => new Set(bookmarks.map((b) => b.sessionId)),
    [bookmarks]
  );

  const [showBookmarkInput, setShowBookmarkInput] = useState(false);
  const [bookmarkName, setBookmarkName] = useState('');

  // Reset bookmark UI when the active session changes
  useEffect(() => {
    setShowBookmarkInput(false);
    setBookmarkName('');
  }, [activeSessionId]);

  const handleBookmarkSession = useCallback(async (name: string) => {
    if (!activeSessionId) return;
    setShowBookmarkInput(false);
    void saveAndBookmarkSession(activeSessionId, name.trim() || activeSessionId.slice(0, 8));
  }, [activeSessionId]);

  const currentView: ViewMode = dashboardOpen ? 'dashboard' : bookmarksOpen ? 'sessions' : flowchartOpen ? 'flowchart' : 'stream';

  const setView = (view: ViewMode) => {
    if (view === 'dashboard') {
      setDashboardOpen(true);
      setFlowchartOpen(false);
      setBookmarksOpen(false);
    } else if (view === 'sessions') {
      setDashboardOpen(false);
      setFlowchartOpen(false);
      setBookmarksOpen(true);
    } else if (view === 'stream') {
      setDashboardOpen(false);
      setFlowchartOpen(false);
      setBookmarksOpen(false);
    } else {
      setDashboardOpen(false);
      setFlowchartOpen(true);
      setBookmarksOpen(false);
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
      {/* Left: logo + session selector */}
      <div className="flex items-center gap-3 shrink-0">
        <a
          href="https://github.com/castellotti/layman"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-bold text-[#e6edf3] tracking-tight hover:text-white transition-colors no-underline"
          title="View on GitHub"
        >LAYMAN</a>

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

        {/* Bookmark button — shown in Logs view when a session is active and not yet bookmarked */}
        {currentView === 'stream' && activeSessionId && !bookmarkedSessionIds.has(activeSessionId) && (
          <>
            {showBookmarkInput ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  type="text"
                  value={bookmarkName}
                  onChange={(e) => setBookmarkName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { void handleBookmarkSession(bookmarkName); }
                    if (e.key === 'Escape') { setShowBookmarkInput(false); }
                  }}
                  placeholder="Bookmark name..."
                  className="text-xs bg-[#0d1117] border border-[#58a6ff] rounded px-2 py-0.5 text-[#e6edf3] placeholder-[#484f58] focus:outline-none w-40"
                />
                <button
                  onClick={() => { void handleBookmarkSession(bookmarkName); }}
                  className="text-xs text-[#3fb950] hover:text-[#56d364] transition-colors"
                >✓</button>
                <button
                  onClick={() => setShowBookmarkInput(false)}
                  className="text-xs text-[#484f58] hover:text-[#8b949e] transition-colors"
                >✕</button>
              </div>
            ) : (
              <button
                onClick={() => {
                  const s = sessions.find(x => x.sessionId === activeSessionId);
                  setBookmarkName(s ? getSessionName(s.cwd, s.sessionId, s.agentType, false, s.sessionName) : activeSessionId.slice(0, 8));
                  setShowBookmarkInput(true);
                }}
                className="p-1.5 rounded-md text-[#8b949e] hover:text-[#d29922] hover:bg-[#30363d] transition-colors"
                title="Bookmark current session"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            )}
          </>
        )}

        {/* Divider */}
        <div className="h-5 w-px bg-[#30363d]" />

        <button
          onClick={() => setView('sessions')}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border transition-colors text-xs font-mono ${
            currentView === 'sessions'
              ? 'bg-[#58a6ff]/15 text-[#58a6ff] border-[#58a6ff]/30'
              : 'border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
          }`}
          title="Session History"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Zm0 4.75A.75.75 0 0 1 2.25 7.25h11.5a.75.75 0 0 1 0 1.5H2.25A.75.75 0 0 1 1.5 8Zm0 4.75a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Z"/></svg>
          <span className="hidden sm:inline">Sessions</span>
        </button>

        {/* Divider */}
        <div className="h-5 w-px bg-[#30363d]" />

        <button
          onClick={() => setSettingsOpen(true)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d] transition-colors text-xs font-mono"
          title="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.436-.272.667-.386.133-.066.194-.158.211-.224l.29-1.106C5.717.645 6.263.095 7.006.031 7.24.01 7.62 0 8 0Zm1.5 8a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z"/></svg>
          <span className="hidden sm:inline">Settings</span>
        </button>
      </div>
    </header>
  );
}

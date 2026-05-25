import React, { useCallback, useEffect } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';

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

type ViewMode = 'dashboard' | 'stream' | 'flowchart' | 'sessions' | 'prompts';

const VIEW_FLAGS: Record<ViewMode, { dashboard: boolean; flowchart: boolean; bookmarks: boolean; prompts: boolean }> = {
  dashboard: { dashboard: true,  flowchart: false, bookmarks: false, prompts: false },
  stream:    { dashboard: false, flowchart: false, bookmarks: false, prompts: false },
  flowchart: { dashboard: false, flowchart: true,  bookmarks: false, prompts: false },
  sessions:  { dashboard: false, flowchart: false, bookmarks: true,  prompts: false },
  prompts:   { dashboard: false, flowchart: false, bookmarks: false, prompts: true  },
};

export function Header() {
  const {
    wsStatus, setSettingsOpen, setBookmarksOpen, bookmarksOpen,
    sessions, activeSessionId, setActiveSession,
    flowchartOpen, setFlowchartOpen,
    flowchartViewMode, setFlowchartViewMode,
    dashboardOpen, setDashboardOpen,
    dashboardFocusedSession, setDashboardFocusedSession,
    returnToDashboard, returnFromDashboardDrilldown,
    sessionMetrics,
    investigatedSessions,
    promptsOpen, setPromptsOpen,
  } = useSessionStore();

  const currentView: ViewMode = dashboardOpen ? 'dashboard' : bookmarksOpen ? 'sessions' : promptsOpen ? 'prompts' : flowchartOpen ? 'flowchart' : 'stream';

  const setView = useCallback((view: ViewMode) => {
    const flags = VIEW_FLAGS[view];
    setDashboardOpen(flags.dashboard);
    setFlowchartOpen(flags.flowchart);
    setBookmarksOpen(flags.bookmarks);
    setPromptsOpen(flags.prompts);
  }, [setDashboardOpen, setFlowchartOpen, setBookmarksOpen, setPromptsOpen]);

  // Global keyboard shortcuts: D=dashboard, S=logs, F=flowchart, G/T=graph/timeline, Escape=back/close
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case 'd': setView('dashboard'); break;
        case 's': setView('stream'); break;
        case 'f': setView('flowchart'); break;
        case 'g':
          if (flowchartOpen && !dashboardOpen) setFlowchartViewMode('graph');
          break;
        case 't':
          if (flowchartOpen && !dashboardOpen) setFlowchartViewMode('timeline');
          break;
        case 'escape':
          if (returnToDashboard) {
            returnFromDashboardDrilldown();
          } else if (bookmarksOpen || promptsOpen) {
            setView('stream');
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [setView, flowchartOpen, dashboardOpen, bookmarksOpen, promptsOpen, returnToDashboard, setFlowchartViewMode, returnFromDashboardDrilldown]);

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

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right: view radio group + divider + sessions + settings */}
      <div className="flex items-center gap-2 shrink-0">
        {wsStatus === 'disconnected' && (
          <span className="text-xs text-[#d29922] bg-[#d29922]/10 border border-[#d29922]/30 px-2 py-0.5 rounded-full">
            Auto-reconnecting...
          </span>
        )}

        {/* View radio group */}
        <div className="flex items-center rounded-md overflow-hidden border border-[#30363d]">
          {views.map(({ key, label, icon, shortcut }, i) => {
            const isActive = currentView === key;
            return (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors text-xs font-mono ${i > 0 ? 'border-l border-[#30363d]' : ''} ${
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

        {/* Sessions + Prompts grouped */}
        <div className="flex items-center rounded-md overflow-hidden border border-[#30363d]">
          <button
            onClick={() => setView('sessions')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors text-xs font-mono ${
              currentView === 'sessions'
                ? 'bg-[#58a6ff]/15 text-[#58a6ff]'
                : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
            }`}
            title="Session History"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 3.25a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Zm0 4.75A.75.75 0 0 1 2.25 7.25h11.5a.75.75 0 0 1 0 1.5H2.25A.75.75 0 0 1 1.5 8Zm0 4.75a.75.75 0 0 1 .75-.75h11.5a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1-.75-.75Z"/></svg>
            <span className="hidden sm:inline">Sessions</span>
          </button>
          <button
            onClick={() => setView('prompts')}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors text-xs font-mono border-l border-[#30363d] ${
              currentView === 'prompts'
                ? 'bg-[#bc8cff]/15 text-[#bc8cff]'
                : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
            }`}
            title="Prompt Highlights"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215Z"/></svg>
            <span className="hidden sm:inline">Prompts</span>
          </button>
        </div>

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

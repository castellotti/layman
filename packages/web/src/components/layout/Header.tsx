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

type ViewMode = 'dashboard' | 'stream' | 'flowchart' | 'sessions' | 'prompts';

const VIEW_FLAGS: Record<ViewMode, { dashboard: boolean; flowchart: boolean; bookmarks: boolean; prompts: boolean }> = {
  dashboard: { dashboard: true,  flowchart: false, bookmarks: false, prompts: false },
  stream:    { dashboard: false, flowchart: false, bookmarks: false, prompts: false },
  flowchart: { dashboard: false, flowchart: true,  bookmarks: false, prompts: false },
  sessions:  { dashboard: false, flowchart: false, bookmarks: true,  prompts: false },
  prompts:   { dashboard: false, flowchart: false, bookmarks: false, prompts: true  },
};

const NAV_TABS: { key: ViewMode; label: string; shortcut: string }[] = [
  { key: 'dashboard', label: 'Dashboard', shortcut: 'D' },
  { key: 'stream',    label: 'Logs',      shortcut: 'S' },
  { key: 'flowchart', label: 'Flow',      shortcut: 'F' },
  { key: 'sessions',  label: 'Sessions',  shortcut: '' },
  { key: 'prompts',   label: 'Prompts',   shortcut: '' },
];

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

  // Global keyboard shortcuts
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

  const isDashboard = currentView === 'dashboard';

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: '0 16px',
        height: 40,
        background: 'var(--bg-raised)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        fontFamily: 'var(--font-ui)',
      }}
    >
      {/* Wordmark */}
      <a
        href="https://github.com/castellotti/layman"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontFamily: 'var(--font-ui)',
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: '0.08em',
          color: 'var(--accent)',
          textDecoration: 'none',
          marginRight: 20,
          flexShrink: 0,
          userSelect: 'none',
        }}
        title="View on GitHub"
      >
        LAYMAN
      </a>

      {/* Nav tabs */}
      <nav style={{ display: 'flex', alignItems: 'stretch', height: '100%', gap: 0 }}>
        {NAV_TABS.map(({ key, label, shortcut }) => {
          const isActive = currentView === key;
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              title={shortcut ? `${label} (${shortcut})` : label}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 14px',
                fontSize: 12,
                fontWeight: isActive ? 600 : 400,
                fontFamily: 'var(--font-ui)',
                color: isActive ? '#0B0E14' : 'var(--text-muted)',
                background: isActive ? 'var(--accent)' : 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'color 0.15s, background 0.15s',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
              }}
              onMouseLeave={(e) => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
              }}
            >
              {label}
            </button>
          );
        })}
      </nav>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Disconnected badge */}
      {wsStatus === 'disconnected' && (
        <span style={{
          fontSize: 10,
          color: 'var(--warn)',
          background: 'rgba(229,168,59,0.12)',
          border: '1px solid rgba(229,168,59,0.3)',
          padding: '2px 8px',
          borderRadius: 10,
          marginRight: 12,
          fontFamily: 'var(--font-ui)',
        }}>
          Auto-reconnecting…
        </span>
      )}

      {/* Session picker — hidden on Dashboard (all-sessions view) */}
      {!isDashboard && sessions.length > 0 && (
        <div style={{ marginRight: 12 }}>
          {(() => {
            const agentTypes = new Set(sessions.map((s) => s.agentType));
            const showAgentPrefix = agentTypes.size > 1;
            const value = activeSessionId ?? '';
            return (
              <select
                value={value}
                onChange={(e) => setActiveSession(e.target.value || null)}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text)',
                  borderRadius: 5,
                  padding: '3px 8px',
                  cursor: 'pointer',
                  outline: 'none',
                  maxWidth: 200,
                }}
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
        </div>
      )}

      {/* Settings */}
      <button
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '5px 10px',
          fontSize: 11,
          fontFamily: 'var(--font-ui)',
          color: 'var(--text-muted)',
          background: 'transparent',
          border: '1px solid var(--border-strong)',
          borderRadius: 5,
          cursor: 'pointer',
          transition: 'color 0.15s, border-color 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-faint)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)';
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.436-.272.667-.386.133-.066.194-.158.211-.224l.29-1.106C5.717.645 6.263.095 7.006.031 7.24.01 7.62 0 8 0Zm1.5 8a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z"/>
        </svg>
        <span>Settings</span>
      </button>
    </header>
  );
}

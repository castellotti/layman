import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';

function getSessionName(cwd: string, sessionId: string, agentType?: string, showAgentPrefix?: boolean): string {
  const name = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : sessionId.slice(0, 8);
  if (showAgentPrefix && agentType) {
    const prefix = agentType === 'claude-code' ? '[CC]' : agentType === 'opencode' ? '[OC]' : `[${agentType.slice(0, 2).toUpperCase()}]`;
    return `${prefix} ${name}`;
  }
  return name;
}

export function Header() {
  const { wsStatus, serverVersion, sessionStatus, setSettingsOpen, setBookmarksOpen, sessions, activeSessionId, setActiveSession } = useSessionStore();

  const statusConfig = {
    connecting: { dot: 'bg-[#d29922]', text: 'Connecting...', textColor: 'text-[#d29922]' },
    connected: { dot: 'bg-[#3fb950]', text: 'Connected', textColor: 'text-[#3fb950]' },
    disconnected: { dot: 'bg-[#8b949e]', text: 'Disconnected', textColor: 'text-[#8b949e]' },
    error: { dot: 'bg-[#f85149]', text: 'Error', textColor: 'text-[#f85149]' },
  };

  const { dot, text, textColor } = statusConfig[wsStatus];

  return (
    <header className="flex items-center justify-between px-4 py-2.5 bg-[#161b22] border-b border-[#30363d] shrink-0">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[#e6edf3] tracking-tight">LAYMAN</span>
          {serverVersion && (
            <span className="text-[10px] text-[#484f58] font-mono">v{serverVersion}</span>
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

      <div className="flex items-center gap-2">
        {wsStatus === 'disconnected' && (
          <span className="text-xs text-[#d29922] bg-[#d29922]/10 border border-[#d29922]/30 px-2 py-0.5 rounded-full">
            Auto-reconnecting...
          </span>
        )}
        <button
          onClick={() => setBookmarksOpen(true)}
          className="p-1.5 rounded-md text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors"
          title="Bookmarks"
        >
          🔖
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

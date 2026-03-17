import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';

export function Header() {
  const { wsStatus, serverVersion, sessionStatus, setSettingsOpen } = useSessionStore();

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

        {sessionStatus?.sessionId && (
          <>
            <div className="h-4 w-px bg-[#30363d]" />
            <span className="text-xs text-[#8b949e] font-mono">
              Session: {sessionStatus.sessionId.slice(0, 8)}
            </span>
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

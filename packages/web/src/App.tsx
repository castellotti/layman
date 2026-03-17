import React from 'react';
import { Header } from './components/layout/Header.js';
import { EventStream } from './components/layout/EventStream.js';
import { InvestigationPanel } from './components/layout/InvestigationPanel.js';
import { SettingsDrawer } from './components/controls/SettingsDrawer.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { usePendingApprovals } from './hooks/usePendingApprovals.js';

function StatusBar() {
  const { events, sessionStatus } = useSessionStore((s) => ({
    events: s.events,
    sessionStatus: s.sessionStatus,
  }));
  const { count } = usePendingApprovals();

  return (
    <div className="flex items-center justify-between px-4 py-1.5 bg-[#161b22] border-t border-[#30363d] text-[10px] text-[#8b949e] shrink-0">
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

  return (
    <div className="flex flex-col h-screen bg-[#0d1117] text-[#e6edf3] overflow-hidden">
      <Header />

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Event timeline */}
        <div
          className={`flex flex-col min-w-0 transition-all ${
            investigationOpen ? 'flex-1' : 'flex-1'
          }`}
          style={{ flexBasis: investigationOpen ? '60%' : '100%', maxWidth: investigationOpen ? '60%' : '100%' }}
        >
          <EventStream onSend={send} />
        </div>

        {/* Right panel: Investigation */}
        {investigationOpen && (
          <div className="flex flex-col" style={{ flexBasis: '40%', minWidth: '320px', maxWidth: '500px' }}>
            <InvestigationPanel onSend={send} />
          </div>
        )}
      </div>

      <StatusBar />

      {/* Settings drawer */}
      <SettingsDrawer onSend={send} />
    </div>
  );
}

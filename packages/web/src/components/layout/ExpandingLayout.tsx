import React, { useMemo, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useExpandingLayout, LOGS_MIN } from '../../hooks/useExpandingLayout.js';
import { DashboardView } from '../dashboard/DashboardView.js';
import { EventStream } from './EventStream.js';
import { InvestigationPanel } from './InvestigationPanel.js';
import { SettingsDock } from '../controls/SettingsDock.js';
import { PanelDivider } from './PanelDivider.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

// Measuring against the full live event set would grow unbounded on long sessions;
// the widest row is overwhelmingly likely to already appear in a recent window.
const MEASURE_SAMPLE = 500;

interface ExpandingLayoutProps {
  onSend: (msg: ClientMessage) => void;
}

export function ExpandingLayout({ onSend }: ExpandingLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const events = useSessionStore((s) => s.events);
  const selectedEventId = useSessionStore((s) => s.selectedEventId);
  const investigationOpen = useSessionStore((s) => s.investigationOpen);
  const setSplitOverride = useSessionStore((s) => s.setSplitOverride);

  const measureSample = useMemo(
    () => (events.length > MEASURE_SAMPLE ? events.slice(-MEASURE_SAMPLE) : events),
    [events]
  );

  const layout = useExpandingLayout(containerRef, measureSample);

  const showInvestigationDrawer = investigationOpen && selectedEventId !== null && !layout.showInvestigation;

  return (
    <div ref={containerRef} style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
      {layout.showDashboard && (
        <div
          style={{
            display: 'flex',
            flex: layout.showLogs ? '0 0 auto' : '1 1 0',
            width: layout.showLogs ? layout.dashboardWidth : undefined,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <DashboardView
            onSend={onSend}
            sessionListWidth={layout.sessionListWidth}
            onResizeSessionList={(w) => setSplitOverride('session', w)}
          />
        </div>
      )}

      {layout.showDashboard && layout.showLogs && (
        <PanelDivider
          value={layout.dashboardWidth}
          min={760}
          max={Math.max(800, layout.viewportWidth - LOGS_MIN)}
          direction={1}
          onChange={(w) => setSplitOverride('dashboard', w)}
          title="Drag to resize Dashboard · resets to default when panels change"
        />
      )}

      {layout.showLogs && (
        <div style={{ display: 'flex', flex: '1 1 0', minWidth: 0, overflow: 'hidden' }}>
          <EventStream onSend={onSend} />
        </div>
      )}

      {layout.showLogs && layout.showInvestigation && (
        <PanelDivider
          value={layout.investigationWidth}
          min={380}
          max={720}
          direction={-1}
          onChange={(w) => setSplitOverride('investigation', w)}
          title="Drag to resize Investigation · resets to default when panels change"
        />
      )}

      {layout.showInvestigation && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: layout.investigationWidth,
            flexShrink: 0,
            overflow: 'hidden',
            animation: 'panelIn 0.25s ease',
          }}
        >
          <InvestigationPanel onSend={onSend} presentation="docked" />
        </div>
      )}

      {layout.showSettings && (
        <div style={{ animation: 'panelIn 0.25s ease' }}>
          <SettingsDock onSend={onSend} />
        </div>
      )}

      {showInvestigationDrawer && <InvestigationPanel onSend={onSend} presentation="drawer" />}
    </div>
  );
}

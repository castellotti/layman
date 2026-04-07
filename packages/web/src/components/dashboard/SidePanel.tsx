import React, { useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { ActivitySparkline } from './ActivitySparkline.js';
import { TokenUsageChart } from './TokenUsageChart.js';
import { EventDensityTimeline } from './EventDensityTimeline.js';
import { DriftMonitorPanel } from './DriftMonitorPanel.js';
import type { TimelineEvent } from '../../lib/types.js';

interface SidePanelProps {
  events: TimelineEvent[];
  focusedSessionId: string | null;
}

/** Summary stats across all (or focused) sessions */
function QuickStats({ events, focusedSessionId }: SidePanelProps) {
  const stats = useMemo(() => {
    const filtered = focusedSessionId
      ? events.filter(e => e.sessionId === focusedSessionId)
      : events;

    let tools = 0, risk = 0, prompts = 0, responses = 0;
    for (const e of filtered) {
      if (e.type.startsWith('tool_call_')) tools++;
      if (e.riskLevel === 'medium' || e.riskLevel === 'high') risk++;
      if (e.type === 'user_prompt') prompts++;
      if (e.type === 'agent_response') responses++;
    }
    return { tools, risk, prompts, responses, total: filtered.length };
  }, [events, focusedSessionId]);

  const items = [
    { label: 'Events', value: stats.total, color: 'var(--dash-text-primary)' },
    { label: 'Tools', value: stats.tools, color: 'var(--dash-accent)' },
    { label: 'Prompts', value: stats.prompts, color: '#58a6ff' },
    { label: 'Risky', value: stats.risk, color: stats.risk > 0 ? 'var(--dash-medium)' : 'var(--dash-text-muted)' },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map(item => (
        <div
          key={item.label}
          className="rounded-md p-2"
          style={{ background: 'var(--dash-bg)', border: '1px solid var(--dash-border-subtle)' }}
        >
          <div
            style={{
              fontFamily: 'var(--dash-font-data)',
              fontSize: 18,
              fontWeight: 600,
              color: item.color,
              lineHeight: 1,
            }}
          >
            {item.value}
          </div>
          <div
            style={{
              fontFamily: 'var(--dash-font-data)',
              fontSize: 8,
              color: 'var(--dash-text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              marginTop: 2,
            }}
          >
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SidePanel({ events, focusedSessionId }: SidePanelProps) {
  const { sessions, sessionMetrics } = useSessionStore(s => ({
    sessions: s.sessions,
    sessionMetrics: s.sessionMetrics,
  }));

  return (
    <div className="dash-side-panel flex flex-col h-full">
      {/* Quick stats */}
      <div className="dash-panel-section">
        <div className="dash-panel-title">
          {focusedSessionId ? 'Session Stats' : 'Overview'}
        </div>
        <QuickStats events={events} focusedSessionId={focusedSessionId} />
      </div>

      {/* Activity histogram */}
      <div className="dash-panel-section">
        <div className="dash-panel-title">Activity</div>
        <ActivitySparkline
          events={events}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
          height={56}
        />
      </div>

      {/* Token usage */}
      <div className="dash-panel-section">
        <div className="dash-panel-title">Token Usage</div>
        <TokenUsageChart
          sessionMetrics={sessionMetrics}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
        />
      </div>

      {/* Drift monitor */}
      <div className="dash-panel-section">
        <div className="dash-panel-title">Drift Monitor</div>
        <DriftMonitorPanel focusedSessionId={focusedSessionId} />
      </div>

      {/* All sessions density timeline */}
      <div className="dash-panel-section flex-1">
        <div className="dash-panel-title">
          {focusedSessionId ? 'Session Timeline' : 'All Sessions'}
        </div>
        <EventDensityTimeline
          events={events}
          sessions={sessions}
          focusedSessionId={focusedSessionId}
        />
      </div>
    </div>
  );
}

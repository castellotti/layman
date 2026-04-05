import React, { useMemo } from 'react';
import type { SessionMetrics } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';

interface TokenUsageChartProps {
  sessionMetrics: Map<string, SessionMetrics>;
  sessions: SessionInfo[];
  focusedSessionId: string | null;
  height?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function TokenUsageChart({
  sessionMetrics,
  sessions,
  focusedSessionId,
  height = 80,
}: TokenUsageChartProps) {
  const data = useMemo(() => {
    const entries: Array<{
      sessionId: string;
      name: string;
      input: number;
      output: number;
      cost: number;
    }> = [];

    const targetSessions = focusedSessionId
      ? sessions.filter(s => s.sessionId === focusedSessionId)
      : sessions;

    for (const session of targetSessions) {
      const m = sessionMetrics.get(session.sessionId);
      if (!m) continue;
      const input = m.totalInputTokens ?? 0;
      const output = m.totalOutputTokens ?? 0;
      if (input === 0 && output === 0) continue;
      const name = session.cwd
        ? session.cwd.split('/').filter(Boolean).pop() ?? session.sessionId.slice(0, 6)
        : session.sessionId.slice(0, 6);
      entries.push({
        sessionId: session.sessionId,
        name,
        input,
        output,
        cost: m.costUsd ?? 0,
      });
    }

    return entries;
  }, [sessionMetrics, sessions, focusedSessionId]);

  if (data.length === 0) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 10, color: 'var(--dash-text-muted)' }}>
          No token data
        </span>
      </div>
    );
  }

  const maxTokens = Math.max(...data.map(d => d.input + d.output));
  const barHeight = Math.min(20, (height - 8) / data.length - 4);

  return (
    <div className="flex flex-col gap-1.5">
      {data.map((d) => {
        const total = d.input + d.output;
        const inputPct = maxTokens > 0 ? (d.input / maxTokens) * 100 : 0;
        const outputPct = maxTokens > 0 ? (d.output / maxTokens) * 100 : 0;

        return (
          <div key={d.sessionId} className="flex flex-col gap-0.5">
            {/* Label row */}
            <div className="flex items-center justify-between">
              <span style={{
                fontFamily: 'var(--dash-font-data)',
                fontSize: 9,
                color: 'var(--dash-text-secondary)',
              }}>
                {d.name}
              </span>
              <span style={{
                fontFamily: 'var(--dash-font-data)',
                fontSize: 9,
                color: 'var(--dash-text-muted)',
              }}>
                {formatTokens(total)}{d.cost > 0 ? ` \u00b7 $${d.cost < 1 ? d.cost.toFixed(3) : d.cost.toFixed(2)}` : ''}
              </span>
            </div>
            {/* Bar */}
            <div
              className="flex rounded overflow-hidden"
              style={{ height: barHeight, background: 'var(--dash-bg)' }}
            >
              <div
                style={{
                  width: `${inputPct}%`,
                  background: 'var(--dash-accent)',
                  opacity: 0.6,
                  transition: 'width 0.3s ease',
                }}
              />
              <div
                style={{
                  width: `${outputPct}%`,
                  background: '#a371f7',
                  opacity: 0.6,
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
        );
      })}
      {/* Legend */}
      <div className="flex items-center gap-3 pt-1">
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm" style={{ background: 'var(--dash-accent)', opacity: 0.6 }} />
          <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color: 'var(--dash-text-muted)' }}>Input</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-2 h-2 rounded-sm" style={{ background: '#a371f7', opacity: 0.6 }} />
          <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color: 'var(--dash-text-muted)' }}>Output</span>
        </div>
      </div>
    </div>
  );
}

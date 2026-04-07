import React, { useCallback } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { DriftLevel, DriftState } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';

const DRIFT_COLORS: Record<DriftLevel, string> = {
  green: '#00e676',
  yellow: '#ffb300',
  orange: '#ff9100',
  red: '#ff3d57',
};

function DriftBar({
  label,
  pct,
  level,
  tooltip,
  onClick,
}: {
  label: string;
  pct: number;
  level: DriftLevel;
  tooltip?: string;
  onClick?: () => void;
}) {
  const color = DRIFT_COLORS[level];
  return (
    <div
      className="flex items-center justify-between gap-2"
      style={{ cursor: onClick ? 'pointer' : undefined }}
      title={tooltip}
      onClick={onClick}
    >
      <span
        style={{
          fontFamily: 'var(--dash-font-data)',
          fontSize: 9,
          color: 'var(--dash-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <div className="flex items-center gap-1.5 flex-1">
        <div
          className="flex-1 h-1.5 rounded-full overflow-hidden"
          style={{ background: 'var(--dash-bg)' }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(pct, 100)}%`,
              backgroundColor: color,
              transition: 'width 0.5s ease, background-color 0.3s ease',
            }}
          />
        </div>
        <span
          style={{
            fontFamily: 'var(--dash-font-data)',
            fontSize: 10,
            color,
            minWidth: 28,
            textAlign: 'right',
          }}
        >
          {Math.round(pct)}%
        </span>
      </div>
    </div>
  );
}

function buildSessionTooltip(ds: DriftState): string {
  const parts: string[] = [];
  parts.push(`Session drift: ${Math.round(ds.sessionGoalDriftPct)}% (${ds.sessionGoalDriftLevel})`);
  if (ds.sessionGoalSummary) parts.push(ds.sessionGoalSummary);
  if (ds.sessionGoalIndicators?.length) {
    for (const ind of ds.sessionGoalIndicators) {
      parts.push(`  \u2022 ${ind}`);
    }
  }
  return parts.join('\n');
}

function buildRulesTooltip(ds: DriftState): string {
  const parts: string[] = [];
  parts.push(`Rules drift: ${Math.round(ds.rulesDriftPct)}% (${ds.rulesDriftLevel})`);
  if (ds.rulesSummary) parts.push(ds.rulesSummary);
  if (ds.rulesViolations?.length) {
    for (const v of ds.rulesViolations) {
      parts.push(`  \u2022 [${v.severity}] ${v.rule}: ${v.action}`);
    }
  }
  return parts.join('\n');
}

function getSessionDisplayName(session: SessionInfo | undefined, sessionId: string): string {
  if (session?.sessionName) return session.sessionName;
  if (session?.cwd) return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  return sessionId.slice(0, 8);
}

interface DriftMonitorPanelProps {
  focusedSessionId: string | null;
}

export function DriftMonitorPanel({ focusedSessionId }: DriftMonitorPanelProps) {
  const { driftState, sessions, config, events, navigateFromDashboardToLogs } = useSessionStore((s) => ({
    driftState: s.driftState,
    sessions: s.sessions,
    config: s.config,
    events: s.events,
    navigateFromDashboardToLogs: s.navigateFromDashboardToLogs,
  }));

  if (!config?.driftMonitoring?.enabled) return null;

  // Determine which sessions to show
  const relevantSessionIds = focusedSessionId
    ? [focusedSessionId]
    : sessions.map((s) => s.sessionId);

  // Collect sessions that have drift data
  const sessionsWithData: Array<{ sessionId: string; ds: DriftState }> = [];
  for (const sid of relevantSessionIds) {
    const ds = driftState.get(sid);
    if (ds) sessionsWithData.push({ sessionId: sid, ds });
  }

  const handleBarClick = useCallback((sessionId: string, driftType: 'session_goal' | 'rules') => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (
        (e.type === 'drift_check' || e.type === 'drift_alert') &&
        e.sessionId === sessionId &&
        e.data.driftType === driftType
      ) {
        navigateFromDashboardToLogs(sessionId, e.id);
        return;
      }
    }
  }, [events, navigateFromDashboardToLogs]);

  if (sessionsWithData.length === 0) {
    return (
      <div
        style={{
          fontFamily: 'var(--dash-font-data)',
          fontSize: 10,
          color: 'var(--dash-text-muted)',
          textAlign: 'center',
          padding: '8px 0',
        }}
      >
        Awaiting first check...
      </div>
    );
  }

  // Single session (focused or only one with data): show without header
  if (sessionsWithData.length === 1) {
    const { sessionId, ds } = sessionsWithData[0];
    return (
      <div className="space-y-2">
        <DriftBar
          label="Session"
          pct={ds.sessionGoalDriftPct}
          level={ds.sessionGoalDriftLevel}
          tooltip={buildSessionTooltip(ds)}
          onClick={() => handleBarClick(sessionId, 'session_goal')}
        />
        <DriftBar
          label="Rules"
          pct={ds.rulesDriftPct}
          level={ds.rulesDriftLevel}
          tooltip={buildRulesTooltip(ds)}
          onClick={() => handleBarClick(sessionId, 'rules')}
        />
      </div>
    );
  }

  // Multiple sessions: show per-session groups separated by name
  return (
    <div className="space-y-1">
      {sessionsWithData.map(({ sessionId, ds }, idx) => {
        const session = sessions.find((s) => s.sessionId === sessionId);
        const name = getSessionDisplayName(session, sessionId);
        return (
          <div key={sessionId}>
            {idx > 0 && (
              <div style={{ borderTop: '1px solid var(--dash-border)', margin: '4px 0' }} />
            )}
            <div
              style={{
                fontFamily: 'var(--dash-font-data)',
                fontSize: 9,
                color: 'var(--dash-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                marginBottom: 3,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={sessionId}
            >
              {name}
            </div>
            <div className="space-y-1">
              <DriftBar
                label="Session"
                pct={ds.sessionGoalDriftPct}
                level={ds.sessionGoalDriftLevel}
                tooltip={buildSessionTooltip(ds)}
                onClick={() => handleBarClick(sessionId, 'session_goal')}
              />
              <DriftBar
                label="Rules"
                pct={ds.rulesDriftPct}
                level={ds.rulesDriftLevel}
                tooltip={buildRulesTooltip(ds)}
                onClick={() => handleBarClick(sessionId, 'rules')}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

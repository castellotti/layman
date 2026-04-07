import React, { useCallback, useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { DriftLevel, DriftState } from '../../lib/types.js';

const DRIFT_COLORS: Record<DriftLevel, string> = {
  green: '#00e676',
  yellow: '#ffb300',
  orange: '#ff9100',
  red: '#ff3d57',
};

function worstLevel(a: DriftLevel, b: DriftLevel): DriftLevel {
  const order: Record<DriftLevel, number> = { green: 0, yellow: 1, orange: 2, red: 3 };
  return order[a] >= order[b] ? a : b;
}

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

  // Determine which sessions to aggregate
  const relevantSessionIds = focusedSessionId
    ? [focusedSessionId]
    : sessions.map((s) => s.sessionId);

  // Aggregate: take worst-case across relevant sessions
  let sessionGoalPct = 0;
  let rulesPct = 0;
  let sessionGoalLevel: DriftLevel = 'green';
  let rulesLevel: DriftLevel = 'green';
  let hasData = false;
  let worstSessionDs: DriftState | null = null;
  let worstRulesDs: DriftState | null = null;

  for (const sid of relevantSessionIds) {
    const ds = driftState.get(sid);
    if (!ds) continue;
    hasData = true;
    if (ds.sessionGoalDriftPct >= sessionGoalPct) {
      sessionGoalPct = ds.sessionGoalDriftPct;
      sessionGoalLevel = worstLevel(sessionGoalLevel, ds.sessionGoalDriftLevel);
      worstSessionDs = ds;
    }
    if (ds.rulesDriftPct >= rulesPct) {
      rulesPct = ds.rulesDriftPct;
      rulesLevel = worstLevel(rulesLevel, ds.rulesDriftLevel);
      worstRulesDs = ds;
    }
  }

  // Build tooltips from worst-case session data
  const sessionTooltip = worstSessionDs ? buildSessionTooltip(worstSessionDs) : undefined;
  const rulesTooltip = worstRulesDs ? buildRulesTooltip(worstRulesDs) : undefined;

  // Click handler: navigate to the latest drift_check event in Logs
  const handleBarClick = useCallback((driftType: 'session_goal' | 'rules') => {
    const targetSessionId = driftType === 'session_goal'
      ? worstSessionDs?.sessionId
      : worstRulesDs?.sessionId;
    if (!targetSessionId) return;

    // Find latest drift_check or drift_alert for this session + type
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (
        (e.type === 'drift_check' || e.type === 'drift_alert') &&
        e.sessionId === targetSessionId &&
        e.data.driftType === driftType
      ) {
        navigateFromDashboardToLogs(targetSessionId, e.id);
        return;
      }
    }
  }, [events, worstSessionDs?.sessionId, worstRulesDs?.sessionId, navigateFromDashboardToLogs]);

  if (!hasData) {
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

  return (
    <div className="space-y-2">
      <DriftBar
        label="Session"
        pct={sessionGoalPct}
        level={sessionGoalLevel}
        tooltip={sessionTooltip}
        onClick={() => handleBarClick('session_goal')}
      />
      <DriftBar
        label="Rules"
        pct={rulesPct}
        level={rulesLevel}
        tooltip={rulesTooltip}
        onClick={() => handleBarClick('rules')}
      />
    </div>
  );
}

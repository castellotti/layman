import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import type { DriftLevel } from '../../lib/types.js';

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

function DriftBar({ label, pct, level }: { label: string; pct: number; level: DriftLevel }) {
  const color = DRIFT_COLORS[level];
  return (
    <div className="flex items-center justify-between gap-2">
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

interface DriftMonitorPanelProps {
  focusedSessionId: string | null;
}

export function DriftMonitorPanel({ focusedSessionId }: DriftMonitorPanelProps) {
  const { driftState, sessions, config } = useSessionStore((s) => ({
    driftState: s.driftState,
    sessions: s.sessions,
    config: s.config,
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

  for (const sid of relevantSessionIds) {
    const ds = driftState.get(sid);
    if (!ds) continue;
    hasData = true;
    sessionGoalPct = Math.max(sessionGoalPct, ds.sessionGoalDriftPct);
    rulesPct = Math.max(rulesPct, ds.rulesDriftPct);
    sessionGoalLevel = worstLevel(sessionGoalLevel, ds.sessionGoalDriftLevel);
    rulesLevel = worstLevel(rulesLevel, ds.rulesDriftLevel);
  }

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
      <DriftBar label="Session" pct={sessionGoalPct} level={sessionGoalLevel} />
      <DriftBar label="Rules" pct={rulesPct} level={rulesLevel} />
    </div>
  );
}

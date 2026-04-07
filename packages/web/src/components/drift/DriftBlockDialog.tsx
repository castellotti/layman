import React, { useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { usePendingApprovals } from '../../hooks/usePendingApprovals.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { DriftLevel } from '../../lib/types.js';

const DRIFT_COLORS: Record<DriftLevel, string> = {
  green: '#00e676',
  yellow: '#ffb300',
  orange: '#ff9100',
  red: '#ff3d57',
};

interface DriftBlockDialogProps {
  onSend: (msg: ClientMessage) => void;
}

export function DriftBlockDialog({ onSend }: DriftBlockDialogProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [decided, setDecided] = useState<Set<string>>(new Set());

  const { approvals } = usePendingApprovals();
  const driftState = useSessionStore((s) => s.driftState);

  // Find drift-block approvals that haven't been locally dismissed
  const driftBlockApproval = useMemo(
    () => approvals.find((a) => a.isDriftBlock && !dismissed.has(a.id)),
    [approvals, dismissed],
  );

  if (!driftBlockApproval) return null;

  const ds = driftState.get(driftBlockApproval.toolInput.session_id as string)
    ?? [...driftState.values()].find((d) => d.sessionId);
  const sessionId = (driftBlockApproval.toolInput.session_id as string)
    ?? ds?.sessionId ?? '';

  const isDecided = decided.has(driftBlockApproval.id);

  const handleContinue = () => {
    setDecided((prev) => new Set(prev).add(driftBlockApproval.id));
    onSend({
      type: 'approval:decide',
      approvalId: driftBlockApproval.id,
      decision: { decision: 'allow' },
    });
  };

  const handleDismissFalsePositive = () => {
    setDecided((prev) => new Set(prev).add(driftBlockApproval.id));
    onSend({
      type: 'drift:dismiss',
      sessionId,
      approvalId: driftBlockApproval.id,
    });
  };

  const handleKeepPaused = () => {
    setDismissed((prev) => new Set(prev).add(driftBlockApproval.id));
  };

  // Gather drift info for display
  const sessionPct = ds?.sessionGoalDriftPct ?? 0;
  const sessionLevel = ds?.sessionGoalDriftLevel ?? 'green';
  const rulesPct = ds?.rulesDriftPct ?? 0;
  const rulesLevel = ds?.rulesDriftLevel ?? 'green';
  const summary = ds?.sessionGoalSummary || ds?.rulesSummary || 'Drift threshold exceeded.';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleKeepPaused}
    >
      <div
        className="relative bg-[#161b22] border border-[#30363d] rounded-lg shadow-2xl max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-base"
            style={{ background: 'rgba(255, 61, 87, 0.15)', color: '#ff3d57' }}
          >
            !
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[#e6edf3]">
              Drift Monitor — Session Paused
            </h2>
            <p className="text-xs text-[#8b949e] mt-0.5">
              Agent activity has been halted due to drift detection
            </p>
          </div>
        </div>

        {/* Drift bars */}
        <div className="px-5 py-3 space-y-2">
          <DriftBarMini label="Session Drift" pct={sessionPct} level={sessionLevel} />
          <DriftBarMini label="Rules Drift" pct={rulesPct} level={rulesLevel} />
        </div>

        {/* Summary */}
        <div className="px-5 pb-3">
          <p className="text-xs text-[#8b949e] leading-relaxed">{summary}</p>
          {ds?.sessionGoalIndicators && ds.sessionGoalIndicators.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {ds.sessionGoalIndicators.map((ind, i) => (
                <li key={i} className="text-xs text-[#8b949e] flex items-start gap-1.5">
                  <span style={{ color: '#d29922' }}>&#x2022;</span>
                  {ind}
                </li>
              ))}
            </ul>
          )}
          {ds?.rulesViolations && ds.rulesViolations.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {ds.rulesViolations.map((v, i) => (
                <li key={i} className="text-xs text-[#8b949e] flex items-start gap-1.5">
                  <span style={{ color: '#f85149' }}>&#x2022;</span>
                  <span><strong className="text-[#e6edf3]">{v.rule}</strong>: {v.action}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Blocked tool info */}
        <div className="px-5 pb-3">
          <div
            className="text-[10px] px-2 py-1 rounded"
            style={{ background: 'rgba(210, 153, 34, 0.1)', border: '1px solid rgba(210, 153, 34, 0.2)' }}
          >
            <span className="text-[#d29922]">Blocked tool:</span>{' '}
            <span className="text-[#e6edf3] font-mono">{driftBlockApproval.toolName}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="px-5 pb-5 space-y-2">
          {isDecided ? (
            <div className="text-xs text-[#8b949e] italic text-center py-2">
              Decision sent — waiting for agent to continue...
            </div>
          ) : (
            <>
              <div className="flex gap-2">
                <button
                  onClick={handleContinue}
                  className="flex-1 px-3 py-2 text-xs font-semibold rounded-md bg-[#238636] hover:bg-[#2ea043] text-white transition-colors border border-[#3fb950]/30"
                >
                  Continue
                </button>
                <button
                  onClick={handleDismissFalsePositive}
                  className="flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-colors border"
                  style={{
                    background: 'rgba(210, 153, 34, 0.15)',
                    borderColor: 'rgba(210, 153, 34, 0.3)',
                    color: '#d29922',
                  }}
                >
                  Dismiss as False Positive
                </button>
              </div>
              <button
                onClick={handleKeepPaused}
                className="w-full px-3 py-2 text-xs font-medium rounded-md bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] transition-colors border border-[#30363d]"
              >
                Keep Paused
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DriftBarMini({ label, pct, level }: { label: string; pct: number; level: DriftLevel }) {
  const color = DRIFT_COLORS[level];
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] text-[#8b949e] w-20 text-right" style={{ fontFamily: 'var(--dash-font-data, monospace)' }}>
        {label}
      </span>
      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: '#21262d' }}>
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
        className="text-xs font-semibold w-10 text-right"
        style={{ fontFamily: 'var(--dash-font-data, monospace)', color }}
      >
        {Math.round(pct)}%
      </span>
    </div>
  );
}

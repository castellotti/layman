import React from 'react';
import type { AnalysisResult } from '../../lib/types.js';

interface AnalysisCardProps {
  analysis: AnalysisResult;
  compact?: boolean;
}

const SAFETY_ICONS: Record<string, string> = {
  safe: '🟢',
  caution: '🟡',
  danger: '🔴',
};

const RISK_ICONS: Record<string, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🔴',
};

const RISK_COLORS: Record<string, string> = {
  low: 'text-[var(--ok)]',
  medium: 'text-[var(--warn)]',
  high: 'text-[var(--error)]',
};

const FIELD_TOOLTIPS = {
  intent: 'What this action does in plain English. Names specific files, packages, or operations.',
  goal: 'What the agent is likely trying to accomplish overall.',
  safety: 'safe: Read-only or trivially reversible.\ncaution: Modifies state but is reversible.\ndanger: Destructive or hard to reverse (e.g., rm -rf, DROP TABLE, force push).',
  security: 'safe: No external calls, installs, or credential handling.\ncaution: Installs packages, contacts external services, or modifies config.\ndanger: Exposes credentials, opens ports, installs from untrusted sources, or disables security features.',
  risk: 'low: Safe to approve without concern.\nmedium: Review before approving — has side effects but unlikely to cause harm.\nhigh: Carefully evaluate — could cause data loss, security exposure, or system damage.',
};

export function AnalysisCard({ analysis, compact = false }: AnalysisCardProps) {
  return (
    <div className="text-xs space-y-1.5 font-mono">
      <div className="flex gap-2">
        <span className="text-[var(--text-muted)] shrink-0 w-20 cursor-help underline decoration-dotted decoration-[color:var(--text-faint)]" title={FIELD_TOOLTIPS.intent}>Intent:</span>
        <span className="text-[var(--text)]">{analysis.meaning}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-[var(--text-muted)] shrink-0 w-20 cursor-help underline decoration-dotted decoration-[color:var(--text-faint)]" title={FIELD_TOOLTIPS.goal}>Goal:</span>
        <span className="text-[var(--text)]">{analysis.goal}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-[var(--text-muted)] shrink-0 w-20 cursor-help underline decoration-dotted decoration-[color:var(--text-faint)]" title={FIELD_TOOLTIPS.safety}>Safety:</span>
        <span className="text-[var(--text)]">
          {SAFETY_ICONS[analysis.safety.level]} {analysis.safety.summary}
        </span>
      </div>
      <div className="flex gap-2">
        <span className="text-[var(--text-muted)] shrink-0 w-20 cursor-help underline decoration-dotted decoration-[color:var(--text-faint)]" title={FIELD_TOOLTIPS.security}>Security:</span>
        <span className="text-[var(--text)]">
          {SAFETY_ICONS[analysis.security.level]} {analysis.security.summary}
        </span>
      </div>
      <div className="flex gap-2">
        <span className="text-[var(--text-muted)] shrink-0 w-20 cursor-help underline decoration-dotted decoration-[color:var(--text-faint)]" title={FIELD_TOOLTIPS.risk}>Risk:</span>
        <span className={RISK_COLORS[analysis.risk.level]}>
          {RISK_ICONS[analysis.risk.level]} {analysis.risk.level.toUpperCase()} — {analysis.risk.summary}
        </span>
      </div>

      <div className={`mt-2 pt-2 border-t border-[var(--border-strong)] flex items-center gap-2 text-[10px] text-[var(--text-faint)] flex-wrap`}>
        {!compact && <><span>Model: {analysis.model}</span><span>·</span></>}
        <span>{analysis.latencyMs}ms</span>
        <span>·</span>
        <span className="text-[color-mix(in_srgb,var(--ok)_70%,transparent)]">↑{analysis.tokens.input.toLocaleString()}</span>
        <span className="text-[color-mix(in_srgb,var(--info)_70%,transparent)]">↓{analysis.tokens.output.toLocaleString()}</span>
        {!compact && <><span>·</span><span>{(analysis.tokens.input + analysis.tokens.output).toLocaleString()} total</span></>}
      </div>
    </div>
  );
}

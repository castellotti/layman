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
  low: 'text-[#3fb950]',
  medium: 'text-[#d29922]',
  high: 'text-[#f85149]',
};

export function AnalysisCard({ analysis, compact = false }: AnalysisCardProps) {
  return (
    <div className="text-xs space-y-1.5 font-mono">
      <div className="flex gap-2">
        <span className="text-[#8b949e] shrink-0 w-20">Meaning:</span>
        <span className="text-[#e6edf3]">{analysis.meaning}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-[#8b949e] shrink-0 w-20">Goal:</span>
        <span className="text-[#e6edf3]">{analysis.goal}</span>
      </div>
      <div className="flex gap-2">
        <span className="text-[#8b949e] shrink-0 w-20">Safety:</span>
        <span className="text-[#e6edf3]">
          {SAFETY_ICONS[analysis.safety.level]} {analysis.safety.summary}
        </span>
      </div>
      <div className="flex gap-2">
        <span className="text-[#8b949e] shrink-0 w-20">Security:</span>
        <span className="text-[#e6edf3]">
          {SAFETY_ICONS[analysis.security.level]} {analysis.security.summary}
        </span>
      </div>
      <div className="flex gap-2">
        <span className="text-[#8b949e] shrink-0 w-20">Risk:</span>
        <span className={RISK_COLORS[analysis.risk.level]}>
          {RISK_ICONS[analysis.risk.level]} {analysis.risk.level.toUpperCase()} — {analysis.risk.summary}
        </span>
      </div>

      <div className={`mt-2 pt-2 border-t border-[#30363d] flex items-center gap-2 text-[10px] text-[#484f58] flex-wrap`}>
        {!compact && <><span>Model: {analysis.model}</span><span>·</span></>}
        <span>{analysis.latencyMs}ms</span>
        <span>·</span>
        <span className="text-[#3fb950]/70">↑{analysis.tokens.input.toLocaleString()}</span>
        <span className="text-[#58a6ff]/70">↓{analysis.tokens.output.toLocaleString()}</span>
        {!compact && <><span>·</span><span>{(analysis.tokens.input + analysis.tokens.output).toLocaleString()} total</span></>}
      </div>
    </div>
  );
}

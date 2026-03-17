import React from 'react';
import type { AnalysisResult } from '../../lib/types.js';

interface AnalysisBadgeProps {
  analysis: AnalysisResult;
}

const LEVEL_ICONS = {
  safe: '🟢',
  caution: '🟡',
  danger: '🔴',
  low: '🟢',
  medium: '🟡',
  high: '🔴',
};

export function AnalysisBadge({ analysis }: AnalysisBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[#8b949e]">
      {LEVEL_ICONS[analysis.risk.level]} {analysis.risk.level.toUpperCase()}
    </span>
  );
}

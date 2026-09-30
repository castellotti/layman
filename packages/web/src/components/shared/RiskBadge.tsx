import React from 'react';

interface RiskBadgeProps {
  level: 'low' | 'medium' | 'high';
  compact?: boolean;
}

const RISK_CONFIG = {
  low: { label: 'LOW', dot: '🟢', textColor: 'text-[var(--ok)]', bgColor: 'bg-[color-mix(in_srgb,var(--ok)_10%,transparent)]', borderColor: 'border-[color-mix(in_srgb,var(--ok)_30%,transparent)]' },
  medium: { label: 'MED', dot: '🟡', textColor: 'text-[var(--warn)]', bgColor: 'bg-[color-mix(in_srgb,var(--warn)_10%,transparent)]', borderColor: 'border-[color-mix(in_srgb,var(--warn)_30%,transparent)]' },
  high: { label: 'HIGH', dot: '🔴', textColor: 'text-[var(--error)]', bgColor: 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)]', borderColor: 'border-[color-mix(in_srgb,var(--error)_30%,transparent)]' },
};

export function RiskBadge({ level, compact = false }: RiskBadgeProps) {
  const config = RISK_CONFIG[level];

  if (compact) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-medium ${config.textColor}`}>
        {config.dot} {config.label}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${config.textColor} ${config.bgColor} ${config.borderColor}`}
    >
      {config.dot} {config.label}
    </span>
  );
}

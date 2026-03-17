import React from 'react';

interface RiskBadgeProps {
  level: 'low' | 'medium' | 'high';
  compact?: boolean;
}

const RISK_CONFIG = {
  low: { label: 'LOW', dot: '🟢', textColor: 'text-[#3fb950]', bgColor: 'bg-[#3fb950]/10', borderColor: 'border-[#3fb950]/30' },
  medium: { label: 'MED', dot: '🟡', textColor: 'text-[#d29922]', bgColor: 'bg-[#d29922]/10', borderColor: 'border-[#d29922]/30' },
  high: { label: 'HIGH', dot: '🔴', textColor: 'text-[#f85149]', bgColor: 'bg-[#f85149]/10', borderColor: 'border-[#f85149]/30' },
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

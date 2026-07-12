import React from 'react';
import { SegmentRow } from './primitives.js';

export type RiskLevel = 'all' | 'medium' | 'high' | 'none';

const RISK_OPTIONS: { label: string; value: RiskLevel }[] = [
  { label: 'All', value: 'all' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'None', value: 'none' },
];

/**
 * Shared All/Medium/High/None segmented control reused by Auto-Explain and
 * Auto-Analysis (Auto-Approve uses its own All/Medium/Low/None variant below).
 */
export function RiskLevelPicker({
  label, verb, value, onChange,
}: {
  label: string;
  /** e.g. "explain" / "analyze" — used to build the per-level description */
  verb: string;
  value: RiskLevel;
  onChange: (v: RiskLevel) => void;
}) {
  const descs: Record<RiskLevel, string> = {
    all: `${verb} every tool call`,
    medium: `${verb} medium and high-risk tool calls`,
    high: `${verb} only high-risk tool calls`,
    none: 'manual only — click Quick or Detailed per event',
  };
  return (
    <SegmentRow label={label} desc={descs[value]} options={RISK_OPTIONS} value={value} onChange={onChange} />
  );
}

export type DepthLevel = 'quick' | 'detailed';

const DEPTH_OPTIONS: { label: string; value: DepthLevel }[] = [
  { label: 'Quick', value: 'quick' },
  { label: 'Detailed', value: 'detailed' },
];

export function DepthPicker({ value, onChange }: { value: DepthLevel; onChange: (v: DepthLevel) => void }) {
  return <SegmentRow label="Depth" options={DEPTH_OPTIONS} value={value} onChange={onChange} />;
}

export type ApproveLevel = 'all' | 'medium' | 'low' | 'none';

const APPROVE_OPTIONS: { label: string; value: ApproveLevel }[] = [
  { label: 'All', value: 'all' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
  { label: 'None', value: 'none' },
];

const APPROVE_DESCS: Record<ApproveLevel, string> = {
  all: 'every tool call is auto-approved',
  medium: 'low + medium risk auto-approved; high requires sign-off',
  low: 'only low-risk tools auto-approved; medium + high require sign-off',
  none: 'every tool call requires manual approval',
};

export function AutoApproveLevelPicker({ value, onChange }: { value: ApproveLevel; onChange: (v: ApproveLevel) => void }) {
  return (
    <SegmentRow label="Auto-approve" desc={APPROVE_DESCS[value]} options={APPROVE_OPTIONS} value={value} onChange={onChange} />
  );
}

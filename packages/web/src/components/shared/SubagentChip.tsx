import React from 'react';
import type { SubagentLane } from '../../lib/subagent-lanes.js';
import { tokenColor } from '../../lib/tokens.js';
import { sp, rad } from '../../lib/density.js';

/**
 * Names the subagent a row belongs to ("2 Explore"), in that subagent's colour (`subagentLanes`), so
 * two subagents interleaved in their parent's session read apart without hovering. Given `onClick`
 * it is a button (Logs filters to that subagent); without, a plain label (the Dashboard's rows
 * already open Logs on click).
 */
export function SubagentChip({ lane, active, onClick }: {
  lane: SubagentLane;
  active?: boolean;
  onClick?: () => void;
}) {
  const style: React.CSSProperties = {
    fontFamily: 'var(--font-mono)', fontSize: 9, lineHeight: 1.4, flexShrink: 0, whiteSpace: 'nowrap',
    maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis',
    padding: sp('0 5px'), borderRadius: rad(3),
    color: tokenColor(lane.token),
    background: tokenColor(lane.token, active ? '30%' : '14%'),
    border: `var(--stroke) solid ${tokenColor(lane.token, active ? '80%' : '35%')}`,
  };
  if (!onClick) return <span data-subagent-chip style={style} title={lane.label}>{lane.chip}</span>;
  return (
    <button
      type="button"
      data-subagent-chip
      aria-pressed={active}
      title={active ? `${lane.label}: showing only its rows (click to show all)` : `${lane.label}: show only its rows`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ ...style, cursor: 'pointer' }}
    >
      {lane.chip}
    </button>
  );
}

import React from 'react';
import { CopyLinkButton } from '../primitives/index.js';
import { formatTime, formatDuration } from '../../lib/format.js';
import type { Turn } from '../../lib/types.js';

/** First non-empty line, length-capped — a turn's heading is its prompt's opening. */
function firstLine(text: string, max = 96): string {
  const line = (text ?? '').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface TurnHeaderProps {
  turn: Turn;
  collapsed: boolean;
  /** True when this is the turn the URL currently addresses. */
  addressed: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

/**
 * One row per turn in the archived transcript — the visible counterpart to the
 * `/s/<sid>/t/<pid>` address. Deliberately a single row rather than a redesign:
 * it groups the existing flat event list without changing its density.
 */
export const TurnHeader = React.memo(function TurnHeader({
  turn, collapsed, addressed, onToggle, onSelect,
}: TurnHeaderProps) {
  const duration = turn.endedAt === null ? null : formatDuration(turn.endedAt - turn.startedAt);

  return (
    <div
      data-turn-header
      data-prompt-event-id={turn.promptEventId}
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        margin: '6px 8px 2px', padding: '3px 8px',
        borderRadius: 4, cursor: 'pointer',
        background: addressed ? 'var(--bg-selected)' : 'var(--bg-raised)',
        borderLeft: `2px solid ${addressed ? 'var(--accent)' : 'var(--border-strong)'}`,
      }}
    >
      <span
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
        title={collapsed ? 'Expand this turn' : 'Collapse this turn'}
        style={{ width: 12, flexShrink: 0, fontSize: 8, color: 'var(--text-faint)', textAlign: 'center' }}
      >
        {collapsed ? '▸' : '▾'}
      </span>

      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600,
        color: 'var(--text-faint)', flexShrink: 0,
      }}>
        #{turn.index + 1}
      </span>

      <span style={{
        fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 500,
        color: 'var(--text)', flex: 1, minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {firstLine(turn.promptText) || '(empty prompt)'}
      </span>

      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)',
        flexShrink: 0, display: 'flex', gap: 6, alignItems: 'center',
      }}>
        <span>{formatTime(turn.startedAt)}</span>
        {duration && <span>· {duration}</span>}
        {turn.toolCallCount > 0 && (
          <span>· {turn.toolCallCount} {turn.toolCallCount === 1 ? 'call' : 'calls'}</span>
        )}
        {turn.responseEventId === null && <span style={{ color: 'var(--warn)' }}>· no response</span>}
      </span>

      <CopyLinkButton
        route={{ kind: 'turn', sessionId: turn.sessionId, promptEventId: turn.promptEventId }}
        title="Copy link to this turn"
      />
    </div>
  );
});

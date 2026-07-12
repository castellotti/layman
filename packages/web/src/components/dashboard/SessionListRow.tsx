import React, { useMemo } from 'react';
import { StatusDot, Meter, StateChip } from '../primitives/index.js';
import type { StatusDotState, StateChipVariant } from '../primitives/index.js';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';
import type { SessionMetrics } from '../../lib/types.js';

function getTimeSince(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 5000) return 'now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  return `${Math.floor(delta / 3_600_000)}h`;
}

function deriveSessionState(events: TimelineEvent[], sessionActive: boolean): {
  dotState: StatusDotState;
  chipVariant: StateChipVariant;
} {
  if (!sessionActive) return { dotState: 'ended', chipVariant: 'ended' };

  const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
  const last = meaningful[meaningful.length - 1];

  if (!last) return { dotState: 'idle', chipVariant: 'idle' };

  if (last.type === 'stop_failure' || last.type === 'tool_call_failed') {
    return { dotState: 'error', chipVariant: 'error' };
  }
  if (last.type === 'permission_request' && !last.data.decision) {
    return { dotState: 'permission', chipVariant: 'permission' };
  }
  if (last.type === 'tool_call_pending' && !last.data.decision) {
    return { dotState: 'running', chipVariant: 'running' };
  }
  if (last.type === 'agent_stop' || last.type === 'session_end') {
    return { dotState: 'idle', chipVariant: 'idle' };
  }
  return { dotState: 'running', chipVariant: 'running' };
}

export function getSessionDisplayName(session: SessionInfo): string {
  if (session.sessionName) return session.sessionName;
  if (session.cwd) {
    return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  }
  return session.sessionId.slice(0, 8);
}

interface SessionListRowProps {
  session: SessionInfo;
  events: TimelineEvent[];
  metrics: SessionMetrics | undefined;
  isOpen: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  index: number;
  onToggle: (sessionId: string) => void;
  onOpenInLogs: (sessionId: string) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragEnd: () => void;
}

export function SessionListRow({
  session, events, metrics, isOpen, isDragging, isDragOver, index,
  onToggle, onOpenInLogs, onDragStart, onDragOver, onDragEnd,
}: SessionListRowProps) {
  const isActive = session.active !== false;

  const { dotState, chipVariant } = useMemo(
    () => deriveSessionState(events, isActive),
    [events, isActive]
  );

  const lastMeaningful = useMemo(() => {
    const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
    return meaningful[meaningful.length - 1];
  }, [events]);

  const ctxPct = metrics?.contextUsedPct ?? 0;
  const model = metrics?.modelDisplayName;
  const hasMetrics = !!model || ctxPct > 0;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(index);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver(index);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onToggle(session.sessionId)}
      onDoubleClick={(e) => { e.stopPropagation(); onOpenInLogs(session.sessionId); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 12px',
        cursor: 'pointer',
        background: isOpen ? 'var(--bg-selected)' : 'transparent',
        borderBottom: '1px solid var(--border-subtle)',
        borderLeft: isDragOver ? '2px solid var(--info)' : '2px solid transparent',
        opacity: isDragging ? 0.45 : 1,
        transition: 'background 0.15s',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        if (!isOpen) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.03)';
      }}
      onMouseLeave={(e) => {
        if (!isOpen) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      {/* Drag handle */}
      <span
        style={{ color: 'var(--border-strong)', fontSize: 14, flexShrink: 0, cursor: 'grab', lineHeight: 1 }}
        title="Drag to reorder"
      >
        ⠿
      </span>

      {/* Status dot */}
      <StatusDot state={dotState} />

      {/* Name + cwd */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {getSessionDisplayName(session)}
        </div>
        {session.cwd && (
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 1,
          }}>
            {session.cwd}
          </div>
        )}
      </div>

      {/* State chip + model/ctx% (falls back to relative time when no metrics are available yet) */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
        <StateChip variant={chipVariant} />
        {hasMetrics ? (
          <>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: ctxPct >= 75 ? 'var(--error)' : ctxPct >= 60 ? 'var(--warn)' : 'var(--text-faint)',
            }}>
              {model ? `${model} · ` : ''}ctx {Math.round(ctxPct)}%
            </span>
            <Meter value={ctxPct} showTick height={3} width={40} />
          </>
        ) : (
          lastMeaningful && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>
              {getTimeSince(lastMeaningful.timestamp)}
            </span>
          )
        )}
      </div>

      {/* IN VIEW pill */}
      <span style={{
        flexShrink: 0,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.06em',
        padding: '3px 7px',
        borderRadius: 4,
        background: isOpen ? 'var(--bg-card)' : 'transparent',
        color: isOpen ? 'var(--text-body)' : 'var(--text-faint)',
        border: isOpen ? '1px solid var(--border-strong)' : '1px solid var(--border)',
      }}>
        {isOpen ? 'IN VIEW' : '+ VIEW'}
      </span>
    </div>
  );
}

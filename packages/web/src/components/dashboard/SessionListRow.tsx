import React, { useMemo } from 'react';
import { StatusDot, Meter } from '../primitives/index.js';
import { useNow } from '../../hooks/useNow.js';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';
import type { SessionMetrics } from '../../lib/types.js';
import { deriveSessionState, getSessionDisplayName, contextPctColor } from '../../lib/session-state.js';
import { cwdBasename } from '../../lib/format.js';

function getTimeSince(timestamp: number, now: number): string {
  const delta = now - timestamp;
  if (delta < 5000) return 'now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  return `${Math.floor(delta / 3_600_000)}h`;
}

// Isolates the 5s ticking re-render to just this label instead of the whole row.
function TimeSinceLabel({ timestamp }: { timestamp: number }) {
  const now = useNow(5000);
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)' }}>
      {getTimeSince(timestamp, now)}
    </span>
  );
}

interface SessionListRowProps {
  session: SessionInfo;
  events: TimelineEvent[];
  metrics: SessionMetrics | undefined;
  isOpen: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  onToggle: (sessionId: string) => void;
  onOpenInLogs: (sessionId: string) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
}

export const SessionListRow = React.memo(function SessionListRow({
  session, events, metrics, isOpen, isDragging, isDragOver,
  onToggle, onOpenInLogs, onDragStart, onDragOver, onDragEnd,
}: SessionListRowProps) {
  const isActive = session.active !== false;

  const { dotState, lastEvent: lastMeaningful } = useMemo(
    () => deriveSessionState(events, isActive),
    [events, isActive]
  );

  const ctxPct = metrics?.contextUsedPct;
  const model = metrics?.modelDisplayName;
  const hasMetrics = model !== undefined || ctxPct !== undefined;
  const cwdName = session.cwd ? cwdBasename(session.cwd) : undefined;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDragEnd={onDragEnd}
      onClick={() => onToggle(session.sessionId)}
      onDoubleClick={(e) => { e.stopPropagation(); onOpenInLogs(session.sessionId); }}
      title={session.cwd}
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
        {cwdName && (
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginTop: 1,
          }}>
            {cwdName}
          </div>
        )}
      </div>

      {/* ctx% on top, model beside the meter below (falls back to relative time when no metrics are available yet) */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
        {hasMetrics ? (
          <>
            {ctxPct !== undefined && (
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: contextPctColor(ctxPct, 'var(--text-body)'),
              }}>
                ctx {Math.round(ctxPct)}%
              </span>
            )}
            {(model || ctxPct !== undefined) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {model && (
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                    {model}
                  </span>
                )}
                {ctxPct !== undefined && <Meter value={ctxPct} showTick height={5} width={64} />}
              </div>
            )}
          </>
        ) : (
          lastMeaningful && <TimeSinceLabel timestamp={lastMeaningful.timestamp} />
        )}
      </div>
    </div>
  );
});

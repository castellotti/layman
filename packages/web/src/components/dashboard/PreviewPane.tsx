import React, { useMemo, useRef, useEffect } from 'react';
import { StatusDot, Meter, StateChip } from '../primitives/index.js';
import type { StatusDotState, StateChipVariant } from '../primitives/index.js';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';
import type { SessionMetrics } from '../../lib/types.js';
import { getSessionDisplayName } from './SessionListRow.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function getTimeSince(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 5000) return 'now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const EVENT_KIND_COLOR: Record<string, string> = {
  tool_call_pending:   'var(--warn)',
  tool_call_approved:  'var(--ok)',
  tool_call_denied:    'var(--error)',
  tool_call_completed: 'var(--ok)',
  tool_call_failed:    'var(--error)',
  permission_request:  'var(--warn)',
  user_prompt:         'var(--info)',
  agent_response:      'var(--ok)',
  subagent_start:      'var(--agent)',
  subagent_stop:       'var(--agent)',
  session_start:       'var(--ok)',
  session_end:         'var(--text-faint)',
  stop_failure:        'var(--error)',
};

function kindLabel(type: string): string {
  const labels: Record<string, string> = {
    tool_call_pending:   'pending',
    tool_call_approved:  'approved',
    tool_call_denied:    'denied',
    tool_call_completed: 'completed',
    tool_call_failed:    'failed',
    permission_request:  'permission',
    user_prompt:         'prompt',
    agent_response:      'response',
    subagent_start:      'agent↓',
    subagent_stop:       'agent↑',
    session_start:       'start',
    session_end:         'end',
    agent_stop:          'stop',
    stop_failure:        'stop-fail',
    pre_compact:         'compact',
    post_compact:        'compacted',
  };
  return labels[type] ?? type.replace(/_/g, ' ');
}

function eventDetail(event: TimelineEvent): string {
  if (event.data.toolName) {
    const input = event.data.toolInput as Record<string, unknown> | undefined;
    if (input?.command) return `${event.data.toolName} — ${String(input.command).slice(0, 60)}`;
    if (input?.file_path) return `${event.data.toolName} — ${String(input.file_path)}`;
    return event.data.toolName;
  }
  if (event.data.prompt) return String(event.data.prompt).slice(0, 80);
  return '';
}

function deriveSessionState(events: TimelineEvent[], sessionActive: boolean): {
  dotState: StatusDotState;
  chipVariant: StateChipVariant;
} {
  if (!sessionActive) return { dotState: 'ended', chipVariant: 'ended' };
  const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
  const last = meaningful[meaningful.length - 1];
  if (!last) return { dotState: 'idle', chipVariant: 'idle' };
  if (last.type === 'stop_failure' || last.type === 'tool_call_failed') return { dotState: 'error', chipVariant: 'error' };
  if (last.type === 'permission_request' && !last.data.decision) return { dotState: 'permission', chipVariant: 'permission' };
  if (last.type === 'tool_call_pending' && !last.data.decision) return { dotState: 'running', chipVariant: 'running' };
  if (last.type === 'agent_stop' || last.type === 'session_end') return { dotState: 'idle', chipVariant: 'idle' };
  return { dotState: 'running', chipVariant: 'running' };
}

// ─── ActivityStrip ────────────────────────────────────────────────────────────

function ActivityStrip({
  events,
  onOpenInLogs,
  sessionId,
  onSendAnalyze,
}: {
  events: TimelineEvent[];
  onOpenInLogs: (sessionId: string) => void;
  sessionId: string;
  onSendAnalyze?: (eventId: string) => void;
}) {
  const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
  const last = meaningful[meaningful.length - 1];
  if (!last) return null;

  // Error callout
  if (last.type === 'stop_failure' || last.type === 'tool_call_failed') {
    return (
      <div style={{
        margin: '0 10px 6px',
        padding: '8px 10px',
        borderRadius: 6,
        background: 'rgba(240,86,74,0.08)',
        border: '1px solid rgba(240,86,74,0.25)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 13 }}>⚠</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--error)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {last.data.error as string ?? 'Error occurred'}
        </span>
        <button
          onClick={() => onOpenInLogs(sessionId)}
          style={{ fontSize: 10, color: 'var(--error)', background: 'rgba(240,86,74,0.12)', border: '1px solid rgba(240,86,74,0.25)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'var(--font-ui)', flexShrink: 0 }}
        >
          Open logs
        </button>
      </div>
    );
  }

  // Permission callout
  if (last.type === 'permission_request' && !last.data.decision) {
    const input = last.data.toolInput as Record<string, unknown> | undefined;
    const preview = input?.command ? String(input.command).slice(0, 60) : (last.data.toolName ?? '');
    return (
      <div style={{
        margin: '0 10px 6px',
        padding: '8px 10px',
        borderRadius: 6,
        background: 'rgba(229,168,59,0.08)',
        border: '1px solid rgba(229,168,59,0.3)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontSize: 13 }}>🔒</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--warn)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {preview}
        </span>
        <button
          onClick={() => onOpenInLogs(sessionId)}
          style={{ fontSize: 10, color: '#0B0E14', background: 'var(--warn)', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontWeight: 600, flexShrink: 0 }}
        >
          Review
        </button>
      </div>
    );
  }

  // Running NOW strip
  if (last.type === 'tool_call_pending' && !last.data.decision) {
    const elapsed = Date.now() - last.timestamp;
    const detail = eventDetail(last);
    return (
      <div style={{
        margin: '0 10px 6px',
        padding: '6px 10px',
        borderRadius: 6,
        background: 'rgba(76,195,138,0.06)',
        border: '1px solid rgba(76,195,138,0.15)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 9.5, fontWeight: 600, color: 'var(--ok)', letterSpacing: '0.05em' }}>NOW</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-body)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {detail}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
          {formatElapsed(elapsed)}
        </span>
        {onSendAnalyze && (
          <button
            onClick={() => onSendAnalyze(last.id)}
            style={{ fontSize: 10, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border-strong)', borderRadius: 4, padding: '1px 7px', cursor: 'pointer', fontFamily: 'var(--font-ui)', flexShrink: 0 }}
          >
            ⚡ Explain
          </button>
        )}
      </div>
    );
  }

  return null;
}

// ─── RecentTail ───────────────────────────────────────────────────────────────

function RecentTail({ events, onOpenInLogs, sessionId }: {
  events: TimelineEvent[];
  onOpenInLogs: (sessionId: string, eventId: string) => void;
  sessionId: string;
}) {
  const tail = useMemo(() => {
    const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
    return meaningful.slice(-5);
  }, [events]);

  if (tail.length === 0) {
    return (
      <div style={{ padding: '8px 12px', color: 'var(--text-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
        No events yet
      </div>
    );
  }

  return (
    <div style={{ padding: '0 4px' }}>
      {tail.map((event, i) => {
        const color = EVENT_KIND_COLOR[event.type] ?? 'var(--text-muted)';
        const detail = eventDetail(event);
        const globalIdx = events.indexOf(event);
        return (
          <div
            key={event.id}
            onClick={() => onOpenInLogs(sessionId, event.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 8px',
              borderRadius: 4,
              cursor: 'pointer',
              transition: 'background 0.1s',
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-selected)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
          >
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', width: 24, textAlign: 'right', flexShrink: 0 }}>
              #{globalIdx + 1}
            </span>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 500, color, flexShrink: 0, minWidth: 64 }}>
              {kindLabel(event.type)}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-body)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>
              {formatTime(event.timestamp)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── PreviewPane ─────────────────────────────────────────────────────────────

interface PreviewPaneProps {
  session: SessionInfo;
  events: TimelineEvent[];
  metrics: SessionMetrics | undefined;
  onClose: (sessionId: string) => void;
  onOpenInLogs: (sessionId: string) => void;
  onOpenEventInLogs: (sessionId: string, eventId: string) => void;
  onSendAnalyze?: (eventId: string) => void;
  minHeight?: number;
}

export function PreviewPane({
  session, events, metrics, onClose, onOpenInLogs, onOpenEventInLogs, onSendAnalyze, minHeight = 240,
}: PreviewPaneProps) {
  const isActive = session.active !== false;
  const { dotState, chipVariant } = useMemo(
    () => deriveSessionState(events, isActive),
    [events, isActive]
  );
  const ctxPct = metrics?.contextUsedPct ?? 0;
  const model = metrics?.modelDisplayName;
  const cwd = session.cwd;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 0',
        minHeight,
        overflow: 'hidden',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      {/* Header row — double-click goes to Logs */}
      <div
        onDoubleClick={() => onOpenInLogs(session.sessionId)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: 'var(--bg-raised)',
          borderBottom: '1px solid var(--border-subtle)',
          cursor: 'default',
          flexShrink: 0,
        }}
        title="Double-click to open in Logs"
      >
        <StatusDot state={dotState} />
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
          {getSessionDisplayName(session)}
        </span>
        {(cwd || model) && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {cwd}{model ? ` · ${model}` : ''}
          </span>
        )}
        {!cwd && !model && <span style={{ flex: 1 }} />}
        {ctxPct > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <Meter value={ctxPct} showTick height={3} width={36} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: ctxPct >= 75 ? 'var(--error)' : ctxPct >= 60 ? 'var(--warn)' : 'var(--text-faint)' }}>
              {Math.round(ctxPct)}%
            </span>
          </div>
        )}
        <StateChip variant={chipVariant} />
        <button
          onClick={() => onClose(session.sessionId)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}
          title="Close pane"
        >
          ✕
        </button>
      </div>

      {/* Activity strip */}
      <div style={{ paddingTop: 6, flexShrink: 0 }}>
        <ActivityStrip
          events={events}
          onOpenInLogs={onOpenInLogs}
          sessionId={session.sessionId}
          onSendAnalyze={onSendAnalyze}
        />
      </div>

      {/* Recent tail */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 4 }}>
        <RecentTail
          events={events}
          onOpenInLogs={onOpenEventInLogs}
          sessionId={session.sessionId}
        />
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useRef } from 'react';
import { StatusDot, Meter, StateChip } from '../primitives/index.js';
import { useNow } from '../../hooks/useNow.js';
import type { TimelineEvent, DriftState } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';
import type { SessionMetrics } from '../../lib/types.js';
import { deriveSessionState, getSessionDisplayName, contextPctColor } from '../../lib/session-state.js';
import { formatTime, formatDuration as formatElapsed, cwdBasename } from '../../lib/format.js';
import { EVENT_KIND_COLOR, kindLabel, eventDetail, withThinkingRows, baseEventId } from '../../lib/event-styles.js';
import { HostChip } from '../shared/HostChip.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

// Isolates the 1s ticking re-render to just this label instead of the whole pane.
function ElapsedLabel({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)', flexShrink: 0 }}>
      {formatElapsed(now - since)}
    </span>
  );
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
  const last = useMemo(() => {
    const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
    return meaningful[meaningful.length - 1];
  }, [events]);
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
          style={{ fontSize: 10, color: 'var(--text-on-fill)', background: 'var(--warn)', border: 'none', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontWeight: 600, flexShrink: 0 }}
        >
          Review
        </button>
      </div>
    );
  }

  // Running NOW strip
  if (last.type === 'tool_call_pending' && !last.data.decision) {
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
        <ElapsedLabel since={last.timestamp} />
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

// Upper bound purely to protect render performance on very long sessions —
// the visible count is otherwise governed by the scroll container's height.
const MAX_TAIL_EVENTS = 500;

function RecentTail({ events, onOpenInLogs, sessionId, scrollRef }: {
  events: TimelineEvent[];
  onOpenInLogs: (sessionId: string, eventId: string) => void;
  sessionId: string;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tail = useMemo(() => {
    const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
    // Reasoning is lifted into its own row here too, so the dashboard tail and
    // the Logs list show the same sequence rather than the dashboard silently
    // folding thinking back into the response it preceded.
    return withThinkingRows(meaningful).slice(-MAX_TAIL_EVENTS);
  }, [events]);

  // Built once per `events` change so each tail row can look up its position in O(1)
  // instead of `events.indexOf(event)` (O(n) per row, O(n·tail.length) overall).
  const eventIndexById = useMemo(() => {
    const map = new Map<string, number>();
    events.forEach((e, i) => map.set(e.id, i));
    return map;
  }, [events]);

  // Stick to the bottom as new events arrive, unless the user has scrolled up to read history.
  const followRef = useRef(true);
  const prevCountRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, [scrollRef]);
  useEffect(() => {
    const grew = tail.length > prevCountRef.current;
    prevCountRef.current = tail.length;
    const el = scrollRef.current;
    if (grew && followRef.current && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [tail.length, scrollRef]);

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
        const realId = baseEventId(event.id);
        const globalIdx = eventIndexById.get(realId) ?? -1;
        return (
          <div
            key={event.id}
            onClick={() => onOpenInLogs(sessionId, realId)}
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
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)', width: 26, textAlign: 'right', flexShrink: 0 }}>
              #{globalIdx + 1}
            </span>
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 500, color, flexShrink: 0, minWidth: 64 }}>
              {kindLabel(event.type)}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-body)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)', flexShrink: 0 }}>
              {formatTime(event.timestamp)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── DriftIndicator ────────────────────────────────────────────────────────────
// Ambient session-goal / rules drift visibility (restores what DriftMonitorPanel
// used to show); clicking a meter jumps to the most recent drift event of that
// type in Logs, same as the legacy panel's bar-click behavior.

function DriftMeter({ label, pct, onClick }: { label: string; pct: number; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      title={`${label} drift: ${Math.round(pct)}%`}
      style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 1, minWidth: 0 }}
    >
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', flexShrink: 0 }}>
        {label}
      </span>
      <Meter value={pct} height={3} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontVariantNumeric: 'tabular-nums', color: pct >= 75 ? 'var(--error)' : pct >= 60 ? 'var(--warn)' : 'var(--text-faint)', flexShrink: 0 }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

function DriftIndicator({
  driftState,
  events,
  sessionId,
  onOpenInLogs,
  onOpenEventInLogs,
}: {
  driftState: DriftState;
  events: TimelineEvent[];
  sessionId: string;
  onOpenInLogs: (sessionId: string) => void;
  onOpenEventInLogs: (sessionId: string, eventId: string) => void;
}) {
  const goToDrift = (driftType: 'session_goal' | 'rules') => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if ((e.type === 'drift_check' || e.type === 'drift_alert') && e.data.driftType === driftType) {
        onOpenEventInLogs(sessionId, e.id);
        return;
      }
    }
    onOpenInLogs(sessionId);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 10px 0' }}>
      <DriftMeter label="Session" pct={driftState.sessionGoalDriftPct} onClick={() => goToDrift('session_goal')} />
      <DriftMeter label="Rules" pct={driftState.rulesDriftPct} onClick={() => goToDrift('rules')} />
    </div>
  );
}

// ─── PreviewPane ─────────────────────────────────────────────────────────────

interface PreviewPaneProps {
  session: SessionInfo;
  events: TimelineEvent[];
  metrics: SessionMetrics | undefined;
  driftState?: DriftState;
  driftEnabled?: boolean;
  onClose: (sessionId: string) => void;
  onOpenInLogs: (sessionId: string) => void;
  onOpenEventInLogs: (sessionId: string, eventId: string) => void;
  onSendAnalyze?: (eventId: string) => void;
  minHeight?: number;
}

export const PreviewPane = React.memo(function PreviewPane({
  session, events, metrics, driftState, driftEnabled, onClose, onOpenInLogs, onOpenEventInLogs, onSendAnalyze, minHeight = 240,
}: PreviewPaneProps) {
  const isActive = session.active !== false;
  const { dotState, chipVariant } = useMemo(
    () => deriveSessionState(events, isActive),
    [events, isActive]
  );
  const ctxPct = metrics?.contextUsedPct;
  const model = metrics?.modelDisplayName;
  const cwd = session.cwd;
  const tailScrollRef = useRef<HTMLDivElement>(null);
  // Remote sessions have no local approvals, and analysing a remote event would
  // run on central's model against central's copy — out of scope for v1. Hide the
  // Investigate/analyze affordance for them (§8.2).
  const analyzeHandler = session.remote ? undefined : onSendAnalyze;

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
        <HostChip hostId={session.hostId} hostName={session.hostName} />
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {getSessionDisplayName(session)}
        </span>
        {cwd && (
          <span
            title={cwd}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', flexShrink: 0 }}
          >
            {cwdBasename(cwd)}
          </span>
        )}
        {model && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
            {model}
          </span>
        )}
        {ctxPct !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <Meter value={ctxPct} showTick height={3} width={48} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontVariantNumeric: 'tabular-nums', color: contextPctColor(ctxPct, 'var(--text-faint)') }}>
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

      {/* Drift indicator */}
      {driftEnabled && driftState && (
        <DriftIndicator
          driftState={driftState}
          events={events}
          sessionId={session.sessionId}
          onOpenInLogs={onOpenInLogs}
          onOpenEventInLogs={onOpenEventInLogs}
        />
      )}

      {/* Activity strip */}
      <div style={{ paddingTop: 6, flexShrink: 0 }}>
        <ActivityStrip
          events={events}
          onOpenInLogs={onOpenInLogs}
          sessionId={session.sessionId}
          onSendAnalyze={analyzeHandler}
        />
      </div>

      {/* Recent tail */}
      <div ref={tailScrollRef} style={{ flex: 1, overflowY: 'auto', paddingBottom: 4 }}>
        <RecentTail
          events={events}
          onOpenInLogs={onOpenEventInLogs}
          sessionId={session.sessionId}
          scrollRef={tailScrollRef}
        />
      </div>
    </div>
  );
});

import React, { useMemo, useCallback, useRef } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EVENT_ICONS, NODE_BORDER_COLORS, AGENT_BADGES } from '../../lib/event-styles.js';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';

interface SessionCardProps {
  session: SessionInfo;
  events: TimelineEvent[];
  isFocused: boolean;
  onFocus: (sessionId: string) => void;
  onDrilldown: (sessionId: string, eventId: string) => void;
  index: number;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDragOver: boolean;
}

function getSessionDisplayName(session: SessionInfo): string {
  if (session.cwd) {
    return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  }
  return session.sessionId.slice(0, 8);
}

function getTimeSince(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 5000) return 'now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

/** Last N events as a compact activity chain */
function MiniActivityChain({ events, onDrilldown, sessionId }: {
  events: TimelineEvent[];
  onDrilldown: (sessionId: string, eventId: string) => void;
  sessionId: string;
}) {
  // Show last 6 meaningful events (skip session_metrics, etc.)
  const meaningful = useMemo(() =>
    events
      .filter(e => e.type !== 'session_metrics' && e.type !== 'notification')
      .slice(-6),
    [events]
  );

  if (meaningful.length === 0) {
    return (
      <div className="flex items-center gap-1 py-2">
        <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 10, color: 'var(--dash-text-muted)' }}>
          No activity yet
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0 py-1.5 overflow-hidden">
      {meaningful.map((event, i) => {
        const icon = EVENT_ICONS[event.type] ?? '\u2022';
        const borderColor = NODE_BORDER_COLORS[event.type] ?? '#30363d';
        const isPending = event.type === 'tool_call_pending';
        const isLast = i === meaningful.length - 1;

        return (
          <React.Fragment key={event.id}>
            <div
              className={`dash-chain-node ${isPending ? 'dash-chain-node--pending' : ''}`}
              style={{
                borderColor,
                ...(isLast ? { boxShadow: `0 0 8px ${borderColor}40` } : {}),
              }}
              title={`${event.type}${event.data.toolName ? `: ${event.data.toolName}` : ''}`}
              onClick={(e) => { e.stopPropagation(); onDrilldown(sessionId, event.id); }}
            >
              <span style={{ fontSize: 12 }}>{icon}</span>
            </div>
            {i < meaningful.length - 1 && <div className="dash-chain-connector" />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Risk items for this session (medium/high only) */
function RiskAlertFeed({ events, onDrilldown, sessionId }: {
  events: TimelineEvent[];
  onDrilldown: (sessionId: string, eventId: string) => void;
  sessionId: string;
}) {
  const riskyEvents = useMemo(() =>
    events
      .filter(e => e.riskLevel === 'medium' || e.riskLevel === 'high')
      .slice(-5)
      .reverse(),
    [events]
  );

  if (riskyEvents.length === 0) {
    return (
      <div style={{ fontFamily: 'var(--dash-font-data)', fontSize: 10, color: 'var(--dash-text-muted)', padding: '4px 0' }}>
        No risk alerts
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {riskyEvents.map(event => (
        <div
          key={event.id}
          className="dash-risk-item"
          onClick={(e) => { e.stopPropagation(); onDrilldown(sessionId, event.id); }}
        >
          <span className={`dash-risk-badge dash-risk-badge--${event.riskLevel}`}>
            {event.riskLevel}
          </span>
          <span style={{ color: 'var(--dash-text-secondary)' }} className="truncate">
            {event.data.toolName ?? event.type}
          </span>
          {event.data.toolName === 'Bash' && event.data.toolInput?.command != null && (
            <span style={{ color: 'var(--dash-text-muted)' }} className="truncate flex-1">
              {String(event.data.toolInput.command).slice(0, 40)}
            </span>
          )}
          <span style={{ color: 'var(--dash-text-muted)', fontSize: 9, flexShrink: 0 }}>
            {getTimeSince(event.timestamp)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Last agent response or tool output, truncated */
function LatestOutput({ events }: { events: TimelineEvent[] }) {
  const lastOutput = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'agent_response' && e.data.prompt) {
        return e.data.prompt;
      }
      if (e.type === 'tool_call_completed' && e.data.toolOutput) {
        const out = typeof e.data.toolOutput === 'string'
          ? e.data.toolOutput
          : JSON.stringify(e.data.toolOutput);
        return out.slice(0, 300);
      }
    }
    return null;
  }, [events]);

  if (!lastOutput) return null;

  return (
    <div className="dash-output-text mt-1.5">
      {lastOutput.slice(0, 200)}
    </div>
  );
}

export function SessionCard({
  session, events, isFocused, onFocus, onDrilldown, index,
  onDragStart, onDragOver, onDragEnd, isDragging, isDragOver,
}: SessionCardProps) {
  const sessionMetrics = useSessionStore(s => s.sessionMetrics);
  const metrics = sessionMetrics.get(session.sessionId);
  const badge = AGENT_BADGES[session.agentType];
  const isActive = session.active !== false;
  const dragRef = useRef<HTMLDivElement>(null);

  const handleClick = useCallback(() => {
    onFocus(session.sessionId);
  }, [onFocus, session.sessionId]);

  // Count risk events
  const riskCounts = useMemo(() => {
    let medium = 0, high = 0;
    for (const e of events) {
      if (e.riskLevel === 'medium') medium++;
      else if (e.riskLevel === 'high') high++;
    }
    return { medium, high };
  }, [events]);

  return (
    <div
      ref={dragRef}
      className={`dash-card dash-card-enter ${isFocused ? 'dash-card--focused' : ''} ${isDragging ? 'dash-card--dragging' : ''} ${isDragOver ? 'dash-card--drag-over' : ''}`}
      style={{ animationDelay: `${index * 80}ms` }}
      onClick={handleClick}
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
    >
      {/* Card header */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        {/* Drag handle */}
        <div className="dash-drag-handle flex flex-col gap-0.5" title="Drag to reorder">
          <div className="w-3 h-0.5 rounded-full bg-current" />
          <div className="w-3 h-0.5 rounded-full bg-current" />
          <div className="w-3 h-0.5 rounded-full bg-current" />
        </div>

        {/* Status indicator */}
        <div className="relative flex items-center">
          <div
            className="w-2 h-2 rounded-full"
            style={{
              background: isActive ? 'var(--dash-success)' : 'var(--dash-text-muted)',
              boxShadow: isActive ? '0 0 6px var(--dash-success)' : 'none',
            }}
          />
          {isActive && (
            <div
              className="absolute w-2 h-2 rounded-full animate-ping"
              style={{ background: 'var(--dash-success)', opacity: 0.4 }}
            />
          )}
        </div>

        {/* Session name */}
        <span
          style={{
            fontFamily: 'var(--dash-font-display)',
            fontSize: 13,
            fontWeight: 600,
            color: isFocused ? 'var(--dash-accent)' : 'var(--dash-text-primary)',
          }}
          className="truncate"
        >
          {getSessionDisplayName(session)}
        </span>

        {/* Agent badge */}
        {badge && (
          <span
            className={`text-[9px] font-mono font-semibold px-1.5 py-0.5 rounded border ${badge.color}`}
          >
            {badge.label}
          </span>
        )}

        <span className="flex-1" />

        {/* Risk summary */}
        {riskCounts.high > 0 && (
          <span className="dash-risk-badge dash-risk-badge--high">{riskCounts.high}</span>
        )}
        {riskCounts.medium > 0 && (
          <span className="dash-risk-badge dash-risk-badge--medium">{riskCounts.medium}</span>
        )}

        {/* Metrics mini */}
        {metrics?.costUsd !== undefined && (
          <span style={{
            fontFamily: 'var(--dash-font-data)',
            fontSize: 9,
            color: 'var(--dash-text-muted)',
          }}>
            ${metrics.costUsd < 1 ? metrics.costUsd.toFixed(3) : metrics.costUsd.toFixed(2)}
          </span>
        )}
      </div>

      {/* Activity chain */}
      <div className="px-3">
        <MiniActivityChain events={events} onDrilldown={onDrilldown} sessionId={session.sessionId} />
      </div>

      {/* Risk feed */}
      <div className="px-3 pb-1">
        <RiskAlertFeed events={events} onDrilldown={onDrilldown} sessionId={session.sessionId} />
      </div>

      {/* Latest output */}
      <div className="px-3 pb-3">
        <LatestOutput events={events} />
      </div>

      {/* Bottom accent line */}
      <div
        className="h-px w-full"
        style={{
          background: isFocused
            ? 'linear-gradient(90deg, transparent, var(--dash-accent), transparent)'
            : 'linear-gradient(90deg, transparent, var(--dash-card-border), transparent)',
        }}
      />
    </div>
  );
}

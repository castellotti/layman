import React, { useMemo, useCallback, useRef, useState } from 'react';
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
  /** How many total session cards are displayed */
  totalCards: number;
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

/** Tool activity heatmap — shows which tools are being called with risk coloring */
function ToolActivityHeatmap({ events }: { events: TimelineEvent[] }) {
  const heatData = useMemo(() => {
    // Collect tool call events
    const toolEvents = events.filter(e =>
      e.type.startsWith('tool_call_') || e.type === 'permission_request'
    );
    if (toolEvents.length === 0) return null;

    // Group by tool name, track counts and max risk
    const toolMap = new Map<string, { count: number; risk: 'low' | 'medium' | 'high' }>();
    for (const e of toolEvents) {
      const name = e.data.toolName ?? 'unknown';
      const existing = toolMap.get(name) ?? { count: 0, risk: 'low' as const };
      existing.count++;
      if (e.riskLevel === 'high' || (e.riskLevel === 'medium' && existing.risk !== 'high')) {
        existing.risk = e.riskLevel ?? existing.risk;
      }
      toolMap.set(name, existing);
    }

    // Sort by count descending, take top 8
    return [...toolMap.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8);
  }, [events]);

  if (!heatData || heatData.length === 0) return null;

  const maxCount = heatData[0][1].count;

  const riskColors = {
    low: 'var(--dash-accent)',
    medium: 'var(--dash-medium)',
    high: 'var(--dash-high)',
  };

  return (
    <div className="flex flex-wrap gap-0.5 py-1">
      {heatData.map(([name, { count, risk }]) => {
        const intensity = 0.15 + (count / maxCount) * 0.35;
        const shortName = name.length > 16
          ? name.replace(/^mcp__[^_]+__/, '').slice(0, 14)
          : name;
        return (
          <div
            key={name}
            className="rounded"
            style={{
              padding: '1px 5px',
              background: `color-mix(in srgb, ${riskColors[risk]} ${Math.round(intensity * 100)}%, transparent)`,
              border: `1px solid color-mix(in srgb, ${riskColors[risk]} 12%, transparent)`,
              lineHeight: '14px',
            }}
            title={`${name}: ${count} calls (${risk} risk)`}
          >
            <span style={{
              fontFamily: 'var(--dash-font-data)',
              fontSize: 8,
              color: riskColors[risk],
              opacity: 0.8,
            }}>
              {shortName}
            </span>
            <span style={{
              fontFamily: 'var(--dash-font-data)',
              fontSize: 7,
              color: 'var(--dash-text-muted)',
              marginLeft: 3,
            }}>
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Risk items for this session (medium/high only) — scrollable with expand */
function RiskAlertFeed({ events, onDrilldown, sessionId, expanded }: {
  events: TimelineEvent[];
  onDrilldown: (sessionId: string, eventId: string) => void;
  sessionId: string;
  /** Whether to show more items (for 1-2 session layouts) */
  expanded: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  const riskyEvents = useMemo(() =>
    events
      .filter(e => e.riskLevel === 'medium' || e.riskLevel === 'high')
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

  const defaultVisible = expanded ? 8 : 4;
  const visibleEvents = showAll ? riskyEvents : riskyEvents.slice(0, defaultVisible);
  const hasMore = riskyEvents.length > defaultVisible;

  return (
    <div className="flex flex-col gap-0.5">
      <div
        className={showAll ? 'overflow-y-auto' : ''}
        style={showAll ? { maxHeight: expanded ? 240 : 160 } : undefined}
      >
        {visibleEvents.map(event => (
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
      {hasMore && (
        <button
          className="self-start"
          style={{
            fontFamily: 'var(--dash-font-data)',
            fontSize: 9,
            color: 'var(--dash-accent)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 0',
            opacity: 0.7,
          }}
          onClick={(e) => { e.stopPropagation(); setShowAll(!showAll); }}
        >
          {showAll ? 'Show less' : `Show all ${riskyEvents.length} alerts`}
        </button>
      )}
    </div>
  );
}

/** Latest output — fills remaining card space, no hover jitter */
function LatestOutput({ events }: { events: TimelineEvent[] }) {
  const lastOutput = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === 'agent_response' && e.data.prompt) {
        return { text: e.data.prompt, label: 'Response' };
      }
      if (e.type === 'user_prompt' && e.data.prompt) {
        return { text: e.data.prompt, label: 'Prompt' };
      }
      if (e.type === 'tool_call_completed' && e.data.toolOutput) {
        const out = typeof e.data.toolOutput === 'string'
          ? e.data.toolOutput
          : JSON.stringify(e.data.toolOutput);
        return { text: out, label: `Output: ${e.data.toolName ?? 'tool'}` };
      }
    }
    return null;
  }, [events]);

  if (!lastOutput) return null;

  return (
    <div className="flex flex-col min-h-0 overflow-hidden" style={{ flex: 1 }}>
      <div style={{
        fontFamily: 'var(--dash-font-data)',
        fontSize: 8,
        color: 'var(--dash-text-secondary)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        marginBottom: 3,
        flexShrink: 0,
      }}>
        {lastOutput.label}
      </div>
      <div style={{
        fontFamily: 'var(--dash-font-data)',
        fontSize: 10,
        lineHeight: 1.5,
        color: '#9eaab8',
        overflow: 'hidden',
        flex: 1,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {lastOutput.text}
      </div>
    </div>
  );
}

/** Context window usage mini-bar */
function ContextMeter({ pct }: { pct: number }) {
  const color = pct >= 90 ? 'var(--dash-high)' : pct >= 70 ? 'var(--dash-medium)' : 'var(--dash-accent)';
  return (
    <div className="flex items-center gap-1" title={`Context window: ${Math.round(pct)}% used`}>
      <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color: 'var(--dash-text-muted)' }}>ctx</span>
      <div className="rounded-full overflow-hidden" style={{ width: 32, height: 4, background: 'var(--dash-bg)' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(pct, 100)}%`,
            background: color,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color }}>{Math.round(pct)}%</span>
    </div>
  );
}

export function SessionCard({
  session, events, isFocused, onFocus, onDrilldown, index,
  onDragStart, onDragOver, onDragEnd, isDragging, isDragOver, totalCards,
}: SessionCardProps) {
  const sessionMetrics = useSessionStore(s => s.sessionMetrics);
  const metrics = sessionMetrics.get(session.sessionId);
  const badge = AGENT_BADGES[session.agentType];
  const isActive = session.active !== false;
  const dragRef = useRef<HTMLDivElement>(null);

  // Expanded mode: 1-2 sessions get more vertical space
  const isExpanded = totalCards <= 2;

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
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
      className={`dash-card dash-card-enter flex flex-col ${isFocused ? 'dash-card--focused' : ''} ${isDragging ? 'dash-card--dragging' : ''} ${isDragOver ? 'dash-card--drag-over' : ''}`}
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
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 shrink-0">
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

        {/* Context usage meter */}
        {metrics?.contextUsedPct != null && (
          <ContextMeter pct={metrics.contextUsedPct} />
        )}

        {/* Cost */}
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
      <div className="px-3 shrink-0">
        <MiniActivityChain events={events} onDrilldown={onDrilldown} sessionId={session.sessionId} />
      </div>

      {/* Tool activity heatmap */}
      <div className="px-3 shrink-0">
        <ToolActivityHeatmap events={events} />
      </div>

      {/* Risk feed */}
      <div className="px-3 pb-1 shrink-0">
        <RiskAlertFeed
          events={events}
          onDrilldown={onDrilldown}
          sessionId={session.sessionId}
          expanded={isExpanded}
        />
      </div>

      {/* Latest output — flex-1 so it fills remaining card height */}
      <div className="px-3 pb-3 flex-1 min-h-0 flex flex-col overflow-hidden">
        <LatestOutput events={events} />
      </div>

      {/* Bottom accent line */}
      <div
        className="h-px w-full shrink-0"
        style={{
          background: isFocused
            ? 'linear-gradient(90deg, transparent, var(--dash-accent), transparent)'
            : 'linear-gradient(90deg, transparent, var(--dash-card-border), transparent)',
        }}
      />
    </div>
  );
}

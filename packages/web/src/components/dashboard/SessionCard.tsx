import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EVENT_ICONS, BORDER_COLORS, NODE_BORDER_COLORS, AGENT_BADGES } from '../../lib/event-styles.js';
import { RiskBadge } from '../shared/RiskBadge.js';
import type { TimelineEvent } from '../../lib/types.js';
import type { SessionInfo } from '../../lib/ws-protocol.js';

interface SessionCardProps {
  session: SessionInfo;
  events: TimelineEvent[];
  isFocused: boolean;
  onFocus: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
  onDrilldown: (sessionId: string, eventId: string) => void;
  onDrilldownToLogs: (sessionId: string, eventId: string) => void;
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
  if (session.sessionName) return session.sessionName;
  if (session.cwd) {
    return session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  }
  return session.sessionId.slice(0, 8);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(ms: number): string {
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

/** Last N events as a compact activity chain */
function MiniActivityChain({ events, onDrilldown, sessionId, maxItems }: {
  events: TimelineEvent[];
  onDrilldown: (sessionId: string, eventId: string) => void;
  sessionId: string;
  maxItems: number;
}) {
  const meaningful = useMemo(() =>
    events
      .filter(e => e.type !== 'session_metrics' && e.type !== 'notification')
      .slice(-maxItems),
    [events, maxItems]
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
    const toolEvents = events.filter(e =>
      e.type.startsWith('tool_call_') || e.type === 'permission_request'
    );
    if (toolEvents.length === 0) return null;

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

function getTooltipContent(event: TimelineEvent): string | null {
  const { data, type } = event;
  if (data.prompt && (type === 'user_prompt' || type === 'agent_response' || type === 'elicitation')) {
    return data.prompt as string;
  }
  if (data.toolInput) {
    const input = data.toolInput as Record<string, unknown>;
    if ('command' in input) return String(input.command);
    if ('file_path' in input) {
      const path = String(input.file_path);
      if ('content' in input) return `${path}\n\n${String(input.content).slice(0, 800)}`;
      if ('old_string' in input) return `${path}\n\n- ${String(input.old_string).slice(0, 300)}\n+ ${String(input.new_string ?? '').slice(0, 300)}`;
      return path;
    }
    if ('pattern' in input) return String(input.pattern);
    if ('query' in input) return String(input.query);
    if ('url' in input) return String(input.url);
    if ('prompt' in input) return String(input.prompt).slice(0, 600);
    return JSON.stringify(input, null, 2).slice(0, 600);
  }
  if (data.error) return data.error;
  if (typeof data.toolOutput === 'string' && data.toolOutput.length > 20) {
    return data.toolOutput.slice(0, 800);
  }
  return null;
}

/** Portal tooltip showing full event content on hover */
function EventTooltip({ content, x, y }: { content: string; x: number; y: number }) {
  const GAP = 14;
  const MAX_W = 480;
  const left = x + GAP + MAX_W > window.innerWidth ? x - GAP - MAX_W : x + GAP;
  const top = Math.max(8, Math.min(y - 40, window.innerHeight - 300));

  return createPortal(
    <div
      style={{
        position: 'fixed',
        left,
        top,
        width: MAX_W,
        maxHeight: 280,
        background: '#0d1117',
        border: '1px solid #30363d',
        borderRadius: 6,
        padding: '10px 12px',
        zIndex: 99999,
        overflowY: 'auto',
        pointerEvents: 'none',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      <pre
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          lineHeight: 1.55,
          color: '#c9d1d9',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: 0,
        }}
      >
        {content}
      </pre>
    </div>,
    document.body
  );
}

/** A single collapsed event row matching EventCard's header style */
function DashboardEventRow({
  event,
  globalIndex,
  onClick,
  onMouseEnter,
  onMouseLeave,
}: {
  event: TimelineEvent;
  globalIndex: number;
  onClick: () => void;
  onMouseEnter: (e: React.MouseEvent) => void;
  onMouseLeave: () => void;
}) {
  const isPending = event.type === 'tool_call_pending' || event.type === 'permission_request';
  const borderColor = BORDER_COLORS[event.type] ?? 'border-l-[#30363d]';
  const icon = EVENT_ICONS[event.type] ?? '·';
  const borderWidth = isPending ? 'border-l-2' : 'border-l';
  const bgClass = isPending
    ? 'bg-[#1c1a0f] hover:bg-[#1c1a0f]/90'
    : 'bg-[#0c1018] hover:bg-[#161b22]';

  // agent_stop special case (matches EventCard)
  if (event.type === 'agent_stop') {
    return (
      <div
        className="mx-2 mb-0.5 rounded border border-[#30363d]/40 bg-[#0c1018] hover:bg-[#161b22] cursor-pointer transition-colors"
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="text-[9px] text-[#484f58] font-mono tabular-nums shrink-0 w-5 text-right">{globalIndex + 1}</span>
          <span className="text-[#484f58] text-xs">—</span>
          <span className="text-[10px] text-[#484f58] font-mono">agent stop</span>
          <div className="flex-1" />
          <span className="text-[9px] text-[#58a6ff]/70 font-mono tabular-nums shrink-0">{formatTime(event.timestamp)}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${bgClass} ${borderColor} ${borderWidth} mx-2 mb-0.5 rounded overflow-hidden transition-colors cursor-pointer ${
        isPending ? 'ring-1 ring-[#d29922]/20' : ''
      }`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        {/* Sequence number */}
        <span className="text-[9px] text-[#484f58] font-mono tabular-nums shrink-0 w-5 text-right">
          {globalIndex + 1}
        </span>

        {/* Icon */}
        <span className="text-xs shrink-0">{icon}</span>

        {/* Type label */}
        <span className="text-[10px] text-[#8b949e] font-mono shrink-0">
          {event.type.replace(/_/g, ' ')}{(event.type === 'drift_check' || event.type === 'drift_alert') && event.data.driftType ? ` - ${event.data.driftType === 'rules' ? 'rules' : 'session'}` : ''}
        </span>

        {/* Tool name */}
        {event.data.toolName && (
          <>
            <span className="text-[10px] text-[#484f58]">·</span>
            <span className="text-[10px] font-semibold text-[#e6edf3] truncate min-w-0">
              {event.data.toolName}
            </span>
          </>
        )}

        {/* Prompt preview (only when no tool name) */}
        {event.data.prompt && !event.data.toolName && (
          <span className="text-[10px] text-[#8b949e] truncate min-w-0 italic">
            {(event.data.prompt as string).slice(0, 50)}
          </span>
        )}

        {/* Source / notification / agent type labels */}
        {event.data.source && (
          <span className="text-[10px] text-[#8b949e] shrink-0">{event.data.source as string}</span>
        )}
        {event.data.notificationType && (
          <span className="text-[10px] text-[#8b949e] shrink-0">{event.data.notificationType as string}</span>
        )}

        <div className="flex-1 min-w-0" />

        {/* Risk badge */}
        {event.riskLevel && event.riskLevel !== 'low' && (
          <RiskBadge level={event.riskLevel} compact />
        )}

        {/* Decision badge */}
        {event.data.decision && (
          <span className={`text-[9px] font-medium shrink-0 ${
            (event.data.decision as { decision: string }).decision === 'allow'
              ? 'text-[#3fb950]'
              : (event.data.decision as { decision: string }).decision === 'deny'
                ? 'text-[#f85149]'
                : 'text-[#8b949e]'
          }`}>
            {(event.data.decision as { decision: string }).decision.toUpperCase()}
          </span>
        )}

        {/* Pending badge */}
        {isPending && !event.data.decision && (
          <span className="text-[9px] font-semibold text-[#d29922] animate-pulse shrink-0">
            PENDING
          </span>
        )}

        {/* Duration */}
        {event.data.completedAt && (
          <span className="text-[9px] text-[#484f58] font-mono tabular-nums shrink-0">
            {formatDuration((event.data.completedAt as number) - event.timestamp)}
          </span>
        )}

        {/* Timestamp */}
        <span className="text-[9px] text-[#484f58] font-mono tabular-nums shrink-0">
          {formatTime(event.timestamp)}
        </span>
      </div>
    </div>
  );
}

/** Scrollable event feed replacing the old bottom sections */
function DashboardEventFeed({
  events,
  sessionId,
  onDrilldownToLogs,
  maxItems,
}: {
  events: TimelineEvent[];
  sessionId: string;
  onDrilldownToLogs: (sessionId: string, eventId: string) => void;
  maxItems: number;
}) {
  const [tooltip, setTooltip] = useState<{ content: string; x: number; y: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredEvents = useMemo(
    () => events.filter(e => e.type !== 'session_metrics').slice(-maxItems),
    [events, maxItems]
  );

  // Keep newest entry visible
  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredEvents.length]);

  const handleMouseEnter = useCallback((event: TimelineEvent, e: React.MouseEvent) => {
    const content = getTooltipContent(event);
    if (content) {
      setTooltip({ content, x: e.clientX, y: e.clientY });
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  if (filteredEvents.length === 0) return null;

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto py-1">
      {filteredEvents.map((event, i) => (
        <DashboardEventRow
          key={event.id}
          event={event}
          globalIndex={i}
          onClick={() => onDrilldownToLogs(sessionId, event.id)}
          onMouseEnter={(e) => handleMouseEnter(event, e)}
          onMouseLeave={handleMouseLeave}
        />
      ))}
      {tooltip && <EventTooltip content={tooltip.content} x={tooltip.x} y={tooltip.y} />}
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

/** Rate limit mini-bar (5h or 1w) */
function RateLimitMini({ label, pct, resetsAt }: { label: string; pct: number; resetsAt?: string }) {
  const color = pct >= 80 ? 'var(--dash-high)' : pct >= 50 ? 'var(--dash-medium)' : 'var(--dash-text-muted)';
  const tooltipParts = [`${label} rate limit: ${Math.round(pct)}% used`];
  if (resetsAt) tooltipParts.push(`Resets at ${new Date(resetsAt).toLocaleTimeString()}`);
  return (
    <div className="flex items-center gap-1" title={tooltipParts.join(' · ')}>
      <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color: 'var(--dash-text-muted)' }}>{label}</span>
      <div className="rounded-full overflow-hidden" style={{ width: 28, height: 4, background: 'var(--dash-bg)' }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(pct, 100)}%`, background: color, transition: 'width 0.3s ease' }}
        />
      </div>
      <span style={{ fontFamily: 'var(--dash-font-data)', fontSize: 8, color }}>{Math.round(pct)}%</span>
    </div>
  );
}

export function SessionCard({
  session, events, isFocused, onFocus, onDismiss, onDrilldown, onDrilldownToLogs, index,
  onDragStart, onDragOver, onDragEnd, isDragging, isDragOver, totalCards,
}: SessionCardProps) {
  const sessionMetrics = useSessionStore(s => s.sessionMetrics);
  const metrics = sessionMetrics.get(session.sessionId);
  const badge = AGENT_BADGES[session.agentType];
  const isActive = session.active !== false;
  const dragRef = useRef<HTMLDivElement>(null);
  const chainContainerRef = useRef<HTMLDivElement>(null);
  const [chainCapacity, setChainCapacity] = useState(6);

  // Measure the chain container width and compute how many nodes fit.
  // Each node is 28px, each connector is 12px → N nodes need (N-1)*40 + 28 px.
  // Solving: capacity = floor((usableWidth + 12) / 40).
  useEffect(() => {
    const el = chainContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const usable = entry.contentRect.width;
      setChainCapacity(Math.max(1, Math.floor((usable + 12) / 40)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onFocus(session.sessionId);
  }, [onFocus, session.sessionId]);

  // Count risk events for the header summary
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

        {/* Rate limit mini-bars */}
        {metrics?.rateLimit5hrPct != null && (
          <RateLimitMini label="5h" pct={metrics.rateLimit5hrPct} resetsAt={metrics.rateLimit5hrResetsAt} />
        )}
        {metrics?.rateLimit7dayPct != null && (
          <RateLimitMini label="1w" pct={metrics.rateLimit7dayPct} resetsAt={metrics.rateLimit7dayResetsAt} />
        )}

        {/* Cost */}
        {metrics?.costUsd !== undefined && (
          <span
            style={{ fontFamily: 'var(--dash-font-data)', fontSize: 9, color: 'var(--dash-text-muted)', cursor: 'help' }}
            title="Estimated API cost based on token usage at current Anthropic rates. Actual billing may differ slightly."
          >
            ${metrics.costUsd < 1 ? metrics.costUsd.toFixed(3) : metrics.costUsd.toFixed(2)}
          </span>
        )}

        {/* Dismiss button */}
        <button
          title="Close session (re-appears on new activity)"
          onClick={(e) => { e.stopPropagation(); onDismiss(session.sessionId); }}
          style={{
            fontFamily: 'var(--dash-font-data)',
            fontSize: 12,
            lineHeight: 1,
            color: 'var(--dash-text-muted)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '0 2px',
            opacity: 0.5,
            transition: 'opacity 0.15s',
            flexShrink: 0,
          }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '0.5')}
        >
          ×
        </button>
      </div>

      {/* Activity chain */}
      <div ref={chainContainerRef} className="px-3 shrink-0" style={{ maxWidth: totalCards === 1 ? '50%' : '100%' }}>
        <MiniActivityChain events={events} onDrilldown={onDrilldown} sessionId={session.sessionId} maxItems={chainCapacity} />
      </div>

      {/* Tool activity heatmap */}
      <div className="px-3 shrink-0" style={{ maxWidth: totalCards === 1 ? '50%' : '100%' }}>
        <ToolActivityHeatmap events={events} />
      </div>

      {/* Risk feed */}
      <div className="px-3 pb-1 shrink-0">
        <RiskAlertFeed
          events={events}
          onDrilldown={onDrilldown}
          sessionId={session.sessionId}
          expanded={totalCards <= 2}
        />
      </div>

      {/* Event feed — Logs-style collapsed rows, fills remaining card height */}
      <div className="px-1 pb-2 flex-1 min-h-0 flex flex-col overflow-hidden">
        <DashboardEventFeed
          events={events}
          sessionId={session.sessionId}
          onDrilldownToLogs={onDrilldownToLogs}
          maxItems={chainCapacity}
        />
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

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useEventStore } from '../../hooks/useEventStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EventCard } from '../events/EventCard.js';
import { NavigationBar } from '../controls/NavigationBar.js';
import { SessionMetricsBar } from '../controls/SessionMetricsBar.js';
import { PromptInput } from '../controls/PromptInput.js';
import { Minimap } from '../logs/Minimap.js';
import { JumpToLatest, StateChip } from '../primitives/index.js';
import { saveAndBookmarkSession } from '../../lib/bookmarks-api.js';
import { formatDuration, formatTime } from '../../lib/format.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import type { TimelineEvent } from '../../lib/types.js';

interface EventStreamProps {
  onSend: (msg: ClientMessage) => void;
  archived?: boolean;
  archivedDate?: string;
}

// ─── Exchange types ───────────────────────────────────────────────────────────

interface SubagentLane {
  kind: 'subagent';
  id: string;
  startEvent: TimelineEvent;
  children: TimelineEvent[];
  stopEvent?: TimelineEvent;
}

type ExchangeChild = TimelineEvent | SubagentLane;

interface Exchange {
  id: string;
  promptEvent: TimelineEvent;
  promptNumber: number;
  children: ExchangeChild[];
}

// Group consecutive events between subagent_start and subagent_stop into lanes
function groupSubagentLanes(children: TimelineEvent[]): ExchangeChild[] {
  const result: ExchangeChild[] = [];
  let i = 0;

  while (i < children.length) {
    const event = children[i];
    if (event.type === 'subagent_start') {
      const lane: SubagentLane = {
        kind: 'subagent',
        id: event.id,
        startEvent: event,
        children: [],
        stopEvent: undefined,
      };
      let j = i + 1;
      while (j < children.length && children[j].type !== 'subagent_start') {
        if (children[j].type === 'subagent_stop') {
          lane.stopEvent = children[j];
          j++;
          break;
        }
        lane.children.push(children[j]);
        j++;
      }
      result.push(lane);
      i = j;
    } else {
      result.push(event);
      i++;
    }
  }

  return result;
}

// Build exchange groups from a flat array of session events
function buildExchanges(events: TimelineEvent[]): { prolog: TimelineEvent[]; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const prolog: TimelineEvent[] = [];
  let current: { promptEvent: TimelineEvent; children: TimelineEvent[] } | null = null;
  let promptNumber = 0;

  for (const event of events) {
    if (event.type === 'user_prompt') {
      if (current) {
        exchanges.push({
          id: current.promptEvent.id,
          promptEvent: current.promptEvent,
          promptNumber,
          children: groupSubagentLanes(current.children),
        });
        promptNumber++;
      }
      current = { promptEvent: event, children: [] };
    } else if (current) {
      current.children.push(event);
    } else {
      prolog.push(event);
    }
  }

  if (current) {
    exchanges.push({
      id: current.promptEvent.id,
      promptEvent: current.promptEvent,
      promptNumber,
      children: groupSubagentLanes(current.children),
    });
  }

  return { prolog, exchanges };
}

// ─── CollapsedExchangeRow ─────────────────────────────────────────────────────

interface CollapsedExchangeRowProps {
  exchange: Exchange;
  onClick: () => void;
}

function CollapsedExchangeRow({ exchange, onClick }: CollapsedExchangeRowProps) {
  const { promptEvent, promptNumber, children } = exchange;
  const promptText = promptEvent.data.prompt ?? '';

  // Flatten children to count events and compute risk
  const allChildren = useMemo(() => {
    const flat: TimelineEvent[] = [];
    for (const child of children) {
      if ((child as SubagentLane).kind === 'subagent') {
        const lane = child as SubagentLane;
        flat.push(lane.startEvent, ...lane.children);
        if (lane.stopEvent) flat.push(lane.stopEvent);
      } else {
        flat.push(child as TimelineEvent);
      }
    }
    return flat;
  }, [children]);

  const eventCount = allChildren.length;
  const duration = allChildren.length > 0
    ? allChildren[allChildren.length - 1].timestamp - promptEvent.timestamp
    : 0;
  const medCount = allChildren.filter(e => e.riskLevel === 'medium').length;
  const highCount = allChildren.filter(e => e.riskLevel === 'high').length;
  const hasPending = allChildren.some(
    e => !e.data.decision && (e.type === 'tool_call_pending' || e.type === 'permission_request')
  );

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        margin: '1px 8px',
        borderRadius: 6,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
        transition: 'background 0.12s',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-selected)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-card)')}
    >
      {/* Expand indicator */}
      <span style={{ color: 'var(--text-faint)', fontSize: 10, flexShrink: 0 }}>▶</span>

      {/* Prompt label */}
      <span style={{ color: 'var(--info)', fontWeight: 500, flexShrink: 0, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
        prompt {promptNumber + 1}
      </span>

      {/* Prompt text truncated */}
      <span style={{
        color: 'var(--text-body)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: 1,
        minWidth: 0,
      }}>
        {promptText.slice(0, 120)}{promptText.length > 120 ? '…' : ''}
      </span>

      {/* Summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {hasPending && <StateChip variant="permission" label="pending" />}
        {(medCount > 0 || highCount > 0) && (
          <span style={{
            color: highCount > 0 ? 'var(--error)' : 'var(--warn)',
            fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 500,
          }}>
            {medCount + highCount} {highCount > 0 ? 'high' : 'med'}
          </span>
        )}
        {eventCount > 0 && (
          <span style={{ color: 'var(--text-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            {eventCount} events
          </span>
        )}
        {duration > 1000 && (
          <span style={{ color: 'var(--text-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            · {formatDuration(duration)}
          </span>
        )}
        <span style={{ color: 'var(--text-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          {formatTime(promptEvent.timestamp)}
        </span>
      </div>
    </div>
  );
}

// ─── SubagentLaneRow ──────────────────────────────────────────────────────────

interface SubagentLaneRowProps {
  lane: SubagentLane;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  eventIndexMap: Map<string, number>;
  selectedIndex: number;
  events: TimelineEvent[];
  onSelectEvent: (index: number, id: string) => void;
  onSend: (msg: ClientMessage) => void;
  collapseHistory: boolean;
  showAgentBadge: boolean;
}

function SubagentLaneRow({
  lane,
  isLast,
  isExpanded,
  onToggle,
  eventIndexMap,
  selectedIndex,
  events,
  onSelectEvent,
  onSend,
  collapseHistory,
  showAgentBadge,
}: SubagentLaneRowProps) {
  const toolCount = lane.stopEvent?.data.subagentTranscript?.length
    ?? lane.children.filter(e => e.type === 'tool_call_completed' || e.type === 'tool_call_pending').length;
  const agentName = lane.startEvent.data.agentType ?? lane.startEvent.data.toolName ?? 'subagent';
  const guide = isLast && !isExpanded ? '└─' : '├─';

  return (
    <div>
      {/* Lane header row */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* Tree guide */}
        <div style={{
          width: 28,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-start',
          paddingTop: 8,
          paddingLeft: 12,
          color: 'var(--border-strong)',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
        }}>
          {guide}
        </div>

        {/* Tinted agent lane */}
        <div
          onClick={onToggle}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '1px 8px 1px 0',
            padding: '5px 10px',
            borderRadius: 5,
            background: 'rgba(139,124,246,0.08)',
            border: '1px solid rgba(139,124,246,0.2)',
            borderLeft: '2px solid var(--agent)',
            cursor: 'pointer',
            transition: 'background 0.12s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,124,246,0.12)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(139,124,246,0.08)')}
        >
          <span style={{ color: 'var(--agent)', fontSize: 11, fontFamily: 'var(--font-ui)', fontWeight: 500 }}>
            agent ⑂
          </span>
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {agentName}
          </span>
          {toolCount > 0 && (
            <span style={{
              color: 'var(--agent)', fontSize: 10, fontFamily: 'var(--font-mono)',
              background: 'rgba(139,124,246,0.12)', padding: '1px 5px', borderRadius: 3,
            }}>
              {toolCount} tool{toolCount !== 1 ? 's' : ''}
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span style={{ color: 'var(--border-strong)', fontSize: 10 }}>{isExpanded ? '▼' : '▶'}</span>
          <span style={{ color: 'var(--text-faint)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            {formatTime(lane.startEvent.timestamp)}
          </span>
        </div>
      </div>

      {/* Expanded lane children */}
      {isExpanded && (
        <>
          {lane.children.map((child, ci) => {
            const isChildLast = ci === lane.children.length - 1 && !lane.stopEvent;
            const childGuide = isChildLast ? '└─' : '├─';
            const childIdx = eventIndexMap.get(child.id) ?? 0;
            return (
              <div key={child.id} style={{ display: 'flex', alignItems: 'stretch' }}>
                <div style={{
                  width: 48,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'flex-start',
                  paddingTop: 8,
                  paddingLeft: 20,
                  color: 'rgba(139,124,246,0.4)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}>
                  {childGuide}
                </div>
                <div style={{ flex: 1 }} data-event-card>
                  <EventCard
                    event={child}
                    index={childIdx}
                    isSelected={selectedIndex === childIdx}
                    onClick={() => onSelectEvent(childIdx, child.id)}
                    onSend={onSend}
                    collapseHistory={collapseHistory}
                    showAgentBadge={showAgentBadge}
                  />
                </div>
              </div>
            );
          })}
          {/* Stop event (shows transcript) */}
          {lane.stopEvent && (() => {
            const stopIdx = eventIndexMap.get(lane.stopEvent.id) ?? 0;
            return (
              <div style={{ display: 'flex', alignItems: 'stretch' }}>
                <div style={{
                  width: 48,
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'flex-start',
                  paddingTop: 8,
                  paddingLeft: 20,
                  color: 'rgba(139,124,246,0.4)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                }}>
                  └─
                </div>
                <div style={{ flex: 1 }} data-event-card>
                  <EventCard
                    event={lane.stopEvent}
                    index={stopIdx}
                    isSelected={selectedIndex === stopIdx}
                    onClick={() => onSelectEvent(stopIdx, lane.stopEvent!.id)}
                    onSend={onSend}
                    collapseHistory={collapseHistory}
                    showAgentBadge={showAgentBadge}
                  />
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

// ─── ExpandedExchange ─────────────────────────────────────────────────────────

interface ExpandedExchangeProps {
  exchange: Exchange;
  onCollapse: () => void;
  expandedSubagentIds: Set<string>;
  onToggleSubagent: (id: string) => void;
  eventIndexMap: Map<string, number>;
  selectedIndex: number;
  events: TimelineEvent[];
  onSelectEvent: (index: number, id: string) => void;
  onSend: (msg: ClientMessage) => void;
  collapseHistory: boolean;
  showAgentBadge: boolean;
}

function ExpandedExchange({
  exchange,
  onCollapse,
  expandedSubagentIds,
  onToggleSubagent,
  eventIndexMap,
  selectedIndex,
  events,
  onSelectEvent,
  onSend,
  collapseHistory,
  showAgentBadge,
}: ExpandedExchangeProps) {
  const promptIdx = eventIndexMap.get(exchange.promptEvent.id) ?? 0;

  return (
    <div style={{ marginBottom: 2 }}>
      {/* Prompt row with collapse button */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <button
          onClick={onCollapse}
          title="Collapse exchange"
          style={{
            width: 20,
            flexShrink: 0,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-faint)',
            fontSize: 9,
            display: 'flex',
            alignItems: 'flex-start',
            paddingTop: 10,
            paddingLeft: 8,
          }}
        >
          ▼
        </button>
        <div style={{ flex: 1 }} data-event-card>
          <EventCard
            event={exchange.promptEvent}
            index={promptIdx}
            isSelected={selectedIndex === promptIdx}
            onClick={() => onSelectEvent(promptIdx, exchange.promptEvent.id)}
            onSend={onSend}
            collapseHistory={collapseHistory}
            showAgentBadge={showAgentBadge}
          />
        </div>
      </div>

      {/* Children with tree guides */}
      {exchange.children.map((child, ci) => {
        const isLast = ci === exchange.children.length - 1;

        if ((child as SubagentLane).kind === 'subagent') {
          const lane = child as SubagentLane;
          return (
            <SubagentLaneRow
              key={lane.id}
              lane={lane}
              isLast={isLast}
              isExpanded={expandedSubagentIds.has(lane.id)}
              onToggle={() => onToggleSubagent(lane.id)}
              eventIndexMap={eventIndexMap}
              selectedIndex={selectedIndex}
              events={events}
              onSelectEvent={onSelectEvent}
              onSend={onSend}
              collapseHistory={collapseHistory}
              showAgentBadge={showAgentBadge}
            />
          );
        }

        const event = child as TimelineEvent;
        const guide = isLast ? '└─' : '├─';
        const eventIdx = eventIndexMap.get(event.id) ?? 0;

        return (
          <div key={event.id} style={{ display: 'flex', alignItems: 'stretch' }}>
            {/* Tree guide */}
            <div style={{
              width: 28,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'flex-start',
              paddingTop: 8,
              paddingLeft: 12,
              color: 'var(--border-strong)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              userSelect: 'none',
            }}>
              {guide}
            </div>
            <div style={{ flex: 1 }} data-event-card>
              <EventCard
                event={event}
                index={eventIdx}
                isSelected={selectedIndex === eventIdx}
                onClick={() => onSelectEvent(eventIdx, event.id)}
                onSend={onSend}
                collapseHistory={collapseHistory}
                showAgentBadge={showAgentBadge}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── EventStream ──────────────────────────────────────────────────────────────

export function EventStream({ onSend, archived = false, archivedDate }: EventStreamProps) {
  const [promptsOnly, setPromptsOnly] = useState(false);
  const [requestsOnly, setRequestsOnly] = useState(false);
  const [riskyOnly, setRiskyOnly] = useState(false);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [agentsOnly, setAgentsOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [followLatest, setFollowLatest] = useState(true);
  const [expandedExchangeIds, setExpandedExchangeIds] = useState<Set<string>>(new Set());
  const [expandedSubagentIds, setExpandedSubagentIds] = useState<Set<string>>(new Set());

  const scrollRef = useRef<HTMLDivElement>(null);
  const { setSelectedEvent, sessions, activeSessionId, config, fetchAccessLog, scrollToEventId, clearScrollToEvent, bookmarks } = useSessionStore();
  const historicalEventsFromStore = useSessionStore((s) => s.historicalEvents);

  const collapseHistory = config?.collapseHistory ?? true;
  const autoScroll = config?.autoScroll ?? true;

  const showAgentBadge = useMemo(
    () => new Set(sessions.map((s) => s.agentType)).size > 1,
    [sessions]
  );

  // For archived sessions, source events from historicalEvents in the store
  const sourceOverride = archived ? historicalEventsFromStore : undefined;

  const { events, sessionEvents, totalCount } = useEventStore({
    promptsOnly,
    requestsOnly,
    riskyOnly,
    toolsOnly,
    agentsOnly,
    searchQuery,
  }, sourceOverride);

  // Build exchange groups from unfiltered session events
  const { prolog, exchanges } = useMemo(
    () => buildExchanges(sessionEvents),
    [sessionEvents]
  );

  // Index map: event ID → position in sessionEvents (for EventCard sequence numbers)
  const eventIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    sessionEvents.forEach((e, i) => map.set(e.id, i));
    return map;
  }, [sessionEvents]);

  // Show exchange tree only when no filters are active
  const hasActiveFilter = promptsOnly || toolsOnly || requestsOnly || agentsOnly || riskyOnly || searchQuery.trim().length > 0;
  const showExchangeTree = !hasActiveFilter;

  // Auto-expand the last exchange when exchange tree is active
  useEffect(() => {
    if (!showExchangeTree || exchanges.length === 0) return;
    const last = exchanges[exchanges.length - 1];
    setExpandedExchangeIds(prev => {
      if (prev.has(last.id)) return prev;
      const next = new Set(prev);
      next.add(last.id);
      return next;
    });
  }, [showExchangeTree, exchanges.length]);

  // Auto-scroll to bottom when new events arrive and following (live only)
  useEffect(() => {
    if (!archived && autoScroll && followLatest && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, sessionEvents.length, autoScroll, followLatest, archived]);

  // Update selected index to latest when following (live only)
  useEffect(() => {
    if (!archived && autoScroll && followLatest && events.length > 0) {
      setSelectedIndex(events.length - 1);
    }
  }, [events.length, autoScroll, followLatest, archived]);

  // Scroll to a specific event when navigating from Dashboard to Logs
  useEffect(() => {
    if (!scrollToEventId) return;

    // Expand the exchange containing this event
    if (showExchangeTree) {
      const parentExchange = exchanges.find(ex =>
        ex.promptEvent.id === scrollToEventId ||
        ex.children.some(c => {
          if ((c as SubagentLane).kind === 'subagent') {
            const lane = c as SubagentLane;
            return lane.startEvent.id === scrollToEventId ||
              lane.children.some(lc => lc.id === scrollToEventId) ||
              lane.stopEvent?.id === scrollToEventId;
          }
          return (c as TimelineEvent).id === scrollToEventId;
        })
      );
      if (parentExchange) {
        setExpandedExchangeIds(prev => new Set([...prev, parentExchange.id]));
      }
    }

    const idx = events.findIndex(e => e.id === scrollToEventId);
    if (idx >= 0) setSelectedIndex(idx);
    setFollowLatest(false);
    clearScrollToEvent();

    requestAnimationFrame(() => {
      const cards = scrollRef.current?.querySelectorAll('[data-event-card]');
      if (cards) {
        const target = Array.from(cards).find(c => {
          const id = c.querySelector('[data-event-id]')?.getAttribute('data-event-id');
          return id === scrollToEventId;
        });
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }, [scrollToEventId, events, exchanges, showExchangeTree, clearScrollToEvent]);

  // When tab becomes visible again, re-sync scroll position if following (live only)
  useEffect(() => {
    if (archived) return;
    const handleVisibilityChange = () => {
      if (!document.hidden && autoScroll && scrollRef.current) {
        setFollowLatest(true);
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [autoScroll, archived]);

  const handleScroll = useCallback(() => {
    if (!autoScroll || archived) return;
    if (document.hidden) return;
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setFollowLatest(isAtBottom);
  }, [autoScroll, archived]);

  const handleEventClick = useCallback((index: number, eventId: string) => {
    setSelectedIndex(index);
    setSelectedEvent(eventId);
    if (index < events.length - 1) {
      setFollowLatest(false);
    }
  }, [events.length, setSelectedEvent]);

  const jumpToLatest = useCallback(() => {
    const idx = events.length - 1;
    setSelectedIndex(idx);
    if (events[idx]) setSelectedEvent(events[idx].id);
    setFollowLatest(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, setSelectedEvent]);

  const handlePrint = useCallback(() => {
    document.body.classList.add('layman-print-live');
    const cleanup = () => {
      document.body.classList.remove('layman-print-live');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    window.print();
  }, []);

  const goToIndex = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, events.length - 1));
    setSelectedIndex(clamped);
    if (events[clamped]) {
      setSelectedEvent(events[clamped].id);
    }
    const cards = scrollRef.current?.querySelectorAll('[data-event-card]');
    if (cards && cards[clamped]) {
      cards[clamped].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [events, setSelectedEvent]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          goToIndex(selectedIndex - 1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          goToIndex(selectedIndex + 1);
          break;
        case 'Home':
          e.preventDefault();
          goToIndex(0);
          break;
        case 'End':
          e.preventDefault();
          goToIndex(events.length - 1);
          setFollowLatest(true);
          break;
        case 'p':
        case 'P':
          setPromptsOnly(v => !v);
          break;
        case 'q':
        case 'Q':
          setRequestsOnly(v => !v);
          break;
        case 'r':
        case 'R':
          setRiskyOnly(v => !v);
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedIndex, events.length, goToIndex]);

  const bookmarkedSessionIds = useMemo(
    () => new Set(bookmarks.map((b) => b.sessionId)),
    [bookmarks]
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );

  const defaultBookmarkName = useMemo(() => {
    if (!activeSession) return activeSessionId?.slice(0, 8) ?? '';
    const { cwd, sessionId, sessionName } = activeSession;
    return sessionName || (cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : sessionId.slice(0, 8));
  }, [activeSession, activeSessionId]);

  const handleBookmark = useCallback((name: string) => {
    if (!activeSessionId) return;
    void saveAndBookmarkSession(activeSessionId, name.trim() || activeSessionId.slice(0, 8));
  }, [activeSessionId]);

  const activeOpenCodeSession =
    (activeSessionId !== null
      ? sessions.find((s) => s.sessionId === activeSessionId && s.agentType === 'opencode')
      : null) ?? sessions.find((s) => s.agentType === 'opencode') ?? null;

  const toggleExchange = useCallback((id: string) => {
    setExpandedExchangeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSubagent = useCallback((id: string) => {
    setExpandedSubagentIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const hasEvents = sessionEvents.length > 0;
  const bufferedCount = totalCount - events.length;

  return (
    <div className="flex flex-col h-full">
      <NavigationBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        promptsOnly={promptsOnly}
        toolsOnly={toolsOnly}
        requestsOnly={requestsOnly}
        agentsOnly={agentsOnly}
        riskyOnly={riskyOnly}
        onTogglePromptsOnly={() => setPromptsOnly(v => !v)}
        onToggleToolsOnly={() => setToolsOnly(v => !v)}
        onToggleRequestsOnly={() => setRequestsOnly(v => !v)}
        onToggleAgentsOnly={() => setAgentsOnly(v => !v)}
        onToggleRiskyOnly={() => setRiskyOnly(v => !v)}
        followLatest={followLatest}
        archived={archived}
        archivedDate={archivedDate}
        onAccessLog={!archived && activeSessionId ? () => void fetchAccessLog(activeSessionId) : undefined}
        onPrint={handlePrint}
        onBookmark={!archived && activeSessionId ? handleBookmark : undefined}
        isBookmarked={!archived && activeSessionId ? bookmarkedSessionIds.has(activeSessionId) : true}
        defaultBookmarkName={defaultBookmarkName}
      />

      {!archived && <SessionMetricsBar />}

      {/* Content area: minimap + scroll area */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Minimap */}
        {hasEvents && (
          <Minimap events={sessionEvents} scrollRef={scrollRef} />
        )}

        {/* Scroll area */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          data-print-stream
          style={{ flex: 1, overflowY: 'auto', paddingTop: 4, paddingBottom: 4 }}
        >
          {!hasEvents ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', gap: 12, textAlign: 'center',
              padding: '0 32px',
            }}>
              <div style={{ fontSize: 36 }}>👁</div>
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, color: 'var(--text)', margin: 0 }}>
                Waiting for events…
              </p>
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
                Hooks are installed. Start a Claude Code, Codex, Cline, OpenCode, or Mistral Vibe session to see events here.
              </p>
              <div style={{
                marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)',
                background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6,
                padding: '10px 16px', textAlign: 'left',
              }}>
                <p style={{ color: 'var(--text-muted)', margin: '0 0 4px 0' }}># In your AI agent:</p>
                <p style={{ margin: 0 }}>type /layman to begin</p>
              </div>
            </div>
          ) : showExchangeTree ? (
            /* Exchange tree view */
            <>
              {/* Pre-exchange events (session_start, etc.) */}
              {prolog.map((event, index) => (
                <div key={event.id} data-event-card>
                  <EventCard
                    event={event}
                    index={index}
                    isSelected={selectedIndex === index}
                    onClick={() => handleEventClick(index, event.id)}
                    onSend={onSend}
                    collapseHistory={collapseHistory}
                    showAgentBadge={showAgentBadge}
                  />
                </div>
              ))}

              {/* Exchange groups */}
              {exchanges.map(exchange => {
                const isExpanded = expandedExchangeIds.has(exchange.id);

                if (!isExpanded) {
                  return (
                    <CollapsedExchangeRow
                      key={exchange.id}
                      exchange={exchange}
                      onClick={() => toggleExchange(exchange.id)}
                    />
                  );
                }

                return (
                  <ExpandedExchange
                    key={exchange.id}
                    exchange={exchange}
                    onCollapse={() => toggleExchange(exchange.id)}
                    expandedSubagentIds={expandedSubagentIds}
                    onToggleSubagent={toggleSubagent}
                    eventIndexMap={eventIndexMap}
                    selectedIndex={selectedIndex}
                    events={events}
                    onSelectEvent={handleEventClick}
                    onSend={onSend}
                    collapseHistory={collapseHistory}
                    showAgentBadge={showAgentBadge}
                  />
                );
              })}
            </>
          ) : (
            /* Flat filtered view */
            events.map((event, index) => (
              <div key={event.id} data-event-card>
                <EventCard
                  event={event}
                  index={index}
                  isSelected={selectedIndex === index}
                  onClick={() => handleEventClick(index, event.id)}
                  onSend={onSend}
                  collapseHistory={collapseHistory}
                  showAgentBadge={showAgentBadge}
                />
              </div>
            ))
          )}
        </div>

        {/* Jump to latest pill — floats above the stream (live only) */}
        {!archived && autoScroll && !followLatest && totalCount > 0 && (
          <div data-print-hide style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
          }}>
            <JumpToLatest
              count={Math.max(0, bufferedCount)}
              onClick={jumpToLatest}
            />
          </div>
        )}
      </div>

      {!archived && activeOpenCodeSession && (
        <div data-print-hide>
          <PromptInput sessionId={activeOpenCodeSession.sessionId} />
        </div>
      )}
    </div>
  );
}

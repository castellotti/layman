import { useMemo, useCallback } from 'react';
import type { TimelineEvent } from '../../lib/types.js';
import { useEventStore } from '../../hooks/useEventStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { extractToolSpans, type ToolSpan } from '../../lib/parallel-detection.js';
import { NODE_BORDER_COLORS } from '../../lib/event-styles.js';

const LABEL_W = 180;

interface SubagentSpan {
  startEvent: TimelineEvent;
  stopEvent?: TimelineEvent;
  childSpans: ToolSpan[];
}

function extractSubagentSpans(events: TimelineEvent[], toolSpans: ToolSpan[]): SubagentSpan[] {
  const spans: SubagentSpan[] = [];
  const openSubagents: TimelineEvent[] = [];

  for (const event of events) {
    if (event.type === 'subagent_start') {
      openSubagents.push(event);
    } else if (event.type === 'subagent_stop' && openSubagents.length > 0) {
      const start = openSubagents.shift()!;
      const children = toolSpans.filter(
        s => s.pendingEvent.timestamp >= start.timestamp &&
             (event.timestamp === 0 || s.pendingEvent.timestamp <= event.timestamp)
      );
      spans.push({ startEvent: start, stopEvent: event, childSpans: children });
    }
  }
  // Open subagents (no stop yet)
  for (const start of openSubagents) {
    const children = toolSpans.filter(s => s.pendingEvent.timestamp >= start.timestamp);
    spans.push({ startEvent: start, childSpans: children });
  }

  return spans;
}

function formatTick(sec: number): string {
  if (sec < 60) return sec % 1 === 0 ? `${sec}s` : `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function computeTicks(durationSec: number): number[] {
  const tickStep =
    durationSec <= 2 ? 0.5
    : durationSec <= 10 ? 1
    : durationSec <= 30 ? 5
    : durationSec <= 60 ? 10
    : durationSec <= 300 ? 30
    : durationSec <= 600 ? 60
    : durationSec <= 1800 ? 300
    : durationSec <= 7200 ? 600
    : durationSec <= 18000 ? 1800
    : 3600;

  const ticks: number[] = [];
  for (let t = 0; t <= durationSec * 1.05 + tickStep; t += tickStep) {
    if (t <= durationSec * 1.05) ticks.push(t);
  }
  return ticks;
}

function spanColor(span: ToolSpan): string {
  if (!span.completionEvent) return NODE_BORDER_COLORS['tool_call_pending'] ?? '#d29922';
  return NODE_BORDER_COLORS[span.completionEvent.type] ?? '#3fb950';
}

interface TimelineContentProps {
  events: TimelineEvent[];
  onSelectEvent: (id: string | null) => void;
  selectedEventId: string | null;
}

function TimelineContent({ events, onSelectEvent, selectedEventId }: TimelineContentProps) {
  const toolSpans = useMemo(() => extractToolSpans(events), [events]);
  const subagentSpans = useMemo(() => extractSubagentSpans(events, toolSpans), [events, toolSpans]);

  // Compute time range
  const minTime = useMemo(() => {
    if (events.length === 0) return 0;
    return Math.min(...events.map(e => e.timestamp));
  }, [events]);

  const maxTime = useMemo(() => {
    if (events.length === 0) return 0;
    return Math.max(...events.map(e => e.timestamp));
  }, [events]);

  const range = Math.max(maxTime - minTime, 500); // minimum 500ms
  const durationSec = range / 1000;
  const ticks = useMemo(() => computeTicks(durationSec), [durationSec]);

  // Build display rows: standalone tool spans (not in any subagent) + subagent groups
  const subagentToolIds = useMemo(() => {
    const ids = new Set<string>();
    for (const sa of subagentSpans) {
      for (const child of sa.childSpans) {
        ids.add(child.pendingEvent.id);
      }
    }
    return ids;
  }, [subagentSpans]);

  const standaloneSpans = useMemo(
    () => toolSpans.filter(s => !subagentToolIds.has(s.pendingEvent.id)),
    [toolSpans, subagentToolIds]
  );

  const handleClick = useCallback((eventId: string) => {
    onSelectEvent(eventId);
  }, [onSelectEvent]);

  if (toolSpans.length === 0 && subagentSpans.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[#484f58] text-xs">
        Waiting for tool executions...
      </div>
    );
  }

  const pctScale = 100 / 1.05;

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      {/* Time axis */}
      <div className="relative h-5 mb-1" style={{ marginLeft: LABEL_W }}>
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute text-[9px] font-mono text-[#8b949e] -translate-x-1/2"
            style={{ left: `${(t / (durationSec * 1.05)) * 100}%` }}
          >
            {formatTick(t)}
          </span>
        ))}
      </div>

      {/* Grid lines */}
      <div className="relative" style={{ marginLeft: LABEL_W }}>
        <div className="absolute inset-0 pointer-events-none">
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute top-0 bottom-0 w-px bg-[#30363d] opacity-20"
              style={{ left: `${(t / (durationSec * 1.05)) * 100}%` }}
            />
          ))}
        </div>
      </div>

      {/* Rows */}
      <div className="space-y-px">
        {/* Standalone tool spans */}
        {standaloneSpans.map((span, idx) => (
          <SpanRow
            key={span.pendingEvent.id}
            span={span}
            minTime={minTime}
            range={range}
            pctScale={pctScale}
            durationSec={durationSec}
            depth={0}
            isSelected={span.pendingEvent.id === selectedEventId || span.completionEvent?.id === selectedEventId}
            isEven={idx % 2 === 0}
            onClick={handleClick}
          />
        ))}

        {/* Subagent spans with children */}
        {subagentSpans.map((sa, saIdx) => {
          const saStart = sa.startEvent.timestamp;
          const saEnd = sa.stopEvent?.timestamp ?? maxTime;
          const saStartPct = ((saStart - minTime) / range) * pctScale;
          const saWidthPct = Math.max(((saEnd - saStart) / range) * pctScale, 0.5);
          const saDuration = saEnd - saStart;
          const isActive = !sa.stopEvent;
          const saSelected = sa.startEvent.id === selectedEventId || sa.stopEvent?.id === selectedEventId;

          return (
            <div key={sa.startEvent.id}>
              {/* Subagent parent row */}
              <button
                onClick={() => handleClick(sa.startEvent.id)}
                className={`flex items-center w-full text-left h-7 rounded-md transition-all duration-150 ${
                  saSelected ? 'bg-[#58a6ff]/8' : (standaloneSpans.length + saIdx) % 2 === 1 ? 'bg-[#ffffff03] hover:bg-[#ffffff08]' : 'hover:bg-[#ffffff08]'
                }`}
              >
                <div className="shrink-0 pr-2 flex items-center" style={{ width: LABEL_W }}>
                  {isActive ? (
                    <span className="w-1.5 h-1.5 rounded-full bg-[#58a6ff] mr-1.5 shrink-0 animate-pulse" />
                  ) : (
                    <span className="text-[9px] font-mono mr-1.5 shrink-0 text-[#3fb950]">&#x2713;</span>
                  )}
                  <span className="text-[10px] font-mono truncate text-[#58a6ff]">
                    {sa.startEvent.data.toolName ?? 'Subagent'}
                  </span>
                </div>
                <div className="flex-1 h-full relative">
                  <div
                    className={`absolute top-1.5 h-4 rounded-full transition-opacity duration-200 ${isActive ? 'animate-pulse' : ''}`}
                    style={{
                      left: `${saStartPct}%`,
                      width: `${saWidthPct}%`,
                      background: isActive ? '#58a6ff' : '#58a6ffB3',
                      opacity: isActive ? 1 : 0.5,
                      minWidth: 3,
                    }}
                  />
                  <span
                    className="absolute top-1.5 text-[9px] font-sans text-[#8b949e] whitespace-nowrap"
                    style={{ left: `calc(${saStartPct + saWidthPct}% + 4px)` }}
                  >
                    {formatTick(saDuration / 1000)}
                    {sa.childSpans.length > 0 && ` · ${sa.childSpans.length}t`}
                  </span>
                </div>
              </button>

              {/* Child tool spans */}
              {sa.childSpans.map((span, childIdx) => (
                <SpanRow
                  key={span.pendingEvent.id}
                  span={span}
                  minTime={minTime}
                  range={range}
                  pctScale={pctScale}
                  durationSec={durationSec}
                  depth={1}
                  isSelected={span.pendingEvent.id === selectedEventId || span.completionEvent?.id === selectedEventId}
                  isEven={childIdx % 2 === 0}
                  onClick={handleClick}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SpanRowProps {
  span: ToolSpan;
  minTime: number;
  range: number;
  pctScale: number;
  durationSec: number;
  depth: number;
  isSelected: boolean;
  isEven: boolean;
  onClick: (eventId: string) => void;
}

function SpanRow({ span, minTime, range, pctScale, depth, isSelected, isEven, onClick }: SpanRowProps) {
  const indent = depth * 16;
  const color = spanColor(span);
  const isActive = !span.completionEvent;
  const isFailed = span.completionEvent?.type === 'tool_call_failed';
  const startPct = ((span.pendingEvent.timestamp - minTime) / range) * pctScale;
  const endTime = span.completionEvent?.timestamp ?? Date.now();
  const widthPct = Math.max(((endTime - span.pendingEvent.timestamp) / range) * pctScale, 0.5);
  const duration = endTime - span.pendingEvent.timestamp;
  const toolName = span.pendingEvent.data.toolName ?? 'unknown';

  return (
    <button
      onClick={() => onClick(span.pendingEvent.id)}
      className={`flex items-center w-full text-left h-7 rounded-md transition-all duration-150 ${
        isSelected ? 'bg-[#58a6ff]/8' : isEven ? 'hover:bg-[#ffffff08]' : 'bg-[#ffffff03] hover:bg-[#ffffff08]'
      }`}
    >
      <div className="shrink-0 pr-2 flex items-center" style={{ width: LABEL_W, paddingLeft: indent }}>
        {isActive ? (
          <span className="w-1.5 h-1.5 rounded-full bg-[#d29922] mr-1.5 shrink-0 animate-pulse" />
        ) : (
          <span
            className="text-[9px] font-mono mr-1.5 shrink-0"
            style={{ color: isFailed ? '#f85149' : '#3fb950' }}
          >
            {isFailed ? '\u2717' : '\u2713'}
          </span>
        )}
        <span
          className="text-[10px] font-mono truncate"
          style={{ color: isActive ? color : '#e6edf3' }}
        >
          {toolName}
        </span>
      </div>
      <div className="flex-1 h-full relative">
        <div
          className={`absolute top-1.5 h-4 rounded-full transition-opacity duration-200 ${isActive ? 'animate-pulse' : ''}`}
          style={{
            left: `${startPct}%`,
            width: `${widthPct}%`,
            background: isActive ? color : `${color}B3`,
            opacity: isActive ? 1 : 0.7,
            minWidth: 3,
          }}
        />
        <span
          className="absolute top-1.5 text-[9px] font-sans text-[#8b949e] whitespace-nowrap"
          style={{ left: `calc(${startPct + widthPct}% + 4px)` }}
        >
          {formatTick(duration / 1000)}
          {isFailed && <span className="text-[#f85149]"> &#x26A0;</span>}
        </span>
      </div>
    </button>
  );
}

interface TimelineViewProps {
  events?: TimelineEvent[];
  onSelectEvent?: (id: string | null) => void;
  selectedEventId?: string | null;
}

export function TimelineView({ events: externalEvents, onSelectEvent, selectedEventId: externalSelectedEventId }: TimelineViewProps) {
  const { setSelectedEvent, selectedEventId: storeSelectedEventId } = useSessionStore();
  const { events: liveEvents } = useEventStore({
    promptsOnly: false,
    responsesOnly: false,
    requestsOnly: false,
    riskyOnly: false,
  });

  const events = externalEvents ?? liveEvents;
  const selectedEventId = externalSelectedEventId !== undefined ? externalSelectedEventId : storeSelectedEventId;
  const handleSelect = onSelectEvent ?? setSelectedEvent;

  return (
    <div className="h-full w-full bg-[#0d1117]">
      <TimelineContent
        events={events}
        onSelectEvent={handleSelect}
        selectedEventId={selectedEventId}
      />
    </div>
  );
}

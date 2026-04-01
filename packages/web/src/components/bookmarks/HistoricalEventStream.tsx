import React, { useCallback } from 'react';
import type { TimelineEvent, QAEntry, SessionTimeMetrics } from '../../lib/types.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EventCard } from '../events/EventCard.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

function formatMetricDuration(ms: number): string {
  if (ms < 1000) return '< 1s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface HistoricalEventStreamProps {
  events: TimelineEvent[];
  qaEntries: QAEntry[];
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
  onSend: (msg: ClientMessage) => void;
}

export function HistoricalEventStream({
  events,
  qaEntries,
  selectedEventId,
  onSelectEvent,
  onSend,
}: HistoricalEventStreamProps) {
  const { config } = useSessionStore();
  const sessionTimeMetrics = useSessionStore((s) => s.sessionTimeMetrics);
  const collapseHistory = config?.collapseHistory ?? true;

  const qaByEvent = useCallback(() => {
    const map = new Map<string, QAEntry[]>();
    for (const qa of qaEntries) {
      const existing = map.get(qa.eventId) ?? [];
      existing.push(qa);
      map.set(qa.eventId, existing);
    }
    return map;
  }, [qaEntries]);

  const qaMap = qaByEvent();

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-8">
        <span className="text-2xl opacity-30">📭</span>
        <p className="text-xs text-[#8b949e]">No events recorded for this session.</p>
      </div>
    );
  }

  return (
    <div data-print-stream className="flex flex-col overflow-y-auto h-full">
      <div className="px-2 py-2 border-b border-[#30363d] shrink-0">
        {sessionTimeMetrics && sessionTimeMetrics.wallClockMs > 0 ? (
          <div className="flex items-center text-[10px]">
            <span className="text-[#484f58]">
              {events.length} events
            </span>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 ml-auto">
              <span className="text-[#e6edf3]" title="Total elapsed time from first to last event">
                Total: {formatMetricDuration(sessionTimeMetrics.wallClockMs)}
              </span>
              <span className="text-[#3fb950]" title="Time the agent was actively processing (tool calls, generating responses)">
                Agent: {formatMetricDuration(sessionTimeMetrics.agentActiveMs)}
              </span>
              <span className="text-[#58a6ff]" title="Time you were composing prompts or responding to approvals">
                You: {formatMetricDuration(sessionTimeMetrics.userActiveMs)}
              </span>
              {sessionTimeMetrics.idleMs > 0 && (
                <span className="text-[#484f58]" title={`Idle gaps (pauses longer than ${sessionTimeMetrics.idleThresholdMinutes}min)`}>
                  Idle: {formatMetricDuration(sessionTimeMetrics.idleMs)}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-[#484f58]">
            {events.length} recorded events · click to investigate
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {events.map((event, index) => {
          const eventQA = qaMap.get(event.id) ?? [];
          return (
            <div key={event.id} data-event-card>
              <EventCard
                event={event}
                index={index}
                isSelected={selectedEventId === event.id}
                onClick={() => onSelectEvent(selectedEventId === event.id ? null : event.id)}
                onSend={onSend}
                collapseHistory={collapseHistory}
              />
              {eventQA.length > 0 && selectedEventId === event.id && (
                <div className="ml-4 mt-1 mb-2 border-l-2 border-[#30363d] pl-3 space-y-2">
                  <p className="text-[10px] text-[#484f58] font-medium uppercase tracking-wider">Q&A History</p>
                  {eventQA.map((qa) => (
                    <div key={qa.id} className="space-y-1">
                      <p className="text-[10px] text-[#58a6ff]">Q: {qa.question}</p>
                      <p className="text-[10px] text-[#e6edf3]">{qa.answer}</p>
                      {(qa.model ?? qa.tokensIn) && (
                        <p className="text-[9px] text-[#484f58]">
                          {qa.model && <span>{qa.model}</span>}
                          {qa.tokensIn !== null && <span> · {qa.tokensIn}↑ {qa.tokensOut}↓ tokens</span>}
                          {qa.latencyMs !== null && <span> · {qa.latencyMs}ms</span>}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

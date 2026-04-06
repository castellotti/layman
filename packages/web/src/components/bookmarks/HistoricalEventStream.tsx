import React, { useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { TimelineEvent, QAEntry, SessionTimeMetrics } from '../../lib/types.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EventCard } from '../events/EventCard.js';
import { isMarkdown } from '../../lib/markdown.js';
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

const MARKDOWN_PROSE = `text-[10px] text-[#e6edf3] leading-relaxed prose prose-invert prose-xs max-w-none
  [&_p]:my-1 [&_p]:leading-relaxed
  [&_strong]:text-[#e6edf3] [&_strong]:font-semibold
  [&_em]:text-[#8b949e]
  [&_code]:text-[#79c0ff] [&_code]:bg-[#0d1117] [&_code]:px-1 [&_code]:rounded [&_code]:text-[10px]
  [&_pre]:bg-[#0d1117] [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto
  [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1
  [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1
  [&_li]:my-0.5
  [&_h1]:text-xs [&_h2]:text-xs [&_h3]:text-[10px] [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold
  [&_blockquote]:border-l-2 [&_blockquote]:border-[#30363d] [&_blockquote]:pl-2 [&_blockquote]:text-[#8b949e]`.replace(/\s+/g, ' ').trim();

function HistoricalMarkdownOrText({ text }: { text: string }) {
  if (isMarkdown(text)) {
    return <div className={MARKDOWN_PROSE}><ReactMarkdown>{text}</ReactMarkdown></div>;
  }
  return <p className="text-[10px] text-[#e6edf3] whitespace-pre-wrap">{text}</p>;
}

function HistoricalCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[9px] text-[#8b949e] hover:text-[#e6edf3] transition-colors shrink-0"
    >
      {copied ? '✓' : 'Copy'}
    </button>
  );
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
                      <div className="flex items-start gap-1">
                        <p className="text-[10px] text-[#58a6ff] flex-1 min-w-0">Q: {qa.question}</p>
                        <HistoricalCopyButton text={qa.question} />
                      </div>
                      <div className="flex items-start gap-1">
                        <div className="flex-1 min-w-0">
                          <HistoricalMarkdownOrText text={qa.answer} />
                        </div>
                        <HistoricalCopyButton text={qa.answer} />
                      </div>
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

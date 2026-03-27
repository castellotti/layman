import React, { useMemo } from 'react';
import { useSearchStore, eventPassesFilters } from '../../stores/searchStore.js';
import type { SearchResultData } from '../../stores/searchStore.js';
import { EventCard } from '../events/EventCard.js';

function noopSend(): void {}

function getSessionLabel(cwd: string, sessionId: string): string {
  if (cwd) return cwd.split('/').filter(Boolean).pop() ?? cwd;
  return sessionId.slice(0, 8);
}

interface SearchResultsProps {
  results: SearchResultData;
  onOpenSession: (sessionId: string) => void;
}

export function SearchResults({ results, onOpenSession }: SearchResultsProps) {
  const { eventTypeFilters, clearSearch } = useSearchStore();

  // Group events by session, applying event type filters
  const filteredEvents = useMemo(() =>
    results.events.filter((e) => eventPassesFilters(e, eventTypeFilters, results.events)),
    [results.events, eventTypeFilters]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, typeof filteredEvents>();
    for (const event of filteredEvents) {
      const list = map.get(event.sessionId) ?? [];
      list.push(event);
      map.set(event.sessionId, list);
    }
    return map;
  }, [filteredEvents]);

  const sessionOrder = results.sessions.filter((s) => grouped.has(s.sessionId));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Summary bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d] bg-[#161b22] shrink-0">
        <div>
          <p className="text-xs text-[#e6edf3]">
            <span className="text-[#58a6ff] font-medium">{results.totalMatches}</span> results across{' '}
            <span className="text-[#58a6ff] font-medium">{results.sessions.length}</span> sessions
          </p>
          {filteredEvents.length < results.events.length && (
            <p className="text-[10px] text-[#484f58]">
              Showing {filteredEvents.length} after type filters
            </p>
          )}
        </div>
        <button
          onClick={clearSearch}
          className="text-[10px] text-[#484f58] hover:text-[#f85149] transition-colors"
        >
          Clear
        </button>
      </div>

      {/* Grouped results */}
      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {sessionOrder.map((session) => {
          const events = grouped.get(session.sessionId) ?? [];
          return (
            <div key={session.sessionId} className="space-y-1">
              {/* Session header */}
              <div className="flex items-center justify-between px-2 py-1.5 bg-[#161b22] rounded border border-[#21262d]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-[#e6edf3] font-medium truncate">
                    {getSessionLabel(session.cwd, session.sessionId)}
                  </span>
                  <span className="text-[10px] text-[#484f58]">
                    {session.sessionId.slice(0, 6)}
                  </span>
                  <span className="px-1.5 py-0.5 text-[9px] rounded-full bg-[#21262d] border border-[#30363d] text-[#58a6ff]">
                    {session.matchCount} match{session.matchCount !== 1 ? 'es' : ''}
                  </span>
                </div>
                <button
                  onClick={() => onOpenSession(session.sessionId)}
                  className="shrink-0 text-[10px] text-[#58a6ff] hover:text-[#79c0ff] transition-colors"
                >
                  Open full session
                </button>
              </div>

              {/* Events */}
              <div className="space-y-1 pl-1">
                {events.map((event, index) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    index={index}
                    isSelected={false}
                    onClick={() => {}}
                    onSend={noopSend}
                    collapseHistory={false}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {sessionOrder.length === 0 && filteredEvents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <p className="text-xs text-[#484f58]">No results match the current filters.</p>
          </div>
        )}
      </div>
    </div>
  );
}

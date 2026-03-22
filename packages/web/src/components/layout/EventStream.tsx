import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useEventStore } from '../../hooks/useEventStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { EventCard } from '../events/EventCard.js';
import { NavigationBar } from '../controls/NavigationBar.js';
import { PromptInput } from '../controls/PromptInput.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';

interface EventStreamProps {
  onSend: (msg: ClientMessage) => void;
}

export function EventStream({ onSend }: EventStreamProps) {
  const [promptsOnly, setPromptsOnly] = useState(false);
  const [riskyOnly, setRiskyOnly] = useState(false);
  const [collapseHistory, setCollapseHistory] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [followLatest, setFollowLatest] = useState(true);
  const [activeAgentTypes, setActiveAgentTypes] = useState<string[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const { setSelectedEvent, sessions, activeSessionId } = useSessionStore();

  // Show agent badges only when sessions from multiple agent types are active
  const availableAgentTypes = [...new Set(sessions.map((s) => s.agentType))];
  const showAgentBadge = availableAgentTypes.length > 1;

  const handleToggleAgentType = (agentType: string) => {
    setActiveAgentTypes((prev) => {
      if (prev.length === 0) {
        // Currently showing all — filter to only the others
        return availableAgentTypes.filter((at) => at !== agentType);
      }
      if (prev.includes(agentType)) {
        const next = prev.filter((at) => at !== agentType);
        return next.length === 0 ? [] : next; // If none left, show all
      }
      return [...prev, agentType];
    });
  };

  const { events, totalCount } = useEventStore({
    promptsOnly,
    riskyOnly,
    agentTypes: activeAgentTypes.length > 0 ? activeAgentTypes : undefined,
  });

  // Auto-scroll to bottom when new events arrive and following
  useEffect(() => {
    if (autoScroll && followLatest && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, autoScroll, followLatest]);

  // Update selected index to latest when following
  useEffect(() => {
    if (autoScroll && followLatest && events.length > 0) {
      setSelectedIndex(events.length - 1);
    }
  }, [events.length, autoScroll, followLatest]);

  const handleScroll = useCallback(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    setFollowLatest(isAtBottom);
  }, [autoScroll]);

  const handleEventClick = (index: number, eventId: string) => {
    setSelectedIndex(index);
    setSelectedEvent(eventId);
    // Pause auto-scroll when user explicitly clicks on a non-latest event
    if (index < events.length - 1) {
      setFollowLatest(false);
    }
  };

  const handleToggleAutoScroll = useCallback(() => {
    setAutoScroll((prev) => {
      if (!prev) {
        // Re-enabling: resume following
        setFollowLatest(true);
      }
      return !prev;
    });
  }, []);

  const jumpToLatest = useCallback(() => {
    const idx = events.length - 1;
    setSelectedIndex(idx);
    if (events[idx]) setSelectedEvent(events[idx].id);
    setFollowLatest(true);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, setSelectedEvent]);

  const goToIndex = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, events.length - 1));
    setSelectedIndex(clamped);
    if (events[clamped]) {
      setSelectedEvent(events[clamped].id);
    }

    // Scroll to element
    const cards = scrollRef.current?.querySelectorAll('[data-event-card]');
    if (cards && cards[clamped]) {
      cards[clamped].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

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
          setPromptsOnly((v) => !v);
          break;
        case 'r':
        case 'R':
          setRiskyOnly((v) => !v);
          break;
      }
    };

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedIndex, events.length]);

  // Determine the active OpenCode session (if any) for prompt submission.
  // Prefer the explicitly-selected session if it's OpenCode; otherwise fall back to
  // the first OpenCode session in the list so the input is always reachable even when
  // a Claude session is currently selected or "All sessions" is shown.
  const activeOpenCodeSession =
    (activeSessionId !== null
      ? sessions.find((s) => s.sessionId === activeSessionId && s.agentType === 'opencode')
      : null) ?? sessions.find((s) => s.agentType === 'opencode') ?? null;

  return (
    <div className="flex flex-col h-full">
      <NavigationBar
        currentIndex={selectedIndex >= 0 ? selectedIndex : 0}
        total={events.length}
        onFirst={() => goToIndex(0)}
        onPrev={() => goToIndex(selectedIndex - 1)}
        onNext={() => goToIndex(selectedIndex + 1)}
        onLatest={() => {
          goToIndex(events.length - 1);
          setFollowLatest(true);
        }}
        promptsOnly={promptsOnly}
        riskyOnly={riskyOnly}
        collapseHistory={collapseHistory}
        autoScroll={autoScroll}
        onTogglePromptsOnly={() => setPromptsOnly((v) => !v)}
        onToggleRiskyOnly={() => setRiskyOnly((v) => !v)}
        onToggleCollapseHistory={() => setCollapseHistory((v) => !v)}
        onToggleAutoScroll={handleToggleAutoScroll}
        availableAgentTypes={availableAgentTypes}
        activeAgentTypes={activeAgentTypes}
        onToggleAgentType={handleToggleAgentType}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-2"
      >
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
            <div className="text-4xl">👁</div>
            <p className="text-sm font-medium text-[#e6edf3]">Waiting for Claude Code...</p>
            <p className="text-xs text-[#8b949e]">
              Hooks are installed. Start a Claude Code session to see events here.
            </p>
            <div className="mt-2 text-xs text-[#484f58] bg-[#161b22] border border-[#30363d] rounded-md px-4 py-3 font-mono text-left">
              <p className="text-[#8b949e] mb-1"># In another terminal:</p>
              <p>claude "your task here"</p>
            </div>
          </div>
        ) : (
          <>
            {events.map((event, index) => (
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
          </>
        )}

        {/* Jump to latest button — shown when auto-scroll is on but currently paused */}
        {autoScroll && !followLatest && totalCount > 0 && (
          <button
            onClick={jumpToLatest}
            className="fixed bottom-12 left-1/2 -translate-x-1/2 text-xs font-medium px-4 py-2 bg-[#1f6feb] hover:bg-[#388bfd] text-white rounded-full shadow-lg transition-colors z-10"
          >
            ↓ Jump to latest
          </button>
        )}
      </div>

      {activeOpenCodeSession && (
        <PromptInput sessionId={activeOpenCodeSession.sessionId} />
      )}
    </div>
  );
}

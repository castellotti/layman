import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import type { TimelineEvent, EventType } from '../lib/types.js';

export interface EventFilters {
  promptsOnly?: boolean;
  requestsOnly?: boolean;
  riskyOnly?: boolean;
  toolsOnly?: boolean;
  agentsOnly?: boolean;
  searchQuery?: string;
  types?: EventType[];
  agentTypes?: string[];
}

const TOOL_EVENT_TYPES: EventType[] = [
  'tool_call_pending', 'tool_call_approved', 'tool_call_denied',
  'tool_call_delegated', 'tool_call_completed', 'tool_call_failed',
];

const AGENT_EVENT_TYPES: EventType[] = [
  'agent_response', 'subagent_start', 'subagent_stop', 'agent_stop',
];

function matchesSearch(event: TimelineEvent, query: string): boolean {
  const text = [
    event.type,
    event.data.toolName,
    event.data.prompt,
    event.data.error,
    event.data.toolInput ? JSON.stringify(event.data.toolInput) : '',
  ].filter(Boolean).join(' ').toLowerCase();

  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const includes = terms.filter(t => t.startsWith('+')).map(t => t.slice(1));
  const excludes = terms.filter(t => t.startsWith('-')).map(t => t.slice(1));
  const plain = terms.filter(t => !t.startsWith('+') && !t.startsWith('-'));

  for (const inc of includes) {
    if (inc && !text.includes(inc)) return false;
  }
  for (const exc of excludes) {
    if (exc && text.includes(exc)) return false;
  }
  for (const p of plain) {
    if (p && !text.includes(p)) return false;
  }
  return true;
}

export function useEventStore(filters?: EventFilters, sourceOverride?: TimelineEvent[]) {
  const { events, activeSessionId, historicalEvents } = useSessionStore((state) => ({
    events: state.events,
    activeSessionId: state.activeSessionId,
    historicalEvents: state.historicalEvents,
  }));

  const sessionEvents = useMemo(() => {
    if (sourceOverride !== undefined) return sourceOverride;
    if (!activeSessionId) return events;
    return events.filter((e) => e.sessionId === activeSessionId);
  }, [events, activeSessionId, sourceOverride]);

  const filteredEvents = useMemo(() => {
    let result = sessionEvents;

    if (filters?.promptsOnly) {
      result = result.filter((e) => e.type === 'user_prompt');
    }
    if (filters?.requestsOnly) {
      result = result.filter((e) => e.type === 'permission_request');
    }
    if (filters?.toolsOnly) {
      result = result.filter((e) => (TOOL_EVENT_TYPES as string[]).includes(e.type));
    }
    if (filters?.agentsOnly) {
      result = result.filter((e) => (AGENT_EVENT_TYPES as string[]).includes(e.type));
    }
    if (filters?.riskyOnly) {
      result = result.filter((e) => e.riskLevel === 'medium' || e.riskLevel === 'high');
    }
    if (filters?.searchQuery && filters.searchQuery.trim()) {
      result = result.filter((e) => matchesSearch(e, filters.searchQuery!));
    }
    if (filters?.types && filters.types.length > 0) {
      result = result.filter((e) => filters.types!.includes(e.type));
    }
    if (filters?.agentTypes && filters.agentTypes.length > 0) {
      result = result.filter((e) => filters.agentTypes!.includes(e.agentType));
    }

    return result;
  }, [
    sessionEvents,
    filters?.promptsOnly, filters?.requestsOnly,
    filters?.toolsOnly, filters?.agentsOnly, filters?.riskyOnly,
    filters?.searchQuery, filters?.types, filters?.agentTypes,
  ]);

  const pendingEvents = useMemo(
    () => sessionEvents.filter((e) => e.type === 'tool_call_pending' || e.type === 'permission_request'),
    [sessionEvents]
  );

  const getEvent = (id: string): TimelineEvent | undefined =>
    events.find((e) => e.id === id) ?? historicalEvents.find((e) => e.id === id);

  return {
    events: filteredEvents,
    allEvents: events,
    sessionEvents,
    pendingEvents,
    getEvent,
    totalCount: sessionEvents.length,
    filteredCount: filteredEvents.length,
  };
}

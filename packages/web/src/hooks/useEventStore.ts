import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import type { TimelineEvent, EventType } from '../lib/types.js';

export interface EventFilters {
  promptsOnly?: boolean;
  riskyOnly?: boolean;
  types?: EventType[];
  agentTypes?: string[];
}

export function useEventStore(filters?: EventFilters) {
  const { events, activeSessionId, historicalEvents } = useSessionStore((state) => ({
    events: state.events,
    activeSessionId: state.activeSessionId,
    historicalEvents: state.historicalEvents,
  }));

  const sessionEvents = useMemo(() => {
    if (!activeSessionId) return events;
    return events.filter((e) => e.sessionId === activeSessionId);
  }, [events, activeSessionId]);

  const filteredEvents = useMemo(() => {
    let result = sessionEvents;

    if (filters?.promptsOnly) {
      result = result.filter((e) =>
        ['tool_call_pending', 'permission_request'].includes(e.type)
      );
    }

    if (filters?.riskyOnly) {
      result = result.filter((e) => e.riskLevel === 'medium' || e.riskLevel === 'high');
    }

    if (filters?.types && filters.types.length > 0) {
      result = result.filter((e) => filters.types!.includes(e.type));
    }

    if (filters?.agentTypes && filters.agentTypes.length > 0) {
      result = result.filter((e) => filters.agentTypes!.includes(e.agentType));
    }

    return result;
  }, [sessionEvents, filters?.promptsOnly, filters?.riskyOnly, filters?.types, filters?.agentTypes]);

  const pendingEvents = useMemo(
    () => sessionEvents.filter((e) => e.type === 'tool_call_pending' || e.type === 'permission_request'),
    [sessionEvents]
  );

  const getEvent = (id: string): TimelineEvent | undefined =>
    events.find((e) => e.id === id) ?? historicalEvents.find((e) => e.id === id);

  return {
    events: filteredEvents,
    allEvents: events,
    pendingEvents,
    getEvent,
    totalCount: sessionEvents.length,
    filteredCount: filteredEvents.length,
  };
}

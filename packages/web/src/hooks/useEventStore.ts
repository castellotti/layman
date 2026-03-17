import { useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore.js';
import type { TimelineEvent, EventType } from '../lib/types.js';

export interface EventFilters {
  promptsOnly?: boolean;
  riskyOnly?: boolean;
  types?: EventType[];
}

export function useEventStore(filters?: EventFilters) {
  const events = useSessionStore((state) => state.events);

  const filteredEvents = useMemo(() => {
    let result = events;

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

    return result;
  }, [events, filters?.promptsOnly, filters?.riskyOnly, filters?.types]);

  const pendingEvents = useMemo(
    () => events.filter((e) => e.type === 'tool_call_pending' || e.type === 'permission_request'),
    [events]
  );

  const getEvent = (id: string): TimelineEvent | undefined =>
    events.find((e) => e.id === id);

  return {
    events: filteredEvents,
    allEvents: events,
    pendingEvents,
    getEvent,
    totalCount: events.length,
    filteredCount: filteredEvents.length,
  };
}

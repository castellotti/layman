import type { TimelineEvent } from './types.js';

export interface ToolSpan {
  pendingEvent: TimelineEvent;
  completionEvent?: TimelineEvent;
  /** Events between pending and completion (e.g. tool_call_approved) */
  intermediateEvents: TimelineEvent[];
}

export interface ParallelGroup {
  spans: ToolSpan[];
  /** Index in the filtered event array of the last event before this group */
  forkAfterIndex: number;
  /** Index of the first event after all spans in this group complete */
  joinBeforeIndex: number;
}

/**
 * Extract tool execution spans from a chronological event list.
 * Each span pairs a tool_call_pending with its matching completion.
 */
export function extractToolSpans(events: TimelineEvent[]): ToolSpan[] {
  const spans: ToolSpan[] = [];
  // Track open pending events: key = toolName, value = queue of pending events (FIFO)
  const openPending = new Map<string, TimelineEvent[]>();

  for (const event of events) {
    if (event.type === 'tool_call_pending') {
      const key = spanKey(event);
      if (!openPending.has(key)) openPending.set(key, []);
      openPending.get(key)!.push(event);
      spans.push({ pendingEvent: event, intermediateEvents: [] });
    } else if (event.type === 'tool_call_completed' || event.type === 'tool_call_failed') {
      const key = spanKey(event);
      const queue = openPending.get(key);
      if (queue && queue.length > 0) {
        const pending = queue.shift()!;
        if (queue.length === 0) openPending.delete(key);
        const span = spans.find(s => s.pendingEvent.id === pending.id);
        if (span) span.completionEvent = event;
      }
    } else if (event.type === 'tool_call_approved') {
      // Attach to the most recent unfinished span for this tool
      const key = spanKey(event);
      const queue = openPending.get(key);
      if (queue && queue.length > 0) {
        const pending = queue[queue.length - 1];
        const span = spans.find(s => s.pendingEvent.id === pending.id);
        if (span) span.intermediateEvents.push(event);
      }
    }
  }

  return spans;
}

function spanKey(event: TimelineEvent): string {
  return `${event.sessionId}:${event.data.toolName ?? ''}`;
}

/**
 * Detect groups of tool spans that overlap in time (parallel execution).
 * Returns groups sorted by their position in the event array.
 */
export function detectParallelGroups(
  events: TimelineEvent[],
  spans: ToolSpan[]
): ParallelGroup[] {
  if (spans.length < 2) return [];

  // Build an event index for quick lookup
  const eventIndex = new Map<string, number>();
  events.forEach((e, i) => eventIndex.set(e.id, i));

  // Sort spans by their pending event's position in the event array
  const sortedSpans = [...spans]
    .filter(s => eventIndex.has(s.pendingEvent.id))
    .sort((a, b) => (eventIndex.get(a.pendingEvent.id)! - eventIndex.get(b.pendingEvent.id)!));

  // Sweep-line: detect overlapping spans
  const groups: { spans: ToolSpan[] }[] = [];
  let currentGroup: ToolSpan[] = [];
  let currentGroupEndTime = -Infinity;

  for (const span of sortedSpans) {
    const startTime = span.pendingEvent.timestamp;
    const endTime = span.completionEvent?.timestamp ?? Infinity;

    if (currentGroup.length > 0 && startTime < currentGroupEndTime) {
      // Overlaps with current group
      currentGroup.push(span);
      currentGroupEndTime = Math.max(currentGroupEndTime, endTime);
    } else {
      // Flush previous group if it had 2+ spans
      if (currentGroup.length >= 2) {
        groups.push({ spans: [...currentGroup] });
      }
      currentGroup = [span];
      currentGroupEndTime = endTime;
    }
  }
  // Flush final group
  if (currentGroup.length >= 2) {
    groups.push({ spans: [...currentGroup] });
  }

  // Convert to ParallelGroup with fork/join indices
  return groups.map(g => {
    const firstPendingIdx = Math.min(
      ...g.spans.map(s => eventIndex.get(s.pendingEvent.id)!)
    );
    const lastCompletionIdx = Math.max(
      ...g.spans.map(s => {
        if (s.completionEvent && eventIndex.has(s.completionEvent.id)) {
          return eventIndex.get(s.completionEvent.id)!;
        }
        return events.length - 1;
      })
    );

    return {
      spans: g.spans,
      forkAfterIndex: Math.max(0, firstPendingIdx - 1),
      joinBeforeIndex: Math.min(events.length - 1, lastCompletionIdx + 1),
    };
  });
}

/**
 * Get the set of event IDs that belong to any parallel group's branches.
 * Used to exclude them from the main spine's sequential edges.
 */
export function getParallelEventIds(groups: ParallelGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const span of group.spans) {
      ids.add(span.pendingEvent.id);
      if (span.completionEvent) ids.add(span.completionEvent.id);
      for (const mid of span.intermediateEvents) ids.add(mid.id);
    }
  }
  return ids;
}

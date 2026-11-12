import type { TimelineEvent } from './types.js';

/**
 * Data a reader of what happened (the activity board) never uses and that holds most of a recorded
 * session's bytes: a call's output, a subagent's transcript, reasoning, a compaction summary.
 */
const HEAVY = ['toolOutput', 'subagentTranscript', 'thinking', 'compactSummary'] as const;

/** The event without its heavy data (`?lean=1` on a session's recorded events). */
export function leanEvent(event: TimelineEvent): TimelineEvent {
  if (!HEAVY.some((k) => k in event.data)) return event;
  const data = { ...event.data };
  for (const k of HEAVY) delete data[k];
  return { ...event, data };
}

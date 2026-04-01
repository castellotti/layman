import type { TimelineEvent, EventType } from '../events/types.js';

export interface SessionTimeMetrics {
  wallClockMs: number;
  agentActiveMs: number;
  userActiveMs: number;
  idleMs: number;
  idleThresholdMinutes: number;
}

// Event types that indicate agent is working
const AGENT_ACTIVE_TYPES: Set<EventType> = new Set([
  'tool_call_pending',
  'tool_call_approved',
  'tool_call_completed',
  'tool_call_failed',
  'tool_call_delegated',
  'agent_response',
  'agent_stop',
  'subagent_start',
  'subagent_stop',
  'pre_compact',
  'post_compact',
  'permission_request',
  'notification',
  'session_start',
  'analysis_result',
]);

// Event types that indicate user action
const USER_ACTION_TYPES: Set<EventType> = new Set([
  'user_prompt',
  'tool_call_approved',
  'tool_call_denied',
  'elicitation_result',
]);

/**
 * Compute time metrics for a session from its sorted events.
 *
 * Classification logic:
 * - Tool calls with completedAt: duration is agent time (completedAt - timestamp)
 * - Gaps between consecutive agent events (under threshold): agent time
 * - Gaps ending with a user action (under threshold): user time
 * - Gaps >= idle threshold: idle time
 */
export function computeTimeMetrics(
  events: TimelineEvent[],
  idleThresholdMinutes: number,
): SessionTimeMetrics {
  if (events.length === 0) {
    return { wallClockMs: 0, agentActiveMs: 0, userActiveMs: 0, idleMs: 0, idleThresholdMinutes };
  }

  if (events.length === 1) {
    return { wallClockMs: 0, agentActiveMs: 0, userActiveMs: 0, idleMs: 0, idleThresholdMinutes };
  }

  const idleThresholdMs = idleThresholdMinutes * 60 * 1000;
  const wallClockMs = events[events.length - 1].timestamp - events[0].timestamp;

  let agentActiveMs = 0;
  let userActiveMs = 0;

  // First pass: account for tool calls with precise completedAt durations
  // Track which time ranges are covered by completedAt so we don't double-count
  const coveredRanges: Array<{ start: number; end: number }> = [];

  for (const event of events) {
    if (event.type === 'tool_call_pending' && event.data.completedAt) {
      const duration = event.data.completedAt - event.timestamp;
      if (duration > 0) {
        agentActiveMs += duration;
        coveredRanges.push({ start: event.timestamp, end: event.data.completedAt });
      }
    }
  }

  // Second pass: classify gaps between consecutive events
  for (let i = 0; i < events.length - 1; i++) {
    const current = events[i];
    const next = events[i + 1];

    // Determine the effective "end" of the current event
    // If it's a tool_call_pending with completedAt, the gap starts from completedAt
    let gapStart = current.timestamp;
    if (current.type === 'tool_call_pending' && current.data.completedAt) {
      gapStart = current.data.completedAt;
    }

    const gapEnd = next.timestamp;
    const gap = gapEnd - gapStart;

    if (gap <= 0) continue;

    // Check if this gap is already covered by a completedAt range
    if (isFullyCovered(gapStart, gapEnd, coveredRanges)) continue;

    // Classify the gap
    if (gap >= idleThresholdMs) {
      // Long gap = idle (regardless of what follows)
      // Exception: if the gap is between two rapid agent events, it's still idle
      // The user walked away or the session was paused
      continue; // idle time is the residual
    }

    // Short gap — classify based on what comes next
    if (USER_ACTION_TYPES.has(next.type)) {
      userActiveMs += gap;
    } else if (AGENT_ACTIVE_TYPES.has(next.type)) {
      agentActiveMs += gap;
    } else {
      // Elicitation or unknown — attribute to agent (waiting for user input)
      agentActiveMs += gap;
    }
  }

  // Idle is the residual
  const idleMs = Math.max(0, wallClockMs - agentActiveMs - userActiveMs);

  return {
    wallClockMs,
    agentActiveMs,
    userActiveMs,
    idleMs,
    idleThresholdMinutes,
  };
}

/** Check if a time range is fully within any of the covered ranges */
function isFullyCovered(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  for (const range of ranges) {
    if (start >= range.start && end <= range.end) return true;
  }
  return false;
}

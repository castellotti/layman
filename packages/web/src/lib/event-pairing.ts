import type { TimelineEvent } from './types.js';

/**
 * Returns the ids that should be expanded together when a Logs row is
 * selected (§1.4 select-to-focus):
 * - selecting a `user_prompt` expands the prompt + the *final* `agent_response`
 *   in that prompt's exchange (the last response before the next prompt).
 * - selecting an `agent_response` expands that response + its *originating*
 *   prompt (the closest preceding `user_prompt`).
 * - any other kind expands alone.
 * A prompt "owns" every event up to (but not including) the next prompt.
 */
export function pairFor(eventId: string, events: TimelineEvent[]): string[] {
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx === -1) return [eventId];
  const event = events[idx];

  if (event.type === 'user_prompt') {
    let exchangeEnd = events.length;
    for (let i = idx + 1; i < events.length; i++) {
      if (events[i].type === 'user_prompt') {
        exchangeEnd = i;
        break;
      }
    }
    for (let i = exchangeEnd - 1; i > idx; i--) {
      if (events[i].type === 'agent_response') return [event.id, events[i].id];
    }
    return [event.id];
  }

  if (event.type === 'agent_response') {
    for (let i = idx - 1; i >= 0; i--) {
      if (events[i].type === 'user_prompt') return [events[i].id, event.id];
    }
    return [event.id];
  }

  return [event.id];
}

/** Whether a Logs row has an expandable detail card at all. */
export function hasLogDetail(event: TimelineEvent): boolean {
  if (event.data.prompt) return true;
  if (event.data.toolInput || event.data.toolOutput !== undefined) return true;
  if (event.data.error) return true;
  if (event.type === 'agent_response' || event.type === 'stop_failure') return true;
  if (event.type === 'permission_request' || event.type === 'tool_call_pending') return true;
  if (event.type === 'drift_check' || event.type === 'drift_alert') return true;
  if (event.type === 'web_search') return true;
  if (event.type === 'subagent_stop' && event.data.subagentTranscript?.length) return true;
  return false;
}

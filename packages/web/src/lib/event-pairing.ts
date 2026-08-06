import type { TimelineEvent } from './types.js';
import { extractTurns } from './turns.js';

/**
 * Returns the ids that should be expanded together when a Logs row is
 * selected (§1.4 select-to-focus):
 * - selecting a `user_prompt` expands the prompt + the *final* `agent_response`
 *   in that prompt's exchange (the last response before the next prompt).
 * - selecting an `agent_response` expands that response + its *originating*
 *   prompt (the closest preceding `user_prompt`).
 * - any other kind expands alone.
 *
 * Delegates to the shared turn rule (`turns.ts`) rather than reimplementing the
 * ownership semantics, so the UI and the export/API paths cannot diverge.
 */
export function pairFor(eventId: string, events: TimelineEvent[]): string[] {
  const event = events.find((e) => e.id === eventId);
  if (!event) return [eventId];
  if (event.type !== 'user_prompt' && event.type !== 'agent_response') return [event.id];

  // Matching on eventIds rather than promptEventId also covers a collapsed
  // duplicate prompt (see turns.ts), which is owned by a turn it does not name.
  const turn = extractTurns(events).find((t) => t.eventIds.includes(event.id));
  if (!turn) return [event.id];

  if (event.type === 'user_prompt') {
    return turn.responseEventId ? [turn.promptEventId, turn.responseEventId] : [turn.promptEventId];
  }

  // An agent_response pairs with its originating prompt — including interstitial
  // responses, which are not the turn's final response.
  return [turn.promptEventId, event.id];
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

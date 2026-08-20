/**
 * The authoritative turn-extraction rule (client copy).
 *
 * A turn starts at a `user_prompt` and owns every subsequent event up to — but
 * not including — the next `user_prompt`.  Its response is the *last*
 * `agent_response` inside that window: an agent typically emits several
 * interstitial messages between tool calls, and the final one is the answer.
 *
 * Events preceding the first `user_prompt` (session preamble) belong to no turn.
 *
 * Mirrors packages/server/src/turns/extract.ts — see CLAUDE.md "Type duplication".
 */
import type { TimelineEvent, Turn } from './types.js';
import { getEffectiveAgentContent } from './reasoning.js';

/**
 * A tool call is a single event whose `type` mutates in place as it progresses,
 * so counting events with these types counts calls, not lifecycle transitions.
 */
const TOOL_CALL_TYPES: ReadonlySet<string> = new Set([
  'tool_call_pending',
  'tool_call_approved',
  'tool_call_denied',
  'tool_call_delegated',
  'tool_call_completed',
  'tool_call_failed',
]);

/**
 * Two identical prompts this close together are one prompt recorded twice — the
 * fixed hook double-registration bug, whose rows are still in recorded history.
 * See packages/server/src/turns/extract.ts for the measured distribution that
 * fixes this window; the two copies must agree or client and server disagree
 * about how many turns a session has.
 */
const DUPLICATE_PROMPT_WINDOW_MS = 1000;

function isDuplicatePrompt(candidate: TimelineEvent, openPrompt: TimelineEvent): boolean {
  return (
    candidate.timestamp - openPrompt.timestamp < DUPLICATE_PROMPT_WINDOW_MS &&
    (candidate.data.prompt ?? '').trim() === (openPrompt.data.prompt ?? '').trim()
  );
}

function sortStable(events: TimelineEvent[]): TimelineEvent[] {
  return events
    .map((event, position) => ({ event, position }))
    .sort((a, b) => a.event.timestamp - b.event.timestamp || a.position - b.position)
    .map(({ event }) => event);
}

function buildTurn(owned: TimelineEvent[], index: number): Turn {
  const prompt = owned[0];

  let responseEvent: TimelineEvent | null = null;
  for (let i = owned.length - 1; i > 0; i--) {
    if (owned[i].type === 'agent_response') {
      responseEvent = owned[i];
      break;
    }
  }

  const riskLevels: Record<string, number> = {};
  let toolCallCount = 0;
  for (const event of owned) {
    if (TOOL_CALL_TYPES.has(event.type)) toolCallCount++;
    if (event.riskLevel) riskLevels[event.riskLevel] = (riskLevels[event.riskLevel] ?? 0) + 1;
  }

  const content = responseEvent
    ? getEffectiveAgentContent(responseEvent)
    : { thinking: null, response: '' };

  return {
    sessionId: prompt.sessionId,
    promptEventId: prompt.id,
    responseEventId: responseEvent?.id ?? null,
    index,
    promptText: prompt.data.prompt ?? '',
    responseText: content.response,
    thinkingText: content.thinking,
    startedAt: prompt.timestamp,
    endedAt: owned.length > 0 ? owned[owned.length - 1].timestamp : null,
    eventIds: owned.map((e) => e.id),
    toolCallCount,
    riskLevels,
    agentType: prompt.agentType,
  };
}

/** Every turn in a session, in order. */
export function extractTurns(events: TimelineEvent[]): Turn[] {
  const ordered = sortStable(events);
  const turns: Turn[] = [];

  let owned: TimelineEvent[] | null = null;
  for (const event of ordered) {
    if (event.type === 'user_prompt') {
      // A re-recorded duplicate joins the open turn instead of starting one.
      if (owned && isDuplicatePrompt(event, owned[0])) {
        owned.push(event);
        continue;
      }
      if (owned) turns.push(buildTurn(owned, turns.length));
      owned = [event];
      continue;
    }
    if (owned) owned.push(event);
  }
  if (owned) turns.push(buildTurn(owned, turns.length));

  return turns;
}

/** A single turn, addressed by its prompt event id. */
export function extractTurn(events: TimelineEvent[], promptEventId: string): Turn | null {
  const turns = extractTurns(events);
  const exact = turns.find((t) => t.promptEventId === promptEventId);
  if (exact) return exact;

  // A collapsed duplicate is no longer any turn's promptEventId, but URLs minted
  // before the collapse still name it — resolve those to the turn that absorbed it.
  const isPrompt = events.some((e) => e.id === promptEventId && e.type === 'user_prompt');
  if (!isPrompt) return null;
  return turns.find((t) => t.eventIds.includes(promptEventId)) ?? null;
}

/** The turn that owns an arbitrary event, so any event id can be addressed as a turn. */
export function turnForEvent(events: TimelineEvent[], eventId: string): Turn | null {
  return extractTurns(events).find((t) => t.eventIds.includes(eventId)) ?? null;
}

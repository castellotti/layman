/**
 * The authoritative turn-extraction rule.
 *
 * A turn starts at a `user_prompt` and owns every subsequent event up to — but
 * not including — the next `user_prompt`.  Its response is the *last*
 * `agent_response` inside that window: an agent typically emits several
 * interstitial messages between tool calls, and the final one is the answer.
 *
 * Events preceding the first `user_prompt` (session preamble) belong to no turn.
 *
 * Mirrors packages/web/src/lib/event-pairing.ts (`pairFor`).
 */
import type { TimelineEvent, EventType } from '../events/types.js';
import { getEffectiveAgentContent } from '../events/agent-content.js';
import type { Turn } from './types.js';

/**
 * A tool call is a single event whose `type` mutates in place as it progresses
 * (`EventStore.updateType`), so counting events with these types counts calls,
 * not lifecycle transitions.
 */
export const TOOL_CALL_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'tool_call_pending',
  'tool_call_approved',
  'tool_call_denied',
  'tool_call_delegated',
  'tool_call_completed',
  'tool_call_failed',
]);

/**
 * Two identical prompts this close together are one prompt recorded twice.
 *
 * The fixed hook double-registration bug (see CLAUDE.md "Hook identity is
 * structural, not tagged") POSTed every `UserPromptSubmit` twice, and those rows
 * are still in recorded history: on this machine 741 same-text pairs landed
 * <100 ms apart and 794 within 1 s, while genuine re-sends of the same text are
 * 1 s or more apart (20 between 1 s and 1 min, 34 beyond). The window therefore
 * sits an order of magnitude above the artifact and an order of magnitude below
 * anything a human produced.
 *
 * Collapsing here rather than rewriting the rows keeps history intact and fixes
 * every consumer at once — otherwise each duplicate opens a phantom turn that
 * owns the *previous* turn's trailing `agent_response` (the Stop hook races the
 * next prompt), which mis-pairs exports, TTS and the transcript alike.
 */
const DUPLICATE_PROMPT_WINDOW_MS = 1000;

function isDuplicatePrompt(candidate: TimelineEvent, openPrompt: TimelineEvent): boolean {
  return (
    candidate.timestamp - openPrompt.timestamp < DUPLICATE_PROMPT_WINDOW_MS &&
    (candidate.data.prompt ?? '').trim() === (openPrompt.data.prompt ?? '').trim()
  );
}

/**
 * Orders events by timestamp, preserving the original relative order of events
 * sharing a timestamp (hooks fire in bursts and can collide on the millisecond).
 */
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
      // A re-recorded duplicate joins the open turn instead of starting one. The
      // turn keeps the first copy's id as its address; the duplicate stays in
      // `eventIds`, so a link written against it still resolves (extractTurn).
      if (owned && isDuplicatePrompt(event, owned[0])) {
        owned.push(event);
        continue;
      }
      if (owned) turns.push(buildTurn(owned, turns.length));
      owned = [event];
      continue;
    }
    // Events before the first user_prompt belong to no turn.
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

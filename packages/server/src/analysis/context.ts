/**
 * What an investigation (analyze, laymans, ask) tells the model about an event and
 * its session. Pure: the caller hands in the session's events.
 *
 * Priority, highest first:
 *   1. the investigated event itself, verbatim (`eventSubject`);
 *   2. the events immediately before it (`recentEvents`), so a tool call is read
 *      in the light of what led to it;
 *   3. the session's user prompts and agent responses up to it (`conversation`),
 *      newest first within a budget, so even an arbitrary tool call knows what
 *      the user asked for;
 *   4. a rolling summary of everything older than the recent window (`older`,
 *      summarised by the caller).
 *
 * Events *after* the investigated one are left out: the question is why the agent
 * did this, and what came later was not known to it yet.
 */
import type { TimelineEvent } from '../events/types.js';
import { getEffectiveAgentContent } from '../events/agent-content.js';

export const RECENT_EVENTS_WINDOW = 20;
/** Characters of conversation sent in all; the newest prompts and responses win. */
export const CONVERSATION_BUDGET = 12_000;
const CONVERSATION_ITEM_MAX = 1_500;
const SUBJECT_TEXT_MAX = 8_000;
/** A recent event's summary when its text is in the conversation already. */
export const IN_CONVERSATION = '(text in the conversation below)';

export interface ContextEvent { type: string; summary: string }
export interface ConversationItem { type: 'user_prompt' | 'agent_response'; text: string }

export interface EventSubject {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: unknown;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function eventText(e: TimelineEvent): string {
  if (e.type === 'agent_response') return getEffectiveAgentContent(e).response;
  return (e.data.prompt as string | undefined) ?? '';
}

/**
 * The event as the model's subject. A tool call is its tool, input and output. A
 * prompt, response or anything else without a tool is named by its type and carries
 * its text: without it the model was asked about `Unknown` with `{}`, and since the
 * analysis cache keys on exactly those two, every response got the first one's answer.
 */
export function eventSubject(e: TimelineEvent): EventSubject {
  if (e.data.toolName) {
    return { toolName: e.data.toolName, toolInput: e.data.toolInput ?? {}, toolOutput: e.data.toolOutput };
  }
  const text = eventText(e);
  return {
    toolName: e.type,
    toolInput: text ? { text: clip(text, SUBJECT_TEXT_MAX) } : {},
    ...(e.data.error ? { toolOutput: { error: e.data.error } } : {}),
  };
}

export function summarizeEventForContext(e: TimelineEvent): ContextEvent {
  if (e.data.toolName) {
    return { type: e.type, summary: `${e.data.toolName}: ${JSON.stringify(e.data.toolInput ?? {}).slice(0, 160)}` };
  }
  const text = eventText(e);
  // Prompts and responses get more room than a tool line: they say what the work is for.
  const max = e.type === 'user_prompt' || e.type === 'agent_response' ? 400 : 160;
  return { type: e.type, summary: text ? clip(text, max) : e.type };
}

export interface AssembledContext {
  recentEvents: ContextEvent[];
  conversation: ConversationItem[];
  /** Events older than the recent window, for the caller's rolling summary. */
  older: TimelineEvent[];
}

/**
 * Splits a session's events around the investigated one. An id not found in the list
 * (an event read from history while the session's live events are elsewhere) is
 * treated as the latest, so the context is the session's tail, as it always was.
 */
export function assembleContext(events: TimelineEvent[], eventId: string): AssembledContext {
  const idx = events.findIndex((e) => e.id === eventId);
  const before = idx >= 0 ? events.slice(0, idx) : events.filter((e) => e.id !== eventId);
  const recent = before.slice(-RECENT_EVENTS_WINDOW);
  const older = before.slice(0, -RECENT_EVENTS_WINDOW);

  // Newest first until the budget runs out, then back into reading order.
  const conversation: ConversationItem[] = [];
  const inConversation = new Set<string>();
  let used = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const e = before[i];
    if (e.type !== 'user_prompt' && e.type !== 'agent_response') continue;
    const text = eventText(e).trim();
    if (!text) continue;
    const room = CONVERSATION_BUDGET - used;
    if (room < 80) break;
    const item = clip(text, Math.min(CONVERSATION_ITEM_MAX, room));
    used += item.length;
    conversation.push({ type: e.type, text: item });
    inConversation.add(e.id);
  }
  conversation.reverse();

  // A prompt or response the conversation carries is only marked in the recent events, so
  // its text is not sent twice.
  const recentEvents = recent.map((e) => (inConversation.has(e.id)
    ? { type: e.type, summary: IN_CONVERSATION }
    : summarizeEventForContext(e)));
  return { recentEvents, conversation, older };
}

/** The conversation as prompt lines, oldest first; empty when there is none. */
export function formatConversation(conversation: ConversationItem[] | undefined): string[] {
  if (!conversation || conversation.length === 0) return [];
  const lines = ['Conversation so far (user prompts and agent responses, oldest first):'];
  for (const c of conversation) {
    const who = c.type === 'user_prompt' ? 'User' : 'Agent';
    lines.push(`  [${who}] ${c.text.replace(/\n/g, '\n    ')}`);
  }
  return lines;
}

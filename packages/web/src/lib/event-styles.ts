import type { TimelineEvent } from './types.js';
import { toolPathWithRange } from './tool-input.js';
import { getEffectiveAgentContent } from './reasoning.js';
import type { Token } from './tokens.js';

/**
 * The colour tables below hold token names, never colours: a token is drawn as `tokenColor(t)`
 * (`var(--t)`), so every table follows the theme, and a canvas resolves it with `readToken(t)`.
 */

/** Kind colour for Dashboard tail rows, Logs single-line rows and Minimap ticks (shared vocabulary). */
export const EVENT_KIND_COLOR: Record<string, Token> = {
  tool_call_pending:   'warn',
  tool_call_approved:  'ok',
  tool_call_denied:    'error',
  tool_call_completed: 'ok',
  tool_call_failed:    'error',
  permission_request:  'warn',
  user_prompt:         'info',
  agent_response:      'ok',
  agent_thinking:      'thinking',
  subagent_start:      'agent',
  subagent_stop:       'agent',
  session_start:       'ok',
  session_end:         'text-faint',
  stop_failure:        'error',
};

const KIND_LABELS: Record<string, string> = {
  tool_call_pending:   'pending',
  tool_call_approved:  'approved',
  tool_call_denied:    'denied',
  tool_call_completed: 'completed',
  tool_call_failed:    'failed',
  permission_request:  'permission',
  user_prompt:         'prompt',
  agent_response:      'response',
  agent_thinking:      'thinking',
  subagent_start:      'agent↓',
  subagent_stop:       'agent↑',
  session_start:       'start',
  session_end:         'end',
  agent_stop:          'stop',
  stop_failure:        'stop-fail',
  pre_compact:         'compact',
  post_compact:        'compacted',
  model_change:        'model',
};

export function kindLabel(type: string): string {
  return KIND_LABELS[type] ?? type.replace(/_/g, ' ');
}

/**
 * Full one-line summary for an event row. Never truncates with '…' — CSS
 * text-overflow:ellipsis handles narrow panels so the raw string stays measurable
 * (canvas measureText) and copyable in full.
 */
export function eventDetail(event: TimelineEvent): string {
  if (event.data.toolName) {
    const input = event.data.toolInput as Record<string, unknown> | undefined;
    if (input?.command) return `${event.data.toolName} — ${String(input.command)}`;
    // Path plus line window, so a windowed read reads `Read — …/foo.js:320-419`
    // rather than losing the range that says which part of the file was looked at.
    const path = toolPathWithRange(input, event.data.toolName);
    if (path) return `${event.data.toolName} — ${path}`;
    if (typeof input?.pattern === 'string') return `${event.data.toolName} — ${input.pattern}`;
    return event.data.toolName;
  }
  if (event.data.prompt) return String(event.data.prompt);
  return '';
}

/**
 * What an expanded row's first line says. A tool call: its name, plus the file for a file edit
 * (the flat diff has no title bar of its own). The body shows the rest (the command, the prompt),
 * so the line never repeats it. An event with no tool has none: its body is the prompt or prose.
 */
export function eventHeading(event: TimelineEvent): string {
  const { toolName, toolInput } = event.data;
  if (!toolName) return '';
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const path = toolPathWithRange(toolInput as Record<string, unknown> | undefined, toolName);
    if (path) return `${toolName} — ${path}`;
  }
  return toolName;
}

/**
 * Suffix marking a derived thinking row's id, so expand/collapse state for the
 * two rows never collides.
 *
 * Carried only by a row that renders *beside* its response. A reasoning-only
 * message has no second row to collide with, and `withThinkingRows` gives that
 * row the real event id instead — so the suffix is a marker of "there is also a
 * response row", not of "this row is derived". Use `isThinkingRow()`, which
 * tests the type, for the latter.
 */
export const THINKING_ROW_SUFFIX = '#thinking';

/**
 * The thinking row derived from an `agent_response`, or null when it carried no
 * reasoning.
 *
 * Reasoning used to render as a collapsed block *inside* the response card,
 * which buried it: the response row said "response" and you had to open it and
 * then open a second disclosure to find what the model had actually been
 * weighing. As its own row it sits alongside `prompt`, `response` and
 * `completed` at the same level, which is how it reads in the agent's own console.
 *
 * Derived rather than emitted by the server so it applies to every session
 * already recorded — including Claude Code's, whose reasoning is parsed out of
 * the response text by `getEffectiveAgentContent()` rather than delivered
 * pre-split the way pi delivers it.
 */
export function thinkingRowFor(
  event: TimelineEvent,
  thinking: string | null,
): TimelineEvent | null {
  if (event.type !== 'agent_response' || !thinking?.trim()) return null;
  return {
    ...event,
    id: `${event.id}${THINKING_ROW_SUFFIX}`,
    type: 'agent_thinking',
    // The reasoning goes in `prompt` because that is the field every detail
    // renderer already reads; `data.thinking` stays as it was so nothing that
    // inspects the original event changes meaning.
    data: { ...event.data, prompt: thinking, thinking: undefined },
    // Reasoning is not itself a risky action; carrying the response's risk
    // level over would double-count it in any per-row risk display.
    riskLevel: undefined,
    analysis: undefined,
    laymans: undefined,
  };
}

/**
 * The real event id behind a row id, stripping the derived-thinking suffix.
 *
 * Anything that looks an id up against the *real* event list — turn ownership,
 * row numbering, "open this in Logs" — has to go through this, or a thinking
 * row silently misses: no turn, `#0` for its number, a dead link.
 */
export function baseEventId(rowId: string): string {
  return rowId.endsWith(THINKING_ROW_SUFFIX)
    ? rowId.slice(0, -THINKING_ROW_SUFFIX.length)
    : rowId;
}

/** True for a row derived by `thinkingRowFor`, not a real recorded event. */
export function isThinkingRow(event: TimelineEvent): boolean {
  return event.type === 'agent_thinking';
}

/**
 * A display list with each response's reasoning lifted out into its own row
 * immediately before it.
 *
 * Every surface that renders rows *and* indexes into them — the Logs list and
 * its keyboard cursor, the minimap, the dashboard tail — must derive from the
 * same list. Rendering the extra row without adding it here is what desynced
 * keyboard navigation: `goToIndex` scrolls to `querySelectorAll('[data-event-card]')[n]`,
 * which counts rendered rows, so every thinking row above the cursor shifted
 * the target by one.
 */
export function withThinkingRows(events: TimelineEvent[]): TimelineEvent[] {
  // Cheap bail-out: sessions from harnesses that report no reasoning (and every
  // list with no responses in it) skip the allocation entirely.
  if (!events.some((e) => e.type === 'agent_response')) return events;

  const out: TimelineEvent[] = [];
  for (const event of events) {
    const { thinking, response } = getEffectiveAgentContent(event);
    const row = thinkingRowFor(event, thinking);
    // A message that is *only* reasoning — which is every tool-calling step of
    // a reasoning model, since pi records those for their reasoning alone —
    // would otherwise render its reasoning row followed by an empty RESPONSE
    // row. The reasoning row is the whole message, so it takes over the real
    // event id and everything that resolves a row by id (scroll-to, expansion,
    // row numbering, pairing) keeps working with no special case.
    if (row && !response.trim()) {
      row.id = event.id;
      out.push(row);
      continue;
    }
    if (row) out.push(row);
    out.push(event);
  }
  return out;
}

/** Drift level colour; yellow and orange are the rules-violation severities' minor and major. */
export const DRIFT_COLORS: Record<string, Token> = {
  green: 'ok',
  yellow: 'severity-minor',
  orange: 'severity-major',
  red: 'error',
};


/** Flowchart node border colour by event type; see `NODE_BORDER_FADED`. */
export const NODE_BORDER_COLORS: Record<string, Token> = {
  tool_call_pending: 'warn',
  tool_call_approved: 'ok',
  tool_call_denied: 'error',
  tool_call_delegated: 'text-muted',
  tool_call_completed: 'ok',
  tool_call_failed: 'error',
  permission_request: 'warn',
  user_prompt: 'info',
  agent_response: 'ok',
  agent_stop: 'border-strong',
  session_start: 'ok',
  session_end: 'border-strong',
  notification: 'info',
  subagent_start: 'info',
  subagent_stop: 'text-muted',
  stop_failure: 'error',
  pre_compact: 'text-muted',
  post_compact: 'text-muted',
  model_change: 'info',
  elicitation: 'info',
  elicitation_result: 'info',
  analysis_result: 'text-muted',
  drift_check: 'warn',
  drift_alert: 'error',
  web_search: 'code',
};

/** Routine kinds whose border is drawn at half strength, so approvals and starts stand out. */
export const NODE_BORDER_FADED: ReadonlySet<string> = new Set(['tool_call_completed', 'agent_response']);

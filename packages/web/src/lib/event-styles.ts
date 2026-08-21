import type { TimelineEvent } from './types.js';
import { toolPathWithRange } from './tool-input.js';

/** Kind color for Dashboard tail rows and Logs single-line rows (shared vocabulary). */
export const EVENT_KIND_COLOR: Record<string, string> = {
  tool_call_pending:   'var(--warn)',
  tool_call_approved:  'var(--ok)',
  tool_call_denied:    'var(--error)',
  tool_call_completed: 'var(--ok)',
  tool_call_failed:    'var(--error)',
  permission_request:  'var(--warn)',
  user_prompt:         'var(--info)',
  agent_response:      'var(--ok)',
  agent_thinking:      '#8957e5',
  subagent_start:      'var(--agent)',
  subagent_stop:       'var(--agent)',
  session_start:       'var(--ok)',
  session_end:         'var(--text-faint)',
  stop_failure:        'var(--error)',
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
    const path = toolPathWithRange(input);
    if (path) return `${event.data.toolName} — ${path}`;
    if (typeof input?.pattern === 'string') return `${event.data.toolName} — ${input.pattern}`;
    return event.data.toolName;
  }
  if (event.data.prompt) return String(event.data.prompt);
  return '';
}

/**
 * Suffix marking a derived thinking row's id. Distinct from any real event id,
 * so expand/collapse state for the two rows never collides.
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

export const DRIFT_COLORS: Record<string, string> = {
  green: '#00e676',
  yellow: '#ffb300',
  orange: '#ff9100',
  red: '#ff3d57',
};

export const EVENT_ICONS: Record<string, string> = {
  tool_call_pending: '⚡',
  tool_call_approved: '✅',
  tool_call_denied: '❌',
  tool_call_delegated: '⏭',
  tool_call_completed: '✓',
  tool_call_failed: '✗',
  permission_request: '🔐',
  user_prompt: '💬',
  agent_response: '🤖',
  agent_thinking: '💭',
  agent_stop: '—',
  session_start: '🟢',
  session_end: '⬜',
  notification: '🔔',
  subagent_start: '🔀',
  subagent_stop: '🔀',
  stop_failure: '⚠',
  pre_compact: '📦',
  post_compact: '📦',
  elicitation: '📋',
  elicitation_result: '📋',
  analysis_result: '🔍',
  drift_check: '📐',
  drift_alert: '🚨',
  web_search: '🔎',
};


/** Raw hex colors for flowchart node borders (same palette as BORDER_COLORS but as hex values) */
export const NODE_BORDER_COLORS: Record<string, string> = {
  tool_call_pending: '#d29922',
  tool_call_approved: '#3fb950',
  tool_call_denied: '#f85149',
  tool_call_delegated: '#8b949e',
  tool_call_completed: '#3fb95080',
  tool_call_failed: '#f85149',
  permission_request: '#d29922',
  user_prompt: '#58a6ff',
  agent_response: '#3fb95080',
  agent_stop: '#30363d',
  session_start: '#3fb950',
  session_end: '#30363d',
  notification: '#58a6ff',
  subagent_start: '#58a6ff',
  subagent_stop: '#8b949e',
  stop_failure: '#f85149',
  pre_compact: '#8b949e',
  post_compact: '#8b949e',
  elicitation: '#58a6ff',
  elicitation_result: '#58a6ff',
  analysis_result: '#8b949e',
  drift_check: '#d29922',
  drift_alert: '#f85149',
  web_search: '#79c0ff',
};

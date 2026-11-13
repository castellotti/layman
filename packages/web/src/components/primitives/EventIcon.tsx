/**
 * Layman's own line icons for event types: stroke only, drawn on a 16 × 16 grid, in the current
 * text colour at the theme's stroke weight. They replace the emoji, which ignored the theme.
 */

const GLYPHS = {
  bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  check: 'M3 8.5 6.5 12 13 4.5',
  cross: 'M4 4l8 8M12 4l-8 8',
  approved: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM5.5 8.2 7.3 10 10.7 6',
  ban: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4',
  skip: 'M3 4l5 4-5 4zM9 4l5 4-5 4z',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  prompt: 'M2.5 3.5h11v7h-6l-3 3v-3h-2z',
  agent: 'M3.5 5.5h9v7h-9zM8 5.5v-3M6 9h.01M10 9h.01',
  thought: 'M4 11a3 3 0 0 1 0-6 3.5 3.5 0 0 1 7 0 3 3 0 0 1 1 6zM4 13.5h.01M2.5 15h.01',
  stop: 'M3 8h10',
  start: 'M8 2.5v6M4.5 5a5 5 0 1 0 7 0',
  end: 'M3.5 3.5h9v9h-9z',
  bell: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3',
  fork: 'M8 14V8M8 8 4 3M8 8l4-5',
  warn: 'M8 2 14.5 13.5h-13zM8 6.5v3.5M8 12h.01',
  box: 'M2.5 5 8 2.5 13.5 5v6L8 13.5 2.5 11zM2.5 5 8 7.5 13.5 5M8 7.5v6',
  form: 'M4 2.5h8v11H4zM6 6h4M6 9h4',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.5 10.5l3.5 3.5',
  drift: 'M2.5 12.5 8 3.5l5.5 9zM8 8v2',
  alarm: 'M8 13.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM8 7v3l2 1M3 3.5 5 2M13 3.5 11 2',
  dot: 'M8 8h.01',
} as const;

type Glyph = keyof typeof GLYPHS;

export const EVENT_GLYPH: Record<string, Glyph> = {
  tool_call_pending: 'bolt',
  tool_call_approved: 'approved',
  tool_call_denied: 'ban',
  tool_call_delegated: 'skip',
  tool_call_completed: 'check',
  tool_call_failed: 'cross',
  permission_request: 'lock',
  user_prompt: 'prompt',
  agent_response: 'agent',
  agent_thinking: 'thought',
  agent_stop: 'stop',
  session_start: 'start',
  session_end: 'end',
  notification: 'bell',
  subagent_start: 'fork',
  subagent_stop: 'fork',
  stop_failure: 'warn',
  pre_compact: 'box',
  post_compact: 'box',
  elicitation: 'form',
  elicitation_result: 'form',
  analysis_result: 'search',
  drift_check: 'drift',
  drift_alert: 'alarm',
  web_search: 'search',
};

/** The line icon for an event type; an unknown type gets a dot. */
export function EventIcon({ type, size = 13 }: { type: string; size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, strokeWidth: 'calc(var(--stroke) * 1.2)' }}>
      <path d={GLYPHS[EVENT_GLYPH[type] ?? 'dot']} />
    </svg>
  );
}

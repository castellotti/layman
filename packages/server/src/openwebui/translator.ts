/**
 * Translates Open WebUI filter hook payloads into Layman's internal event types.
 *
 * Open WebUI calls the Layman filter function's inlet/outlet hooks and this handler
 * forwards the data here. The chat_id serves as the session identifier since Open WebUI
 * conversations map naturally to sessions.
 */

import type { UserPromptSubmitInput, SessionStartInput } from '../hooks/types.js';

const AGENT_TYPE = 'open-webui';

// ── Open WebUI hook input shape ──

export interface OpenWebUIHookInput {
  event: 'UserPromptSubmit' | 'AgentResponse';
  chat_id: string;
  user_id?: string;
  user_name?: string;
  /** User message text (UserPromptSubmit) */
  prompt?: string;
  /** Assistant response text (AgentResponse) */
  response?: string;
  model?: string;
}

// ── Common base fields ──

function baseFields(input: OpenWebUIHookInput) {
  return {
    session_id: input.chat_id,
    cwd: '',
    transcript_path: '',
    permission_mode: 'default' as const,
    agent_type: AGENT_TYPE,
  };
}

// ── Translators ──

export function translateUserPromptSubmit(input: OpenWebUIHookInput): UserPromptSubmitInput {
  return {
    ...baseFields(input),
    hook_event_name: 'UserPromptSubmit',
    prompt: input.prompt ?? '',
  };
}

export function translateSessionStart(input: OpenWebUIHookInput): SessionStartInput {
  return {
    ...baseFields(input),
    hook_event_name: 'SessionStart',
    source: 'startup',
  };
}

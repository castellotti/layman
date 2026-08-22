// Hook event types matching Claude Code's hook system

export interface HookInputBase {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path: string;
  permission_mode: 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';
  agent_type?: 'claude-code' | 'opencode' | 'codex' | string;
}

export interface PreToolUseInput extends HookInputBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_output: unknown;
}

export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_error: string;
}

export interface PermissionRequestInput extends HookInputBase {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_request_type: 'tool_use' | 'execution_mode';
  permission_suggestions?: Array<{
    type: string;
    tool_name?: string;
    command?: string;
    description?: string;
    [key: string]: unknown;
  }>;
}

export interface NotificationInput extends HookInputBase {
  hook_event_name: 'Notification';
  notification_type: string;
  message?: string;
  title?: string;
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  model?: string;
}

export interface SessionEndInput extends HookInputBase {
  hook_event_name: 'SessionEnd';
}

export interface StopInput extends HookInputBase {
  hook_event_name: 'Stop';
  /** Codex provides the agent's final response text directly on Stop events */
  last_assistant_message?: string | null;
}

export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface SubagentStartInput extends HookInputBase {
  hook_event_name: 'SubagentStart';
  agent_type: string;
  agent_id?: string;
}

export interface SubagentStopInput extends HookInputBase {
  hook_event_name: 'SubagentStop';
  agent_type: string;
  agent_id?: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

export interface AgentResponseInput extends HookInputBase {
  hook_event_name: 'AgentResponse';
  response: string;
  /**
   * Reasoning already separated from the response by the harness.
   *
   * Only pi supplies this: its `AssistantMessage.content` carries thinking as a
   * distinct part type, so there is nothing to infer. When present it is stored
   * as `data.thinking`, which `getEffectiveAgentContent()` prefers over parsing
   * `<thinking>` tags out of the response text.
   */
  thinking?: string;
}

export interface StopFailureInput extends HookInputBase {
  hook_event_name: 'StopFailure';
  error?: 'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';
  error_details?: string;
  last_assistant_message?: string;
}

export interface PreCompactInput extends HookInputBase {
  hook_event_name: 'PreCompact';
  trigger?: 'manual' | 'auto';
  custom_instructions?: string | null;
}

export interface PostCompactInput extends HookInputBase {
  hook_event_name: 'PostCompact';
  trigger?: 'manual' | 'auto';
  compact_summary?: string;
}

export interface ElicitationInput extends HookInputBase {
  hook_event_name: 'Elicitation';
  request_id?: string;
  message?: string;
}

export interface ElicitationResultInput extends HookInputBase {
  hook_event_name: 'ElicitationResult';
  request_id?: string;
  result?: Record<string, unknown>;
  canceled?: boolean;
}

// Phase 3: Previously unregistered hook events

export interface PermissionDeniedInput extends HookInputBase {
  hook_event_name: 'PermissionDenied';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  reason: string;
}

export interface SetupInput extends HookInputBase {
  hook_event_name: 'Setup';
  trigger: 'init' | 'maintenance';
}

export interface ConfigChangeInput extends HookInputBase {
  hook_event_name: 'ConfigChange';
  source: 'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills';
  file_path?: string;
}

export interface InstructionsLoadedInput extends HookInputBase {
  hook_event_name: 'InstructionsLoaded';
  file_path: string;
  memory_type: 'User' | 'Project' | 'Local' | 'Managed';
  load_reason: 'session_start' | 'nested_traversal' | 'path_glob_match' | 'include' | 'compact';
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
}

export interface TaskCreatedInput extends HookInputBase {
  hook_event_name: 'TaskCreated';
  task_id: string;
  task_subject: string;
  task_description?: string;
}

export interface TaskCompletedInput extends HookInputBase {
  hook_event_name: 'TaskCompleted';
  task_id: string;
  task_subject: string;
}

export interface TeammateIdleInput extends HookInputBase {
  hook_event_name: 'TeammateIdle';
  teammate_name: string;
  team_name: string;
}

export interface WorktreeCreateInput extends HookInputBase {
  hook_event_name: 'WorktreeCreate';
  name: string;
}

export interface WorktreeRemoveInput extends HookInputBase {
  hook_event_name: 'WorktreeRemove';
  worktree_path: string;
}

export interface CwdChangedInput extends HookInputBase {
  hook_event_name: 'CwdChanged';
  old_cwd: string;
  new_cwd: string;
}

export interface FileChangedInput extends HookInputBase {
  hook_event_name: 'FileChanged';
  file_path: string;
  event: 'change' | 'add' | 'unlink';
}

// Phase 4: StatusLine input (not a claude-code hook event — synthetic route)

export interface StatusLineInput extends HookInputBase {
  hook_event_name: 'StatusLine';
  session_name?: string;
  model?: { id: string; display_name: string };
  workspace?: { current_dir: string; project_dir: string; added_dirs?: string[] };
  version?: string;
  output_style?: { name: string };
  cost?: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window?: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    current_usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    used_percentage: number;
    remaining_percentage: number;
  };
  exceeds_200k_tokens?: boolean;
  rate_limits?: {
    five_hour?: { used_percentage: number; resets_at: string };
    seven_day?: { used_percentage: number; resets_at: string };
  };
  /**
   * Harness reasoning effort. pi supplies this; claude-code's StatusLine has no
   * equivalent field, which is why it is optional rather than part of `model`.
   */
  thinking_level?: string;
}

/**
 * A chunk of assistant output as it is generated.
 *
 * Not a timeline event: see `stream/live.ts`. Only harnesses with a streaming
 * hook send these — pi's `message_update` and OpenCode's `message.part.updated`.
 */
export interface StreamDeltaInput extends HookInputBase {
  hook_event_name: 'StreamDelta';
  /** Identifies the assistant message; a change resets the accumulator. */
  message_id: string;
  /** Monotonic within a message. Lets the store drop replays and reorderings. */
  seq?: number;
  text_delta?: string;
  thinking_delta?: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  model?: string;
  /** Final chunk for this message — ends the live stream. */
  done?: boolean;
}

export type AnyHookInput =
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | PermissionRequestInput
  | NotificationInput
  | SessionStartInput
  | SessionEndInput
  | StopInput
  | UserPromptSubmitInput
  | SubagentStartInput
  | SubagentStopInput
  | AgentResponseInput
  | StopFailureInput
  | PreCompactInput
  | PostCompactInput
  | ElicitationInput
  | ElicitationResultInput;

// Response types returned to Claude Code
export interface PreToolUseResponse {
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

export interface PermissionResponse {
  hookSpecificOutput?: {
    hookEventName: 'PermissionRequest';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

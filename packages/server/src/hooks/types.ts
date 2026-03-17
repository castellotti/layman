// Hook event types matching Claude Code's hook system

export interface HookInputBase {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  transcript_path: string;
  permission_mode: 'default' | 'plan' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions';
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
}

export interface NotificationInput extends HookInputBase {
  hook_event_name: 'Notification';
  notification_type: 'permission_prompt' | 'idle_prompt' | 'auth_success' | 'elicitation_dialog';
}

export interface SessionStartInput extends HookInputBase {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
}

export interface SessionEndInput extends HookInputBase {
  hook_event_name: 'SessionEnd';
}

export interface StopInput extends HookInputBase {
  hook_event_name: 'Stop';
}

export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface SubagentStartInput extends HookInputBase {
  hook_event_name: 'SubagentStart';
  agent_type: string;
}

export interface SubagentStopInput extends HookInputBase {
  hook_event_name: 'SubagentStop';
  agent_type: string;
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
  | SubagentStopInput;

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

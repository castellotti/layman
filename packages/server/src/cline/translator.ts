/**
 * Translates Cline hook JSON payloads into Layman's internal hook input types.
 *
 * Cline hooks send JSON on stdin with a different schema than Claude Code's HTTP hooks.
 * This module maps Cline's field names, tool names, and event types to Layman's format
 * so the existing event handling pipeline can be reused.
 */

import type {
  PreToolUseInput,
  PostToolUseInput,
  SessionStartInput,
  SessionEndInput,
  UserPromptSubmitInput,
  PreCompactInput,
} from '../hooks/types.js';

const AGENT_TYPE = 'cline';

/** Map Cline tool names to Layman's PascalCase names */
const TOOL_NAME_MAP: Record<string, string> = {
  execute_command: 'Bash',
  read_file: 'Read',
  write_to_file: 'Write',
  replace_in_file: 'Edit',
  apply_patch: 'Edit',
  search_files: 'Grep',
  list_files: 'ListDirectory',
  list_code_definition_names: 'LSP',
  browser_action: 'Browser',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  use_mcp_tool: 'McpTool',
  access_mcp_resource: 'McpResource',
  ask_followup_question: 'AskUser',
  attempt_completion: 'Complete',
  new_task: 'NewTask',
  condense: 'Compact',
  plan_mode_respond: 'PlanRespond',
  act_mode_respond: 'ActRespond',
  focus_chain: 'FocusChain',
  summarize_task: 'Summarize',
  report_bug: 'ReportBug',
  new_rule: 'NewRule',
  generate_explanation: 'Explain',
  use_skill: 'Skill',
  use_subagents: 'Subagents',
  load_mcp_documentation: 'McpDocs',
};

export function mapToolName(clineName: string): string {
  return TOOL_NAME_MAP[clineName] ?? clineName;
}

// ── Cline hook input shapes ──

export interface ClineHookInput {
  clineVersion?: string;
  hookName: string;
  timestamp: string;
  taskId: string;
  workspaceRoots?: string[];
  userId?: string;
  model?: { provider?: string; slug?: string };

  // Hook-specific data (only one present per hook)
  preToolUse?: { toolName: string; parameters: Record<string, string> };
  postToolUse?: {
    toolName: string;
    parameters: Record<string, string>;
    result?: string;
    success?: boolean;
    executionTimeMs?: number;
  };
  taskStart?: { taskMetadata?: { taskId?: string; ulid?: string; initialTask?: string } };
  taskResume?: { taskMetadata?: { taskId?: string; ulid?: string }; previousState?: Record<string, string> };
  taskCancel?: { taskMetadata?: { taskId?: string; ulid?: string; completionStatus?: string } };
  taskComplete?: { taskMetadata?: { taskId?: string; ulid?: string } };
  userPromptSubmit?: { prompt: string; attachments?: string[] };
  preCompact?: {
    taskId?: string;
    ulid?: string;
    contextSize?: number;
    compactionStrategy?: string;
  };
  notification?: {
    event?: string;
    source?: string;
    message?: string;
    waitingForUserInput?: boolean;
  };
}

// ── Cline hook output shape ──

export interface ClineHookOutput {
  cancel?: boolean;
  contextModification?: string;
  errorMessage?: string;
}

// ── Common base fields ──

function baseFields(input: ClineHookInput): {
  session_id: string;
  cwd: string;
  transcript_path: string;
  permission_mode: 'default';
  agent_type: string;
} {
  return {
    session_id: input.taskId,
    cwd: input.workspaceRoots?.[0] ?? '',
    transcript_path: '',
    permission_mode: 'default' as const,
    agent_type: AGENT_TYPE,
  };
}

// ── Translators ──

export function translatePreToolUse(input: ClineHookInput): PreToolUseInput {
  const data = input.preToolUse!;
  return {
    ...baseFields(input),
    hook_event_name: 'PreToolUse',
    tool_name: mapToolName(data.toolName),
    tool_input: data.parameters as Record<string, unknown>,
  };
}

export function translatePostToolUse(input: ClineHookInput): PostToolUseInput {
  const data = input.postToolUse!;
  return {
    ...baseFields(input),
    hook_event_name: 'PostToolUse',
    tool_name: mapToolName(data.toolName),
    tool_input: data.parameters as Record<string, unknown>,
    tool_output: data.result ?? (data.success ? '(success)' : '(failure)'),
  };
}

export function translateTaskStart(input: ClineHookInput): SessionStartInput {
  return {
    ...baseFields(input),
    hook_event_name: 'SessionStart',
    source: 'startup',
  };
}

export function translateTaskResume(input: ClineHookInput): SessionStartInput {
  return {
    ...baseFields(input),
    hook_event_name: 'SessionStart',
    source: 'resume',
  };
}

export function translateTaskEnd(input: ClineHookInput): SessionEndInput {
  return {
    ...baseFields(input),
    hook_event_name: 'SessionEnd',
  };
}

export function translateUserPromptSubmit(input: ClineHookInput): UserPromptSubmitInput {
  const data = input.userPromptSubmit!;
  return {
    ...baseFields(input),
    hook_event_name: 'UserPromptSubmit',
    prompt: data.prompt,
  };
}

export function translatePreCompact(input: ClineHookInput): PreCompactInput {
  return {
    ...baseFields(input),
    hook_event_name: 'PreCompact',
  };
}

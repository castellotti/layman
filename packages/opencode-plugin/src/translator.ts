// Maps OpenCode tool names to Layman's expected names (PascalCase)
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  ls: 'LS',
  lsp: 'LSP',
  apply_patch: 'Edit',
  codesearch: 'Grep',
  batch: 'Batch',
};

function mapToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

function basePayload(sessionId: string, directory: string, hookEventName: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd: directory,
    hook_event_name: hookEventName,
    transcript_path: '',
    permission_mode: 'default',
    agent_type: 'opencode',
  };
}

// tool.execute.before: input = { tool, sessionID, callID }, output = { args }
export function translateToolBefore(
  input: { tool: string; sessionID: string; callID: string },
  output: { args: unknown },
  directory: string
): Record<string, unknown> {
  return {
    ...basePayload(input.sessionID, directory, 'PreToolUse'),
    tool_name: mapToolName(input.tool),
    tool_input: output.args ?? {},
  };
}

// tool.execute.after: input = { tool, sessionID, callID, args }, output = { title, output, metadata }
export function translateToolAfter(
  input: { tool: string; sessionID: string; callID: string; args: unknown },
  output: { title: string; output: string; metadata: unknown },
  directory: string
): Record<string, unknown> {
  return {
    ...basePayload(input.sessionID, directory, 'PostToolUse'),
    tool_name: mapToolName(input.tool),
    tool_input: input.args ?? {},
    tool_output: output.output,
  };
}

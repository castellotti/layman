/**
 * Background work that finishes is reported to Claude Code's model as a
 * `<task-notification>` message, which every hook sees as a `UserPromptSubmit`
 * (593 such "prompts" in one recorded history; the docs do not say so, this is
 * observed). It is the harness talking, not the user: it must not open a turn.
 *
 * Byte-identical in `packages/server/src/events/` and `packages/web/src/lib/`
 * (no imports, so the copies can match); a web test fails when they differ.
 */

export interface TaskNotification {
  taskId: string;
  /** The launching call's `tool_use_id`, when the message carries it (516 of 593). */
  toolUseId?: string;
  status?: string;
}

const MARK = '<task-notification>';

export function isTaskNotification(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && prompt.trimStart().startsWith(MARK);
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>\\s*([^<\\s][^<]*?)\\s*</${name}>`).exec(text);
  return m?.[1];
}

export function parseTaskNotification(prompt: string | undefined): TaskNotification | null {
  if (!isTaskNotification(prompt)) return null;
  const text = prompt as string;
  const taskId = tag(text, 'task-id');
  if (!taskId) return null;
  return { taskId, toolUseId: tag(text, 'tool-use-id'), status: tag(text, 'status') };
}

/**
 * The id of the background task a call started, read from its response (prose,
 * not a contract: `agentId: a238…` for an Agent, `with ID: b0bd…` for a shell).
 * Only a call that asked to run in the background has one.
 */
export function backgroundTaskIdOf(toolInput: unknown, toolOutput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const input = toolInput as Record<string, unknown>;
  if (input.run_in_background !== true && input.background !== true) return undefined;
  const text = typeof toolOutput === 'string' ? toolOutput : toolOutput == null ? '' : JSON.stringify(toolOutput);
  return /agentId:\s*([A-Za-z0-9]+)/.exec(text)?.[1] ?? /(?:with|background) ID:\s*([A-Za-z0-9]+)/i.exec(text)?.[1];
}

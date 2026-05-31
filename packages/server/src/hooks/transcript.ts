import type { SubagentTranscriptEntry } from '../events/types.js';

export const TRANSCRIPT_OUTPUT_LIMIT = 8 * 1024;

/** Parse sidechain JSONL transcript content into an ordered list of tool calls and assistant text. */
export function parseTranscriptLines(content: string): SubagentTranscriptEntry[] {
  const lines = content.trim().split('\n').filter(Boolean);
  const entries: SubagentTranscriptEntry[] = [];

  // toolUseId → entry index so we can attach tool_result output back to the call
  const pendingToolIndexes = new Map<string, number>();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const lineType = obj.type as string | undefined;
    const ts = typeof obj.timestamp === 'string' ? new Date(obj.timestamp).getTime() : undefined;
    const msg = obj.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;

    if (lineType === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content as Record<string, unknown>[] : [];
      const textParts: string[] = [];

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const t = (block.text as string).trim();
          if (t) textParts.push(t);
        } else if (block.type === 'tool_use') {
          // Flush accumulated text before the tool entry so the natural reading
          // order (rationale → tool call) is preserved in the entries list.
          if (textParts.length > 0) {
            let text = textParts.join('\n\n');
            if (text.length > TRANSCRIPT_OUTPUT_LIMIT) text = text.slice(0, TRANSCRIPT_OUTPUT_LIMIT) + '\n…[truncated]';
            entries.push({ role: 'assistant', text, timestamp: ts });
            textParts.length = 0;
          }
          const toolUseId = typeof block.id === 'string' ? block.id : null;
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          const toolInput = (block.input && typeof block.input === 'object')
            ? block.input as Record<string, unknown> : {};
          const entryIdx = entries.length;
          entries.push({ role: 'tool', toolName, toolInput, timestamp: ts });
          if (toolUseId) pendingToolIndexes.set(toolUseId, entryIdx);
        }
      }

      if (textParts.length > 0) {
        let text = textParts.join('\n\n');
        if (text.length > TRANSCRIPT_OUTPUT_LIMIT) text = text.slice(0, TRANSCRIPT_OUTPUT_LIMIT) + '\n…[truncated]';
        entries.push({ role: 'assistant', text, timestamp: ts });
      }

    } else if (lineType === 'user') {
      const msgContent = msg.content;
      if (!Array.isArray(msgContent)) continue;

      for (const block of msgContent as Record<string, unknown>[]) {
        if (block.type !== 'tool_result') continue;
        const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
        if (!toolUseId) continue;
        const idx = pendingToolIndexes.get(toolUseId);
        if (idx == null) continue;

        let toolOutput: unknown = block.content;
        if (Array.isArray(block.content)) {
          toolOutput = (block.content as Array<{ text?: string }>).map(b => b.text ?? '').join('');
        }
        // Cap large outputs (e.g. WebFetch responses) to avoid bloating the event store
        if (typeof toolOutput === 'string' && toolOutput.length > TRANSCRIPT_OUTPUT_LIMIT) {
          toolOutput = toolOutput.slice(0, TRANSCRIPT_OUTPUT_LIMIT) + '\n…[truncated]';
        }
        if (entries[idx]) {
          entries[idx] = { ...entries[idx], toolOutput };
        }
        pendingToolIndexes.delete(toolUseId);
      }
    }
  }

  pendingToolIndexes.clear();
  return entries;
}

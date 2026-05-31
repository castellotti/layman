import { describe, it, expect } from 'vitest';
import { parseTranscriptLines, TRANSCRIPT_OUTPUT_LIMIT } from './transcript.js';

function makeLine(type: string, messageContent: unknown, timestamp = '2024-01-01T00:00:00Z') {
  return JSON.stringify({ type, timestamp, message: { role: type, content: messageContent } });
}

function assistantText(text: string, ts?: string) {
  return makeLine('assistant', [{ type: 'text', text }], ts);
}

function assistantTool(id: string, name: string, input: Record<string, unknown>, ts?: string) {
  return makeLine('assistant', [{ type: 'tool_use', id, name, input }], ts);
}

function toolResult(toolUseId: string, content: string | unknown[]) {
  return makeLine('user', [{ type: 'tool_result', tool_use_id: toolUseId, content }]);
}

describe('parseTranscriptLines', () => {
  it('returns empty array for empty content', () => {
    expect(parseTranscriptLines('')).toEqual([]);
    expect(parseTranscriptLines('   \n  ')).toEqual([]);
  });

  it('skips malformed JSON lines', () => {
    const content = [
      'not json',
      assistantText('hello'),
      '{broken',
    ].join('\n');
    const entries = parseTranscriptLines(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('hello');
  });

  it('parses assistant text entry', () => {
    const entries = parseTranscriptLines(assistantText('Let me check that.'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: 'assistant', text: 'Let me check that.' });
  });

  it('parses tool call and attaches result', () => {
    const content = [
      assistantTool('id-1', 'Bash', { command: 'ls -la' }),
      toolResult('id-1', 'total 0\ndrwxr-xr-x'),
    ].join('\n');
    const entries = parseTranscriptLines(content);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
      toolOutput: 'total 0\ndrwxr-xr-x',
    });
  });

  it('emits text before tool_use to preserve rationale→tool order', () => {
    const content = [
      makeLine('assistant', [
        { type: 'text', text: 'I will read the file.' },
        { type: 'tool_use', id: 'id-1', name: 'Read', input: { file_path: '/foo' } },
      ]),
      toolResult('id-1', 'file contents'),
    ].join('\n');
    const entries = parseTranscriptLines(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: 'assistant', text: 'I will read the file.' });
    expect(entries[1]).toMatchObject({ role: 'tool', toolName: 'Read', toolOutput: 'file contents' });
  });

  it('emits trailing text after last tool call', () => {
    const content = [
      makeLine('assistant', [
        { type: 'tool_use', id: 'id-1', name: 'Bash', input: {} },
        { type: 'text', text: 'Done.' },
      ]),
      toolResult('id-1', 'ok'),
    ].join('\n');
    const entries = parseTranscriptLines(content);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ role: 'tool', toolName: 'Bash' });
    expect(entries[1]).toMatchObject({ role: 'assistant', text: 'Done.' });
  });

  it('leaves toolOutput undefined when tool_result is missing', () => {
    const content = assistantTool('id-no-result', 'Write', { file_path: '/tmp/x' });
    const entries = parseTranscriptLines(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].toolOutput).toBeUndefined();
  });

  it('joins array tool_result content blocks into a string', () => {
    const content = [
      assistantTool('id-1', 'Read', { file_path: '/tmp/f' }),
      toolResult('id-1', [{ text: 'part1' }, { text: 'part2' }]),
    ].join('\n');
    const entries = parseTranscriptLines(content);
    expect(entries[0].toolOutput).toBe('part1part2');
  });

  it('truncates tool output exceeding TRANSCRIPT_OUTPUT_LIMIT', () => {
    const big = 'x'.repeat(TRANSCRIPT_OUTPUT_LIMIT + 100);
    const content = [
      assistantTool('id-1', 'WebFetch', { url: 'https://example.com' }),
      toolResult('id-1', big),
    ].join('\n');
    const entries = parseTranscriptLines(content);
    const out = entries[0].toolOutput as string;
    expect(out.length).toBeLessThanOrEqual(TRANSCRIPT_OUTPUT_LIMIT + 20);
    expect(out.endsWith('\n…[truncated]')).toBe(true);
  });

  it('truncates assistant text exceeding TRANSCRIPT_OUTPUT_LIMIT', () => {
    const big = 'a'.repeat(TRANSCRIPT_OUTPUT_LIMIT + 100);
    const entries = parseTranscriptLines(assistantText(big));
    const text = entries[0].text as string;
    expect(text.endsWith('\n…[truncated]')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(TRANSCRIPT_OUTPUT_LIMIT + 20);
  });

  it('attaches timestamp from JSONL line', () => {
    const ts = '2024-06-15T12:34:56Z';
    const entries = parseTranscriptLines(assistantText('hi', ts));
    expect(entries[0].timestamp).toBe(new Date(ts).getTime());
  });

  it('skips lines without a message field', () => {
    const line = JSON.stringify({ type: 'summary', data: 'something' });
    expect(parseTranscriptLines(line)).toEqual([]);
  });
});

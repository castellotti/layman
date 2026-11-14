import { describe, it, expect } from 'vitest';
import { eventCopyText, toolInputText } from './event-copy.js';
import { eventDetail } from './event-styles.js';
import type { TimelineEvent } from './types.js';

function ev(type: string, data: Record<string, unknown>): TimelineEvent {
  return { id: 'e1', type, timestamp: 0, sessionId: 's1', agentType: 'claude-code', data } as TimelineEvent;
}

describe('eventCopyText', () => {
  it('copies a shell call: command, blank line, whole output', () => {
    const out = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const t = eventCopyText(ev('tool_call_completed', { toolName: 'Bash', toolInput: { command: 'ls -la' }, toolOutput: out }));
    expect(t).toBe(`ls -la\n\n${out}`);
  });

  it('copies a Read with its range, then the output', () => {
    const t = eventCopyText(ev('tool_call_completed', { toolName: 'Read', toolInput: { file_path: '/a/b.ts', offset: 10, limit: 5 }, toolOutput: 'x' }));
    expect(t.startsWith('/a/b.ts')).toBe(true);
    expect(t).toContain('10');
    expect(t.endsWith('\n\nx')).toBe(true);
  });

  it('copies a Grep by pattern, not directory', () => {
    const t = eventCopyText(ev('tool_call_completed', { toolName: 'Grep', toolInput: { path: '/repo', pattern: 'foo' } }));
    expect(t).toBe('foo');
  });

  it('copies an Edit as a prefixed diff', () => {
    const t = eventCopyText(ev('tool_call_completed', { toolName: 'Edit', toolInput: { file_path: '/f.ts', old_string: 'a\nb', new_string: 'a\nc' } }));
    expect(t).toBe('/f.ts\n a\n-b\n+c');
  });

  it('does not truncate a Write', () => {
    const content = 'x'.repeat(900);
    const t = eventCopyText(ev('tool_call_completed', { toolName: 'Write', toolInput: { file_path: '/f.ts', content } }));
    expect(t).toBe(`/f.ts\n${content}`);
  });

  it('copies input then error for a failed call', () => {
    const t = eventCopyText(ev('tool_call_failed', { toolName: 'Bash', toolInput: { command: 'false' }, error: 'boom' }));
    expect(t).toBe('false\n\nboom');
  });

  it('copies only the text of a prompt', () => {
    expect(eventCopyText(ev('user_prompt', { prompt: 'hello' }))).toBe('hello');
  });

  it('copies the response without the reasoning', () => {
    const t = eventCopyText(ev('agent_response', { prompt: '<think>hmm</think>\n\nAnswer.' }));
    expect(t).toBe('Answer.');
  });

  it('ends with the reason for a denied call', () => {
    const t = eventCopyText(ev('tool_call_denied', { toolName: 'Bash', toolInput: { command: 'rm x' }, decision: { decision: 'deny', reason: 'no' } }));
    expect(t).toBe('rm x\n\nReason: no');
  });

  it('pretty-prints an object output', () => {
    const t = eventCopyText(ev('tool_call_completed', { toolName: 'Foo', toolInput: { a: 1 }, toolOutput: { ok: true } }));
    expect(t.endsWith(JSON.stringify({ ok: true }, null, 2))).toBe(true);
  });

  it('falls back to eventDetail for an event with nothing', () => {
    const e = ev('notification', {});
    expect(eventCopyText(e)).toBe(eventDetail(e));
  });
});

describe('toolInputText', () => {
  it('treats any input with a command as a shell call', () => {
    expect(toolInputText({ command: 'echo hi' }, 'shell')).toBe('echo hi');
  });
});

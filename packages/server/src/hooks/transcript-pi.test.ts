import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parsePiTranscript } from './transcript-pi.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'pi');

function loadLines(name: string): string[] {
  const content = readFileSync(join(FIXTURES_DIR, `${name}.jsonl`), 'utf-8');
  return content.trim().split('\n').filter(Boolean);
}

describe('parsePiTranscript', () => {
  it('returns empty events for an empty file', () => {
    const { events, metadata } = parsePiTranscript([], 'sess');
    expect(events).toEqual([]);
    expect(metadata.version).toBe('');
  });

  it('parses a linear session: user prompt, thinking, paired tool calls, response', () => {
    const { events, metadata } = parsePiTranscript(loadLines('linear'), 'sess-linear');

    expect(metadata.version).toBe('3');
    expect(metadata.cwd).toBe('/Users/test/project');

    expect(events.map((e) => e.type)).toEqual([
      'user_prompt',
      'agent_response', // thinking + first tool call
      'tool_call_completed', // read -> Read
      'agent_response', // text + second tool call
      'tool_call_completed', // find -> Glob
    ]);

    const userPrompt = events[0];
    expect(userPrompt.data.prompt).toBe('Read notes.md then summarize it');

    const firstResponse = events[1];
    expect(firstResponse.data.prompt).toBe('');
    expect(firstResponse.data.thinking).toBe('I should read the file first.');

    const firstTool = events[2];
    expect(firstTool.data.toolName).toBe('Read');
    expect(firstTool.data.toolInput).toEqual({ path: 'notes.md' });
    expect(firstTool.data.toolOutput).toBe('file contents here');

    const secondResponse = events[3];
    expect(secondResponse.data.prompt).toBe('The file says: file contents here');
    expect(secondResponse.data.thinking).toBeUndefined();

    const secondTool = events[4];
    expect(secondTool.data.toolName).toBe('Glob'); // 'find' -> 'Glob'
  });

  it('tags every event with agentType "pi"', () => {
    const { events } = parsePiTranscript(loadLines('linear'), 'sess-linear');
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.agentType).toBe('pi');
      expect(event.sessionId).toBe('sess-linear');
    }
  });

  it('imports only the latest-timestamp leaf, dropping abandoned branches', () => {
    const { events } = parsePiTranscript(loadLines('branched'), 'sess-branched');

    const responses = events.filter((e) => e.type === 'agent_response').map((e) => e.data.prompt);
    expect(responses).toEqual(['Here is approach B']);
    expect(responses).not.toContain('Here is approach A');

    // The shared root user prompt is not duplicated across branches.
    expect(events.filter((e) => e.type === 'user_prompt')).toHaveLength(1);
  });

  it('emits a trailing tool_call_pending when the session ends mid-call, without crashing', () => {
    const { events } = parsePiTranscript(loadLines('mid-tool-call'), 'sess-mid');

    expect(events.map((e) => e.type)).toEqual(['user_prompt', 'tool_call_pending']);
    const pending = events[1];
    expect(pending.data.toolName).toBe('Bash');
    expect(pending.data.toolInput).toEqual({ command: 'npm run build' });
  });

  it('skips a malformed line in the middle and imports the rest', () => {
    const { events } = parsePiTranscript(loadLines('malformed-line'), 'sess-malformed');
    expect(events.map((e) => e.type)).toEqual(['user_prompt', 'agent_response']);
    expect(events[1].data.prompt).toBe('hi there');
  });

  it('skips a file whose header is not format version 3', () => {
    const { events } = parsePiTranscript(loadLines('legacy-version'), 'sess-legacy');
    expect(events).toEqual([]);
  });

  it('emits no agent_response for an assistant message that is only tool calls', () => {
    const { events } = parsePiTranscript(loadLines('tool-only'), 'sess-tool-only');
    expect(events.map((e) => e.type)).toEqual(['user_prompt', 'tool_call_completed']);
  });

  it('marks a tool result as an error via data.error without dropping the output', () => {
    const lines = [
      '{"type":"session","version":3,"id":"s1","timestamp":"2026-08-21T10:00:00.000Z","cwd":"/tmp/x"}',
      '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-21T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"run it"}],"timestamp":1}}',
      '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-21T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"false"}}],"usage":{},"stopReason":"toolUse","timestamp":2}}',
      '{"type":"message","id":"tr1","parentId":"a1","timestamp":"2026-08-21T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"command failed"}],"isError":true,"timestamp":3}}',
    ];
    const { events } = parsePiTranscript(lines, 'sess-err');
    const tool = events.find((e) => e.type === 'tool_call_completed')!;
    expect(tool.data.toolOutput).toBe('command failed');
    expect(tool.data.error).toBe('command failed');
  });

  it('tolerates a corrupt self-referencing parentId instead of looping forever', () => {
    // a0 is its own parent. u1 is the only leaf (nothing points to it), so the
    // walk starts there, reaches a0, then must stop rather than revisiting a0
    // forever chasing its own parentId.
    const lines = [
      '{"type":"session","version":3,"id":"s1","timestamp":"2026-08-21T10:00:00.000Z","cwd":"/tmp/x"}',
      '{"type":"message","id":"a0","parentId":"a0","timestamp":"2026-08-21T10:00:00.500Z","message":{"role":"assistant","content":[{"type":"text","text":"loop node"}],"usage":{},"stopReason":"endTurn","timestamp":0}}',
      '{"type":"message","id":"u1","parentId":"a0","timestamp":"2026-08-21T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}',
    ];
    const { events } = parsePiTranscript(lines, 'sess-cycle');
    expect(events.map((e) => e.type)).toEqual(['agent_response', 'user_prompt']);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parsePiTranscript, piUsageSamples } from './transcript-pi.js';

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

describe('parsePiTranscript metrics', () => {
  it('sums every billed call on every branch, and reads context from the active branch', () => {
    const { metrics } = parsePiTranscript(loadLines('usage'), 'sess-usage');
    expect(metrics).not.toBeNull();
    // a1 + a2 + the abandoned a2b + the aborted a3: all were billed.
    expect(metrics!.totals).toEqual({ input: 8120, output: 243, cacheRead: 22000, cacheWrite: 10, reasoning: 75 });
    expect(metrics!.costUsd).toBeCloseTo(0.03);
    // a3 was aborted, so pi's rule falls back to a2, the last valid call on the active branch.
    expect(metrics!.current).toEqual({ input: 600, output: 90, cacheRead: 7100, cacheWrite: 10, reasoning: 30 });
    expect(metrics!.contextTokens).toBe(7800);
    expect(metrics!.modelId).toBe('local-27b');
    expect(metrics!.thinkingLevel).toBe('off');
  });

  it('counts a compaction\'s summarising call, and knows no context until the next answer', () => {
    const lines = loadLines('usage-compacted');
    const { metrics } = parsePiTranscript(lines, 'sess-compacted');
    expect(metrics!.totals).toEqual({ input: 236000, output: 11500, cacheRead: 0, cacheWrite: 0, reasoning: 4200 });
    expect(metrics!.contextTokens).toBeNull();
    expect(metrics!.current).toEqual({ input: 180000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 200 });

    const after = parsePiTranscript([...lines,
      '{"type":"message","id":"a2","parentId":"k1","timestamp":"2026-11-06T14:18:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":12000,"output":30,"cacheRead":0,"cacheWrite":0,"totalTokens":12030},"stopReason":"stop"}}',
    ], 'sess-compacted').metrics!;
    expect(after.contextTokens).toBe(12030);
    // An older pi records no `reasoning`: it counts as none.
    expect(after.current!.reasoning).toBe(0);
  });

  it('falls back to the last assistant message\'s model when there is no model_change', () => {
    const lines = loadLines('usage').filter((l) => !l.includes('"model_change"'));
    expect(parsePiTranscript(lines, 's').metrics!.modelId).toBe('local-27b');
  });

  it('is null when nothing reports usage', () => {
    const noUsage = loadLines('linear').map((l) => {
      const e = JSON.parse(l);
      if (e.message) delete e.message.usage;
      return JSON.stringify(e);
    });
    expect(parsePiTranscript(noUsage, 's').metrics).toBeNull();
    expect(parsePiTranscript([], 's').metrics).toBeNull();
  });
});

describe('piUsageSamples', () => {
  it('lists each billed call with its entry time, on every branch, compactions included', () => {
    const samples = piUsageSamples(loadLines('usage-compacted'));
    expect(samples.map((s) => [s.at, s.tokens.input])).toEqual([
      [Date.parse('2026-11-06T14:17:33.000Z'), 180000],
      [Date.parse('2026-11-06T14:18:00.000Z'), 56000],
    ]);
    // A tool result that merely mentions "usage" is parsed and skipped.
    expect(piUsageSamples(loadLines('usage'))).toHaveLength(4);
  });
});

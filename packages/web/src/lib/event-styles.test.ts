import { describe, it, expect } from 'vitest';
import { thinkingRowFor, eventDetail, kindLabel, THINKING_ROW_SUFFIX } from './event-styles.js';
import type { TimelineEvent } from './types.js';

function ev(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 'e1',
    type: 'agent_response',
    timestamp: 1_700_000_000_000,
    sessionId: 's1',
    agentType: 'pi',
    data: {},
    ...overrides,
  };
}

describe('thinkingRowFor', () => {
  it('derives a row from a response that carries reasoning', () => {
    const row = thinkingRowFor(ev({ data: { prompt: 'The answer is 4.' } }), 'two plus two');

    expect(row).not.toBeNull();
    expect(row!.type).toBe('agent_thinking');
    expect(row!.data.prompt).toBe('two plus two');
  });

  it('gives the row a distinct id so expand state cannot collide', () => {
    const row = thinkingRowFor(ev(), 'reasoning');
    expect(row!.id).toBe(`e1${THINKING_ROW_SUFFIX}`);
    expect(row!.id).not.toBe('e1');
  });

  it('returns null when there is no reasoning', () => {
    expect(thinkingRowFor(ev(), null)).toBeNull();
    expect(thinkingRowFor(ev(), '')).toBeNull();
    expect(thinkingRowFor(ev(), '   ')).toBeNull();
  });

  it('returns null for anything that is not an agent response', () => {
    expect(thinkingRowFor(ev({ type: 'user_prompt' }), 'reasoning')).toBeNull();
    expect(thinkingRowFor(ev({ type: 'tool_call_completed' }), 'reasoning')).toBeNull();
  });

  it('does not carry the response risk level or analysis onto the row', () => {
    // Reasoning is not itself an action; inheriting these would double-count the
    // response's risk and show its analysis twice.
    const row = thinkingRowFor(
      ev({ riskLevel: 'high', laymans: { explanation: 'x', model: 'm', latencyMs: 1, tokens: { input: 1, output: 1 } } }),
      'reasoning',
    );
    expect(row!.riskLevel).toBeUndefined();
    expect(row!.laymans).toBeUndefined();
    expect(row!.analysis).toBeUndefined();
  });

  it('leaves the original event untouched', () => {
    const original = ev({ data: { prompt: 'answer', thinking: 'reasoning' } });
    thinkingRowFor(original, 'reasoning');
    expect(original.data.thinking).toBe('reasoning');
    expect(original.data.prompt).toBe('answer');
    expect(original.type).toBe('agent_response');
  });

  it('labels the row as its own top-level kind', () => {
    expect(kindLabel('agent_thinking')).toBe('thinking');
  });
});

describe('eventDetail', () => {
  it('includes the line range of a windowed read', () => {
    // pi renders `read …/autocomplete.js:320-419`; the summary row should agree.
    const detail = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Read', toolInput: { path: '/tmp/autocomplete.js', offset: 320, limit: 100 } },
    }));
    expect(detail).toBe('Read — /tmp/autocomplete.js:320-419');
  });

  it("resolves claude-code's file_path as well", () => {
    const detail = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Read', toolInput: { file_path: '/tmp/a.ts' } },
    }));
    expect(detail).toBe('Read — /tmp/a.ts');
  });

  it('falls back to the pattern for a search tool', () => {
    const detail = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Grep', toolInput: { pattern: 'TODO' } },
    }));
    expect(detail).toBe('Grep — TODO');
  });

  it('prefers a bash command over anything else', () => {
    const detail = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Bash', toolInput: { command: 'ls -la', path: '/tmp' } },
    }));
    expect(detail).toBe('Bash — ls -la');
  });
});

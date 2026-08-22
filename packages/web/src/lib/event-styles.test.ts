import { describe, it, expect } from 'vitest';
import {
  thinkingRowFor, eventDetail, kindLabel, withThinkingRows, baseEventId, isThinkingRow,
  THINKING_ROW_SUFFIX,
} from './event-styles.js';
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

  it("shows a search's pattern rather than the directory it searched", () => {
    // claude-code's Grep/Glob use `path` for where to look. Resolving it as the
    // file the call operated on made every search in a session read as the same
    // repository root, and made the pattern fallback above unreachable.
    const grep = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Grep', toolInput: { pattern: 'TODO', path: '/repo' } },
    }));
    expect(grep).toBe('Grep — TODO');

    const glob = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Glob', toolInput: { pattern: '**/*.ts', path: '/repo' } },
    }));
    expect(glob).toBe('Glob — **/*.ts');
  });

  it('prefers a bash command over anything else', () => {
    const detail = eventDetail(ev({
      type: 'tool_call_completed',
      data: { toolName: 'Bash', toolInput: { command: 'ls -la', path: '/tmp' } },
    }));
    expect(detail).toBe('Bash — ls -la');
  });
});

describe('withThinkingRows', () => {
  const prompt = ev({ id: 'p1', type: 'user_prompt', data: { prompt: 'go' } });
  const tool = ev({ id: 't1', type: 'tool_call_completed', data: { toolName: 'Read' } });
  const withThinking = ev({ id: 'r1', data: { prompt: 'answer', thinking: 'reasoning' } });
  const withoutThinking = ev({ id: 'r2', data: { prompt: 'answer' } });

  it('inserts the thinking row immediately before its response', () => {
    const rows = withThinkingRows([prompt, tool, withThinking]);
    expect(rows.map((r) => r.id)).toEqual(['p1', 't1', `r1${THINKING_ROW_SUFFIX}`, 'r1']);
  });

  it('leaves a response with no reasoning alone', () => {
    const rows = withThinkingRows([prompt, withoutThinking]);
    expect(rows.map((r) => r.id)).toEqual(['p1', 'r2']);
  });

  it('replaces a reasoning-only response with its thinking row', () => {
    // Every tool-calling step of a reasoning model is a message with reasoning
    // and no prose; rendering the thinking row *and* the response left an empty
    // RESPONSE row under each one. The thinking row is the whole message, so it
    // takes over the real event id — everything that resolves a row by id
    // (scroll-to, expansion, row numbering, pairing) keeps working unchanged.
    const reasoningOnly = ev({ id: 'r5', data: { prompt: '', thinking: 'weighing it up' } });
    const rows = withThinkingRows([prompt, reasoningOnly]);

    expect(rows.map((r) => r.id)).toEqual(['p1', 'r5']);
    expect(rows[1].type).toBe('agent_thinking');
    expect(rows[1].data.prompt).toBe('weighing it up');
  });

  it('returns the same array when nothing can have reasoning', () => {
    // The cheap bail-out: harnesses that report no reasoning must not pay an
    // allocation per render.
    const input = [prompt, tool];
    expect(withThinkingRows(input)).toBe(input);
  });

  it('handles several responses in one list', () => {
    const second = ev({ id: 'r3', data: { prompt: 'more', thinking: 'more reasoning' } });
    const rows = withThinkingRows([withThinking, tool, second]);
    expect(rows.map((r) => r.id)).toEqual([
      `r1${THINKING_ROW_SUFFIX}`, 'r1', 't1', `r3${THINKING_ROW_SUFFIX}`, 'r3',
    ]);
  });

  it('splits reasoning that was inline in the response text', () => {
    // Claude Code delivers reasoning as <think> tags inside the response rather
    // than pre-split, so deriving on the client covers it retroactively too.
    const inline = ev({ id: 'r4', data: { prompt: '<think>deliberation</think>the answer' } });
    const rows = withThinkingRows([inline]);
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('agent_thinking');
    expect(rows[0].data.prompt).toBe('deliberation');
  });

  it('produces a list whose length matches the rendered row count', () => {
    // Keyboard navigation scrolls to querySelectorAll('[data-event-card]')[n],
    // which counts rendered rows — so the list it indexes must include the
    // derived rows or the cursor lands one row short per thinking row above it.
    const rows = withThinkingRows([prompt, withThinking, tool, withoutThinking]);
    expect(rows).toHaveLength(5);
  });
});

describe('baseEventId', () => {
  it('strips the derived suffix', () => {
    expect(baseEventId(`abc${THINKING_ROW_SUFFIX}`)).toBe('abc');
  });

  it('leaves a real event id untouched', () => {
    expect(baseEventId('abc')).toBe('abc');
  });

  it('round-trips a derived row back to its response', () => {
    const row = thinkingRowFor(ev({ id: 'r9' }), 'reasoning')!;
    expect(baseEventId(row.id)).toBe('r9');
  });
});

describe('isThinkingRow', () => {
  it('identifies a derived row', () => {
    expect(isThinkingRow(thinkingRowFor(ev(), 'reasoning')!)).toBe(true);
  });

  it('rejects a real response', () => {
    expect(isThinkingRow(ev())).toBe(false);
  });
});

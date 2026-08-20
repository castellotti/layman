import { describe, it, expect } from 'vitest';
import { extractReasoning, stripReasoning, getEffectiveAgentContent } from './reasoning.js';
import type { TimelineEvent } from './types.js';

function makeEvent(overrides: { type?: string; prompt?: string; thinking?: string } = {}): TimelineEvent {
  return {
    id: 'test-id',
    type: (overrides.type ?? 'agent_response') as TimelineEvent['type'],
    timestamp: 0,
    sessionId: 'test-session',
    agentType: 'claude-code',
    data: {
      ...(overrides.prompt !== undefined ? { prompt: overrides.prompt } : {}),
      ...(overrides.thinking !== undefined ? { thinking: overrides.thinking } : {}),
    },
  };
}

describe('extractReasoning', () => {
  it('returns input unchanged when no reasoning blocks present', () => {
    const result = extractReasoning('Hello, world!');
    expect(result.thinking).toBeNull();
    expect(result.response).toBe('Hello, world!');
  });

  it('extracts <think> block and returns clean response', () => {
    const result = extractReasoning('<think>I need to think about this</think>\n\nHere is my answer.');
    expect(result.thinking).toBe('I need to think about this');
    expect(result.response).toBe('Here is my answer.');
  });

  it('extracts <thinking> block', () => {
    const result = extractReasoning('<thinking>Step by step reasoning</thinking>The conclusion.');
    expect(result.thinking).toBe('Step by step reasoning');
    expect(result.response).toBe('The conclusion.');
  });

  it('extracts <details type="reasoning"> block', () => {
    const input = '<details type="reasoning" done="true" duration="406">\n<summary>Thinking</summary>\nMy reasoning here\n</details>\n\nFinal answer.';
    const result = extractReasoning(input);
    expect(result.thinking).toBe('My reasoning here');
    expect(result.response).toBe('Final answer.');
  });

  it('extracts <details type=\'reasoning\'> with single-quoted attribute', () => {
    const input = "<details type='reasoning'><summary>Thinking</summary>My reasoning</details>Response.";
    const result = extractReasoning(input);
    expect(result.thinking).toBe('My reasoning');
    expect(result.response).toBe('Response.');
  });

  it('decodes HTML entities in extracted thinking', () => {
    const result = extractReasoning('<think>a &lt; b &amp;&amp; c &gt; d</think>Answer.');
    expect(result.thinking).toBe('a < b && c > d');
    expect(result.response).toBe('Answer.');
  });

  it('decodes a double-escaped entity exactly one level, not two', () => {
    // "&amp;lt;" is the literal text "&lt;" escaped once more. A naive chain of
    // sequential replaces decodes it twice, producing "<" instead of "&lt;".
    const result = extractReasoning('<think>&amp;lt;</think>Answer.');
    expect(result.thinking).toBe('&lt;');
  });

  it('handles multiple reasoning blocks by joining with double newline', () => {
    const result = extractReasoning('<think>First thought</think>\n<think>Second thought</think>\nFinal.');
    expect(result.thinking).toBe('First thought\n\nSecond thought');
    expect(result.response).toBe('Final.');
  });

  it('returns null thinking when block is empty', () => {
    const result = extractReasoning('<think></think>Just the response.');
    expect(result.thinking).toBeNull();
    expect(result.response).toBe('Just the response.');
  });

  it('handles multiline thinking content', () => {
    const result = extractReasoning('<think>\nLine 1\nLine 2\nLine 3\n</think>\nAnswer.');
    expect(result.thinking).toContain('Line 1');
    expect(result.thinking).toContain('Line 3');
    expect(result.response).toBe('Answer.');
  });

  it('is case-insensitive for tag names', () => {
    const result = extractReasoning('<THINK>Upper case tag</THINK>Response.');
    expect(result.thinking).toBe('Upper case tag');
    expect(result.response).toBe('Response.');
  });

  it('trims whitespace from response', () => {
    const result = extractReasoning('<think>Thinking</think>   \n\n   Response text   ');
    expect(result.response).toBe('Response text');
  });
});

describe('stripReasoning', () => {
  it('returns plain text unchanged', () => {
    expect(stripReasoning('No reasoning here.')).toBe('No reasoning here.');
  });

  it('strips <think> block and returns only response', () => {
    expect(stripReasoning('<think>Internal</think>External reply.')).toBe('External reply.');
  });

  it('strips <details type="reasoning"> block', () => {
    const input = '<details type="reasoning"><summary>Thinking</summary>Hidden</details>Visible.';
    expect(stripReasoning(input)).toBe('Visible.');
  });
});

describe('getEffectiveAgentContent', () => {
  it('returns raw prompt and null thinking for non-agent-response events', () => {
    const event = makeEvent({ type: 'user_prompt', prompt: 'Hello there' });
    const result = getEffectiveAgentContent(event);
    expect(result.thinking).toBeNull();
    expect(result.response).toBe('Hello there');
  });

  it('returns data.thinking directly for new agent_response events', () => {
    const event = makeEvent({ type: 'agent_response', prompt: 'Clean response', thinking: 'Pre-extracted thinking' });
    const result = getEffectiveAgentContent(event);
    expect(result.thinking).toBe('Pre-extracted thinking');
    expect(result.response).toBe('Clean response');
  });

  it('extracts reasoning from prompt for old agent_response events without data.thinking', () => {
    const event = makeEvent({
      type: 'agent_response',
      prompt: '<think>Hidden reasoning</think>Visible response.',
    });
    const result = getEffectiveAgentContent(event);
    expect(result.thinking).toBe('Hidden reasoning');
    expect(result.response).toBe('Visible response.');
  });

  it('returns empty response and null thinking for agent_response with no prompt', () => {
    const event = makeEvent({ type: 'agent_response' });
    const result = getEffectiveAgentContent(event);
    expect(result.thinking).toBeNull();
    expect(result.response).toBe('');
  });

  it('handles agent_response where entire content is a reasoning block', () => {
    const event = makeEvent({
      type: 'agent_response',
      prompt: '<think>Only thinking, no response text</think>',
    });
    const result = getEffectiveAgentContent(event);
    expect(result.thinking).toBe('Only thinking, no response text');
    expect(result.response).toBe('');
  });

  it('handles non-agent-response events with no prompt', () => {
    const event = makeEvent({ type: 'user_prompt' });
    const result = getEffectiveAgentContent(event);
    expect(result.thinking).toBeNull();
    expect(result.response).toBe('');
  });
});

import { describe, it, expect } from 'vitest';
import { pairFor, hasLogDetail } from './event-pairing.js';
import type { TimelineEvent } from './types.js';

function ev(id: string, type: TimelineEvent['type'], overrides: Partial<TimelineEvent['data']> = {}): TimelineEvent {
  return {
    id,
    type,
    timestamp: Number(id.replace(/\D/g, '')) || 0,
    sessionId: 's1',
    agentType: 'claude-code',
    data: overrides,
  };
}

describe('pairFor', () => {
  it('prompt → pairs with the final response of its exchange', () => {
    const events = [
      ev('e1', 'user_prompt', { prompt: 'do thing' }),
      ev('e2', 'tool_call_completed', { toolName: 'Bash' }),
      ev('e3', 'agent_response', { prompt: 'partial update' }),
      ev('e4', 'tool_call_completed', { toolName: 'Bash' }),
      ev('e5', 'agent_response', { prompt: 'final answer' }),
    ];
    expect(pairFor('e1', events)).toEqual(['e1', 'e5']);
  });

  it('response → pairs with its originating prompt', () => {
    const events = [
      ev('e1', 'user_prompt', { prompt: 'do thing' }),
      ev('e2', 'tool_call_completed'),
      ev('e3', 'agent_response', { prompt: 'final answer' }),
    ];
    expect(pairFor('e3', events)).toEqual(['e1', 'e3']);
  });

  it('multi-prompt session — pairing stays within the correct exchange', () => {
    const events = [
      ev('e1', 'user_prompt', { prompt: 'first' }),
      ev('e2', 'agent_response', { prompt: 'first answer' }),
      ev('e3', 'user_prompt', { prompt: 'second' }),
      ev('e4', 'tool_call_completed'),
      ev('e5', 'agent_response', { prompt: 'second answer' }),
    ];
    expect(pairFor('e3', events)).toEqual(['e3', 'e5']);
    expect(pairFor('e5', events)).toEqual(['e3', 'e5']);
    expect(pairFor('e1', events)).toEqual(['e1', 'e2']);
  });

  it('tool calls and other kinds expand alone', () => {
    const events = [
      ev('e1', 'user_prompt', { prompt: 'first' }),
      ev('e2', 'tool_call_completed', { toolName: 'Bash' }),
      ev('e3', 'agent_response', { prompt: 'answer' }),
    ];
    expect(pairFor('e2', events)).toEqual(['e2']);
  });

  it('a prompt with no response yet in its exchange expands alone', () => {
    const events = [ev('e1', 'user_prompt', { prompt: 'first' }), ev('e2', 'tool_call_pending')];
    expect(pairFor('e1', events)).toEqual(['e1']);
  });

  it('an unknown id falls back to itself', () => {
    expect(pairFor('missing', [ev('e1', 'user_prompt')])).toEqual(['missing']);
  });

  it('a collapsed duplicate prompt pairs with itself, not the canonical prompt id', () => {
    const events = [
      ev('e1', 'user_prompt', { prompt: 'do thing' }),
      ev('e1b', 'user_prompt', { prompt: 'do thing' }), // duplicate, absorbed into e1's turn
      ev('e2', 'tool_call_completed', { toolName: 'Bash' }),
      ev('e3', 'agent_response', { prompt: 'final answer' }),
    ];
    expect(pairFor('e1b', events)).toEqual(['e1b', 'e3']);
    expect(pairFor('e1', events)).toEqual(['e1', 'e3']);
  });
});

describe('hasLogDetail', () => {
  it('prompts, responses, and tool calls have detail', () => {
    expect(hasLogDetail(ev('e1', 'user_prompt', { prompt: 'x' }))).toBe(true);
    expect(hasLogDetail(ev('e2', 'agent_response', { prompt: 'x' }))).toBe(true);
    expect(hasLogDetail(ev('e3', 'tool_call_completed', { toolName: 'Bash', toolInput: { command: 'ls' } }))).toBe(true);
  });

  it('bare structural events with no payload have no detail', () => {
    expect(hasLogDetail(ev('e1', 'session_start'))).toBe(false);
    expect(hasLogDetail(ev('e2', 'notification'))).toBe(false);
  });
});

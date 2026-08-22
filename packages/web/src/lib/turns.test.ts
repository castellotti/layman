import { describe, it, expect } from 'vitest';
import { extractTurns, extractTurn, turnForEvent } from './turns.js';
import type { TimelineEvent, EventType } from './types.js';

/**
 * The client copy of the turn rule (see turns.ts). These cases deliberately
 * mirror packages/server/src/turns/extract.test.ts — the two implementations are
 * hand-mirrored, so matching tests are what catch a drift between them.
 */

let clock = 1000;

function ev(type: EventType, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  clock += 10;
  return {
    id: overrides.id ?? `${type}-${clock}`,
    type,
    timestamp: overrides.timestamp ?? clock,
    sessionId: overrides.sessionId ?? 'sess-1',
    agentType: overrides.agentType ?? 'claude-code',
    data: overrides.data ?? {},
    ...(overrides.riskLevel ? { riskLevel: overrides.riskLevel } : {}),
  };
}

function prompt(text: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return ev('user_prompt', { ...overrides, data: { prompt: text } });
}

function response(text: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return ev('agent_response', { ...overrides, data: { prompt: text } });
}

describe('extractTurns', () => {
  it('pairs a prompt with the LAST agent_response before the next prompt', () => {
    const events = [
      prompt('plug the holes'),
      ev('tool_call_completed'),
      response('an edge-on view showing the corner blocks'),
      ev('tool_call_completed'),
      response('all three changes are in and verified'),
    ];

    const turns = extractTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('all three changes are in and verified');
    expect(turns[0].responseEventId).toBe(events[4].id);
    expect(turns[0].toolCallCount).toBe(2);
  });

  it('skips a trailing reasoning-only response when choosing the answer', () => {
    // Mirrors packages/server/src/turns/extract.test.ts. pi records an
    // assistant message per tool-calling step for its reasoning alone — empty
    // text with `thinking` set — so taking the last one unconditionally let a
    // blank message overwrite the real answer.
    const opening = prompt('plug the holes');
    const answer = response('all three changes are in and verified');
    const events = [
      opening,
      answer,
      ev('agent_response', { data: { prompt: '', thinking: 'now I should run the tests' } }),
      ev('tool_call_completed'),
    ];

    const turns = extractTurns(events);

    expect(turns[0].responseText).toBe('all three changes are in and verified');
    expect(turns[0].responseEventId).toBe(answer.id);
  });

  it('falls back to a reasoning-only response when the turn said nothing else', () => {
    const opening = prompt('plug the holes');
    const thinkingOnly = ev('agent_response', {
      id: 'r-thinking', data: { prompt: '', thinking: 'let me look at the tests' },
    });
    const turns = extractTurns([opening, thinkingOnly]);

    expect(turns[0].responseEventId).toBe('r-thinking');
    expect(turns[0].thinkingText).toBe('let me look at the tests');
    expect(turns[0].responseText).toBe('');
  });

  it('excludes events preceding the first user_prompt', () => {
    const preamble = ev('session_start');
    const turns = extractTurns([preamble, prompt('go'), response('done')]);

    expect(turns[0].eventIds).not.toContain(preamble.id);
  });

  it('collapses a prompt recorded twice by the double-registration bug', () => {
    const events = [
      prompt('plug the holes', { timestamp: 1000, id: 'p1' }),
      response('earlier turn, arriving late', { timestamp: 1007, id: 'stray' }),
      prompt('plug the holes', { timestamp: 1009, id: 'p1-dup' }),
      ev('tool_call_completed', { timestamp: 1200 }),
      response('all three changes are in', { timestamp: 1300, id: 'r1' }),
    ];

    const turns = extractTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].promptEventId).toBe('p1');
    expect(turns[0].eventIds).toContain('p1-dup');
    expect(turns[0].responseEventId).toBe('r1');
  });

  it('keeps a genuine re-send of the same text as its own turn', () => {
    const events = [
      prompt('try again', { timestamp: 1000 }),
      prompt('try again', { timestamp: 2000 }),
      response('done', { timestamp: 3000 }),
    ];

    expect(extractTurns(events)).toHaveLength(2);
  });

  it('does not collapse different prompts sent back to back', () => {
    const events = [
      prompt('first', { timestamp: 1000 }),
      prompt('second', { timestamp: 1005 }),
      response('answer to both', { timestamp: 1500 }),
    ];

    expect(extractTurns(events).map((t) => t.promptText)).toEqual(['first', 'second']);
  });
});

describe('extractTurn', () => {
  it('finds a turn by its prompt event id', () => {
    const events = [prompt('first'), response('a'), prompt('second'), response('b')];

    expect(extractTurn(events, events[2].id)?.promptText).toBe('second');
  });

  it('resolves a collapsed duplicate prompt id to its absorbing turn', () => {
    const events = [
      prompt('go', { timestamp: 1000, id: 'p1' }),
      prompt('go', { timestamp: 1010, id: 'p1-dup' }),
      response('done', { timestamp: 1500 }),
    ];

    expect(extractTurn(events, 'p1-dup')?.promptEventId).toBe('p1');
  });

  it('returns null for an unknown or non-prompt id', () => {
    const events = [prompt('first'), response('a')];

    expect(extractTurn(events, 'nope')).toBeNull();
    expect(extractTurn(events, events[1].id)).toBeNull();
  });
});

describe('turnForEvent', () => {
  it('finds the turn owning an arbitrary event', () => {
    const events = [
      prompt('first'),
      response('a'),
      prompt('second'),
      ev('tool_call_completed', { id: 'tool' }),
      response('b'),
    ];

    expect(turnForEvent(events, 'tool')?.promptText).toBe('second');
  });

  it('returns null for an event owned by no turn', () => {
    const preamble = ev('session_start');

    expect(turnForEvent([preamble, prompt('go')], preamble.id)).toBeNull();
  });
});

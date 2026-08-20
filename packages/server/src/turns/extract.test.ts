import { describe, it, expect } from 'vitest';
import { extractTurns, extractTurn } from './extract.js';
import type { TimelineEvent, EventType } from '../events/types.js';

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
    // Mirrors the shape of a real transcript: interstitial messages between
    // tool calls, then a final summary. The summary is the answer.
    const events = [
      prompt('plug the holes'),
      ev('tool_call_completed'),
      response('this is an edge-on view showing the corner blocks'),
      ev('tool_call_completed'),
      response('the offset correctly shifted all 6 punched holes'),
      ev('tool_call_completed'),
      response('all three changes are in and verified'),
    ];

    const turns = extractTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].responseText).toBe('all three changes are in and verified');
    expect(turns[0].responseEventId).toBe(events[6].id);
    expect(turns[0].toolCallCount).toBe(3);
    expect(turns[0].eventIds).toHaveLength(7);
  });

  it('numbers turns from zero and splits on each user_prompt', () => {
    const events = [
      prompt('first'),
      response('answer one'),
      prompt('second'),
      response('answer two'),
    ];

    const turns = extractTurns(events);

    expect(turns.map((t) => t.index)).toEqual([0, 1]);
    expect(turns.map((t) => t.promptText)).toEqual(['first', 'second']);
    expect(turns.map((t) => t.responseText)).toEqual(['answer one', 'answer two']);
  });

  it('excludes events preceding the first user_prompt', () => {
    const preamble = ev('session_start');
    const events = [preamble, ev('instructions_loaded'), prompt('go'), response('done')];

    const turns = extractTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].eventIds).not.toContain(preamble.id);
    expect(turns[0].eventIds).toHaveLength(2);
  });

  it('returns a null response for a turn that produced none', () => {
    // Two consecutive prompts: the user sent a second message before the agent replied.
    const events = [prompt('first'), prompt('second'), response('answer to both')];

    const turns = extractTurns(events);

    expect(turns).toHaveLength(2);
    expect(turns[0].responseEventId).toBeNull();
    expect(turns[0].responseText).toBe('');
    expect(turns[1].responseEventId).toBe(events[2].id);
  });

  it('does not treat the prompt itself as its own response', () => {
    const events = [prompt('only a prompt')];

    const turns = extractTurns(events);

    expect(turns[0].responseEventId).toBeNull();
    expect(turns[0].endedAt).toBe(turns[0].startedAt);
  });

  it('sorts out-of-order events by timestamp before grouping', () => {
    const p = prompt('go', { timestamp: 100, id: 'p1' });
    const early = ev('tool_call_completed', { timestamp: 50, id: 'preamble' });
    const late = response('done', { timestamp: 200, id: 'r1' });

    const turns = extractTurns([late, early, p]);

    expect(turns).toHaveLength(1);
    expect(turns[0].eventIds).toEqual(['p1', 'r1']);
    expect(turns[0].startedAt).toBe(100);
    expect(turns[0].endedAt).toBe(200);
  });

  it('preserves insertion order for events sharing a timestamp', () => {
    const events = [
      prompt('go', { timestamp: 500, id: 'p' }),
      response('first', { timestamp: 500, id: 'r1' }),
      response('second', { timestamp: 500, id: 'r2' }),
    ];

    const turns = extractTurns(events);

    expect(turns[0].eventIds).toEqual(['p', 'r1', 'r2']);
    expect(turns[0].responseEventId).toBe('r2');
  });

  it('counts tool calls once each across their lifecycle types', () => {
    const events = [
      prompt('go'),
      ev('tool_call_pending'),
      ev('tool_call_completed'),
      ev('tool_call_failed'),
      ev('tool_call_denied'),
      ev('notification'),
      response('done'),
    ];

    expect(extractTurns(events)[0].toolCallCount).toBe(4);
  });

  it('tallies risk levels of owned events', () => {
    const events = [
      prompt('go'),
      ev('tool_call_completed', { riskLevel: 'low' }),
      ev('tool_call_completed', { riskLevel: 'low' }),
      ev('tool_call_completed', { riskLevel: 'high' }),
      response('done'),
    ];

    expect(extractTurns(events)[0].riskLevels).toEqual({ low: 2, high: 1 });
  });

  it('strips reasoning blocks from the response text', () => {
    const events = [
      prompt('go'),
      response('<think>secret deliberation</think>the visible answer'),
    ];

    const turn = extractTurns(events)[0];

    expect(turn.responseText).toBe('the visible answer');
    expect(turn.thinkingText).toBe('secret deliberation');
  });

  it('prefers a pre-split data.thinking field over inline parsing', () => {
    const events = [
      prompt('go'),
      ev('agent_response', { data: { prompt: 'clean answer', thinking: 'split out earlier' } }),
    ];

    const turn = extractTurns(events)[0];

    expect(turn.responseText).toBe('clean answer');
    expect(turn.thinkingText).toBe('split out earlier');
  });

  it('collapses a prompt recorded twice by the double-registration bug', () => {
    // The real shape from recorded history: the duplicate lands milliseconds
    // later, with the previous turn's trailing agent_response racing between them.
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
      prompt('try again', { timestamp: 1000 + 1000 }),
      response('done', { timestamp: 3000 }),
    ];

    expect(extractTurns(events)).toHaveLength(2);
  });

  it('collapses a whole run of duplicates, not just the first pair', () => {
    const events = [
      prompt('go', { timestamp: 1000, id: 'a' }),
      prompt('go', { timestamp: 1010, id: 'b' }),
      prompt('go', { timestamp: 1020, id: 'c' }),
      response('done', { timestamp: 1500 }),
    ];

    const turns = extractTurns(events);

    expect(turns).toHaveLength(1);
    expect(turns[0].eventIds).toEqual(['a', 'b', 'c', turns[0].responseEventId]);
  });

  it('does not collapse different prompts sent back to back', () => {
    const events = [
      prompt('first', { timestamp: 1000 }),
      prompt('second', { timestamp: 1005 }),
      response('answer to both', { timestamp: 1500 }),
    ];

    expect(extractTurns(events).map((t) => t.promptText)).toEqual(['first', 'second']);
  });

  it('returns no turns for a session with no prompts', () => {
    expect(extractTurns([ev('session_start'), ev('session_end')])).toEqual([]);
    expect(extractTurns([])).toEqual([]);
  });
});

describe('extractTurn', () => {
  it('finds a turn by its prompt event id', () => {
    const events = [prompt('first'), response('a'), prompt('second'), response('b')];

    const turn = extractTurn(events, events[2].id);

    expect(turn?.promptText).toBe('second');
    expect(turn?.index).toBe(1);
  });

  it('returns null for an unknown or non-prompt id', () => {
    const events = [prompt('first'), response('a')];

    expect(extractTurn(events, 'nope')).toBeNull();
    expect(extractTurn(events, events[1].id)).toBeNull();
  });

  it('resolves a collapsed duplicate prompt id to its absorbing turn', () => {
    // A URL minted before the collapse names the duplicate; it must still open
    // the turn rather than 404.
    const events = [
      prompt('go', { timestamp: 1000, id: 'p1' }),
      prompt('go', { timestamp: 1010, id: 'p1-dup' }),
      response('done', { timestamp: 1500 }),
    ];

    expect(extractTurn(events, 'p1-dup')?.promptEventId).toBe('p1');
  });
});

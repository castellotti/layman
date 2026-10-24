import { describe, it, expect } from 'vitest';
import { TURN_LEAD_MS, TURN_TAIL_MS, turnRange, turnSpan } from './turn-range.js';
import { extractTurns } from './turns.js';
import type { TimelineEvent, EventType } from './types.js';

let n = 0;
const ev = (type: EventType, timestamp: number, data: Record<string, unknown> = {}): TimelineEvent =>
  ({ id: `e${++n}`, type, timestamp, sessionId: 's', agentType: 'pi', data } as TimelineEvent);
const done = { last: false, live: false };

describe('turnSpan and turnRange', () => {
  it('uses the transcript’s times: the prompt to the last event’s completion, with grace', () => {
    const owned = [
      ev('user_prompt', 10_500, { prompt: 'go', transcriptAt: 10_000 }),
      ev('tool_call_completed', 12_500, { transcriptAt: 11_000, transcriptCompletedAt: 15_000 }),
      ev('agent_response', 13_000, { prompt: 'done', transcriptAt: 14_000 }),
    ];
    const span = turnSpan(owned, done)!;
    expect(span).toEqual({ startedAt: 10_000, endedAt: 15_000, exact: true });
    expect(turnRange(span)).toEqual({ from: 10_000 - TURN_LEAD_MS, to: 15_000 + TURN_TAIL_MS });
  });

  it('falls back to the events’ times, and marks the range approximate', () => {
    const span = turnSpan([ev('user_prompt', 1000, { prompt: 'go' }), ev('agent_response', 4000, { prompt: 'ok' })], done)!;
    expect(span).toEqual({ startedAt: 1000, endedAt: 4000, exact: false });
  });

  it('gives an open range for the last turn of a live session that has not answered yet', () => {
    const owned = [ev('user_prompt', 1000, { prompt: 'go' }), ev('tool_call_pending', 2000), ev('agent_response', 3000, { prompt: '', thinking: 'hmm' })];
    expect(turnRange(turnSpan(owned, { last: true, live: true })!)).toEqual({ from: 0, to: null });
    // Not the last turn, or the session is not running: it ended.
    expect(turnSpan(owned, { last: false, live: true })!.endedAt).toBe(3000);
    expect(turnSpan(owned, { last: true, live: false })!.endedAt).toBe(3000);
    // An answer, or a stop, closes it.
    expect(turnSpan([...owned, ev('agent_response', 4000, { prompt: 'here' })], { last: true, live: true })!.endedAt).toBe(4000);
    expect(turnSpan([...owned, ev('agent_stop', 5000)], { last: true, live: true })!.endedAt).toBe(5000);
  });

  it('has no span for a turn with no events', () => {
    expect(turnSpan([], done)).toBeNull();
  });

  it('a prompt recorded twice is one turn, and its range starts at the first copy', () => {
    const events = [
      ev('user_prompt', 1000, { prompt: 'plug the holes' }), ev('user_prompt', 1050, { prompt: 'plug the holes' }),
      ev('agent_response', 6000, { prompt: 'done' }),
    ];
    const [turn] = extractTurns(events);
    const owned = turn.eventIds.map((id) => events.find((e) => e.id === id)!);
    expect(turnRange(turnSpan(owned, done)!)).toEqual({ from: 0, to: 8000 });
  });
});

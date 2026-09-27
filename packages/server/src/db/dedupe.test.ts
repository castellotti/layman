import { describe, expect, it } from 'vitest';
import { planReplayDedupe, type DedupeRow } from './dedupe.js';

const row = (id: string, timestamp: number, data: Record<string, unknown>, over: Partial<DedupeRow> = {}): DedupeRow => ({
  id, session_id: 's1', type: 'user_prompt', timestamp, data_json: JSON.stringify(data), ...over,
});

describe('planReplayDedupe', () => {
  it('keeps the earliest copy of a replayed event and drops the rest', () => {
    const d = { prompt: 'search onion routing', transcriptAt: 1000 };
    const plan = planReplayDedupe([row('b', 5000, d), row('a', 2000, d), row('c', 9000, { ...d, transcriptEventId: 'x_u1' })]);
    expect(plan).toEqual({ ids: ['b', 'c'], sessions: 1 });
  });

  it('ignores what the watcher stamps at read time: a tool call\'s completedAt and access records', () => {
    const call = { toolName: 'web_search', toolInput: { query: 'q' }, toolOutput: 'r', transcriptAt: 1000, transcriptCompletedAt: 1500 };
    const plan = planReplayDedupe([
      row('a', 1, { ...call, completedAt: 10, urlAccess: [{ url: 'u', eventId: 'a', timestamp: 10 }] }, { type: 'tool_call_completed' }),
      row('b', 2, { ...call, completedAt: 20, urlAccess: [{ url: 'u', eventId: 'b', timestamp: 20 }] }, { type: 'tool_call_completed' }),
      // Another result is another call, even at the same transcript time.
      row('c', 3, { ...call, toolOutput: 'other', completedAt: 30 }, { type: 'tool_call_completed' }),
    ]);
    expect(plan.ids).toEqual(['b']);
  });

  it('never treats a genuine re-send (another transcript time) or another session or type as a copy', () => {
    const plan = planReplayDedupe([
      row('a', 1, { prompt: 'again', transcriptAt: 1000 }),
      row('b', 2, { prompt: 'again', transcriptAt: 7000 }),
      row('c', 3, { prompt: 'again', transcriptAt: 1000 }, { session_id: 's2' }),
      row('d', 4, { prompt: 'again', transcriptAt: 1000 }, { type: 'agent_response' }),
    ]);
    expect(plan.ids).toEqual([]);
  });

  it('leaves rows without a transcript time, and copies a highlight or answer points at', () => {
    const plan = planReplayDedupe([
      row('a', 1, { prompt: 'old build' }), row('b', 2, { prompt: 'old build' }),
      row('c', 3, { prompt: 'p', transcriptAt: 1 }), row('d', 4, { prompt: 'p', transcriptAt: 1 }), row('e', 5, { prompt: 'p', transcriptAt: 1 }),
    ], new Set(['d']));
    expect(plan.ids).toEqual(['e']);
  });
});

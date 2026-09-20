import { describe, it, expect } from 'vitest';
import { mergeRecordedWithLive } from './PreviewPane.js';
import type { TimelineEvent } from '../../lib/types.js';

function ev(id: string, type: string, timestamp: number, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return { id, type, timestamp, sessionId: 's', agentType: 'pi', data: {}, ...extra } as TimelineEvent;
}

describe('mergeRecordedWithLive', () => {
  it('returns the live tail unchanged when there is no recorded history', () => {
    const live = [ev('a', 'user_prompt', 1), ev('b', 'agent_response', 2)];
    expect(mergeRecordedWithLive([], live)).toBe(live);
  });

  it('places recorded history before live-only rows, preserving each order', () => {
    // A resumed session: 3 recorded turns in SQLite, then a fresh start + new turn
    // that exist only in the live store.
    const recorded = [ev('h1', 'user_prompt', 1), ev('h2', 'agent_response', 2), ev('h3', 'session_end', 3)];
    const live = [ev('s', 'session_start', 4), ev('n1', 'user_prompt', 5), ev('n2', 'agent_response', 6)];
    const merged = mergeRecordedWithLive(recorded, live);
    expect(merged.map((e) => e.id)).toEqual(['h1', 'h2', 'h3', 's', 'n1', 'n2']);
  });

  it('orders by timestamp when the recorded slice is NEWER than the live-only slice', () => {
    // Recording toggled on mid-session: SQLite holds only the later turns, while
    // the earlier ones are live-only. An append (recorded-then-live) would order
    // them backwards; the timestamp sort must interleave them correctly.
    const recorded = [ev('late1', 'user_prompt', 5), ev('late2', 'agent_response', 6)];
    const live = [ev('early1', 'user_prompt', 1), ev('early2', 'agent_response', 2), ev('late1', 'user_prompt', 5), ev('late2', 'agent_response', 6)];
    const merged = mergeRecordedWithLive(recorded, live);
    expect(merged.map((e) => e.id)).toEqual(['early1', 'early2', 'late1', 'late2']);
  });

  it('dedupes by id and lets the live copy win (so an event:update is not lost)', () => {
    // The same event is in both snapshots; the live one carries a later update.
    const recorded = [ev('h1', 'user_prompt', 1), ev('shared', 'tool_call_pending', 2)];
    const live = [ev('shared', 'tool_call_completed', 2, { data: { toolOutput: 'done' } }), ev('n1', 'agent_response', 3)];
    const merged = mergeRecordedWithLive(recorded, live);
    expect(merged.map((e) => e.id)).toEqual(['h1', 'shared', 'n1']);
    // The live version replaced the recorded one in place, not appended.
    expect(merged.find((e) => e.id === 'shared')?.type).toBe('tool_call_completed');
    expect(merged.filter((e) => e.id === 'shared')).toHaveLength(1);
  });
});

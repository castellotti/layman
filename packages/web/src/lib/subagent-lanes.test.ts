import { describe, it, expect } from 'vitest';
import { subagentLanes, SUBAGENT_TOKENS } from './subagent-lanes.js';
import type { TimelineEvent } from './types.js';

let seq = 0;
function ev(subagentId?: string, agentType?: string): TimelineEvent {
  seq += 1;
  return {
    id: `e${seq}`, sessionId: 's', timestamp: seq, type: 'tool_call_completed', agentType: 'claude-code',
    data: { toolName: 'Read', ...(subagentId ? { subagentId, agentType } : {}) },
  } as TimelineEvent;
}

describe('subagentLanes', () => {
  it('gives two interleaved subagents different numbers and colours, and the parent none', () => {
    const lanes = subagentLanes([ev(), ev('a', 'Explore'), ev('b', 'Explore'), ev('a', 'Explore'), ev(), ev('b', 'Explore')]);
    expect([...lanes.keys()]).toEqual(['a', 'b']);
    expect(lanes.get('a')).toEqual({ n: 1, token: SUBAGENT_TOKENS[0], label: 'Subagent 1 · Explore', chip: '1 Explore' });
    expect(lanes.get('b')).toEqual({ n: 2, token: SUBAGENT_TOKENS[1], label: 'Subagent 2 · Explore', chip: '2 Explore' });
  });

  it('keeps a subagent\'s number as later events arrive', () => {
    const early = [ev('a'), ev('b')];
    const later = [...early, ev('c', 'Plan'), ev('a')];
    expect(subagentLanes(later).get('b')?.n).toBe(subagentLanes(early).get('b')?.n);
    expect(subagentLanes(later).get('c')?.label).toBe('Subagent 3 · Plan');
  });

  it('labels a subagent with no type by its number alone', () => {
    expect(subagentLanes([ev('x')]).get('x')?.label).toBe('Subagent 1');
    expect(subagentLanes([ev('x')]).get('x')?.chip).toBe('sub 1');
  });

  it('reuses an unchanged lane from the last result, so memoized rows keep their props', () => {
    const early = [ev('a', 'Explore')];
    const prev = subagentLanes(early);
    const next = subagentLanes([...early, ev('b'), ev('a', 'Explore')], prev);
    expect(next.get('a')).toBe(prev.get('a'));
  });

  it('cycles the colours past the last one', () => {
    const ids = Array.from({ length: SUBAGENT_TOKENS.length + 1 }, (_, i) => `s${i}`);
    const lanes = subagentLanes(ids.map(id => ev(id)));
    expect(lanes.get(ids[SUBAGENT_TOKENS.length])?.token).toBe(SUBAGENT_TOKENS[0]);
  });

  it('uses no status colour', () => {
    for (const t of SUBAGENT_TOKENS) expect(['ok', 'warn', 'error', 'severity-major', 'severity-minor']).not.toContain(t);
  });
});

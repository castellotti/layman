import { describe, it, expect } from 'vitest';
import { subagentLanes, SUBAGENT_TOKENS } from './subagent-lanes.js';
import type { TimelineEvent } from './types.js';

let seq = 0;
function ev(subagentId?: string, agentType?: string, subagentN?: number): TimelineEvent {
  seq += 1;
  return {
    id: `e${seq}`, sessionId: 's', timestamp: seq, type: 'tool_call_completed', agentType: 'claude-code',
    data: { toolName: 'Read', ...(subagentId ? { subagentId, agentType, ...(subagentN ? { subagentN } : {}) } : {}) },
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

  it('takes the type from the first event that names one', () => {
    expect(subagentLanes([ev('x'), ev('x', 'Plan')]).get('x')?.label).toBe('Subagent 1 · Plan');
  });

  it('reuses an unchanged lane from the last result, so memoized rows keep their props', () => {
    const early = [ev('a', 'Explore')];
    const prev = subagentLanes(early);
    const next = subagentLanes([...early, ev('b'), ev('a', 'Explore')], prev);
    expect(next.get('a')).toBe(prev.get('a'));
  });

  it('takes the server\'s number, whatever window of the session it is given', () => {
    // Subagent 1 has scrolled out of this window; 2 and 3 keep their numbers and colours.
    const lanes = subagentLanes([ev('b', 'Explore', 2), ev('c', 'Plan', 3)]);
    expect(lanes.get('b')).toMatchObject({ n: 2, token: SUBAGENT_TOKENS[1], chip: '2 Explore' });
    expect(lanes.get('c')).toMatchObject({ n: 3, token: SUBAGENT_TOKENS[2] });
  });

  it('gives unnumbered (older) subagents the lowest numbers no numbered one holds', () => {
    const lanes = subagentLanes([ev('old1'), ev('new', 'Explore', 1), ev('old2')]);
    expect(lanes.get('new')?.n).toBe(1);
    expect(lanes.get('old1')?.n).toBe(2);
    expect(lanes.get('old2')?.n).toBe(3);
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

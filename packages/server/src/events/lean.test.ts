import { describe, expect, it } from 'vitest';
import { leanEvent } from './lean.js';
import type { TimelineEvent } from './types.js';

const event = (data: TimelineEvent['data']): TimelineEvent =>
  ({ id: 'e', type: 'tool_call_completed', timestamp: 1, sessionId: 's', agentType: 'claude-code', data }) as TimelineEvent;

describe('leanEvent', () => {
  it('drops the output, transcript, reasoning and summary, and keeps what says what happened', () => {
    const lean = leanEvent(event({ toolName: 'Read', toolInput: { file_path: '/a' }, toolOutput: 'x'.repeat(1000), completedAt: 2, thinking: 't', subagentTranscript: [], compactSummary: 's' }));
    expect(lean.data).toEqual({ toolName: 'Read', toolInput: { file_path: '/a' }, completedAt: 2 });
  });

  it('returns an event with nothing to drop as it is', () => {
    const e = event({ prompt: 'hi' });
    expect(leanEvent(e)).toBe(e);
  });
});

import { describe, it, expect } from 'vitest';
import type { TimelineEvent } from '../events/types.js';
import { assembleContext, eventSubject, CONVERSATION_BUDGET, IN_CONVERSATION, RECENT_EVENTS_WINDOW } from './context.js';

let n = 0;
function ev(type: TimelineEvent['type'], data: TimelineEvent['data'] = {}): TimelineEvent {
  n++;
  return { id: `e${n}`, type, timestamp: n, sessionId: 's', data } as TimelineEvent;
}
const tool = (cmd: string) => ev('tool_call_completed', { toolName: 'Bash', toolInput: { command: cmd } });

describe('eventSubject', () => {
  it('is the tool call for a tool event', () => {
    const e = tool('ls');
    expect(eventSubject(e)).toEqual({ toolName: 'Bash', toolInput: { command: 'ls' }, toolOutput: undefined });
  });

  it('names a prompt or response by its type and carries its text', () => {
    // Without the text, every response was asked about as `Unknown` with `{}`, and the
    // analysis cache (keyed on those two) answered every response with the first one's result.
    const a = eventSubject(ev('agent_response', { prompt: 'Done: fixed the bug.' }));
    const b = eventSubject(ev('agent_response', { prompt: 'Something else.' }));
    expect(a).toEqual({ toolName: 'agent_response', toolInput: { text: 'Done: fixed the bug.' } });
    expect(JSON.stringify(a.toolInput)).not.toBe(JSON.stringify(b.toolInput));
    expect(eventSubject(ev('user_prompt', { prompt: 'fix it' })).toolInput).toEqual({ text: 'fix it' });
  });
});

describe('assembleContext', () => {
  it('uses only the events before the investigated one', () => {
    const p = ev('user_prompt', { prompt: 'please list files' });
    const t = tool('ls');
    const later = ev('user_prompt', { prompt: 'a later question' });
    const ctx = assembleContext([p, t, later], t.id);
    expect(ctx.recentEvents.map((r) => r.type)).toEqual(['user_prompt']);
    expect(ctx.conversation).toEqual([{ type: 'user_prompt', text: 'please list files' }]);
    // Its text is sent once, in the conversation; the recent events only mark where it was.
    expect(ctx.recentEvents[0].summary).toBe(IN_CONVERSATION);
    expect(ctx.older).toEqual([]);
  });

  it('keeps the whole conversation even when the prompt is outside the recent window', () => {
    const p = ev('user_prompt', { prompt: 'refactor the parser' });
    const tools = Array.from({ length: RECENT_EVENTS_WINDOW + 5 }, (_, i) => tool(`cmd ${i}`));
    const target = tool('rm -rf build');
    const ctx = assembleContext([p, ...tools, target], target.id);
    expect(ctx.recentEvents).toHaveLength(RECENT_EVENTS_WINDOW);
    expect(ctx.recentEvents.every((r) => r.type === 'tool_call_completed')).toBe(true);
    expect(ctx.conversation).toEqual([{ type: 'user_prompt', text: 'refactor the parser' }]);
    expect(ctx.older).toHaveLength(6);
  });

  it('keeps the newest prompts and responses within the budget, in reading order', () => {
    const turns = Array.from({ length: 40 }, (_, i) => [
      ev('user_prompt', { prompt: `prompt ${i} ${'x'.repeat(600)}` }),
      ev('agent_response', { prompt: `answer ${i} ${'y'.repeat(600)}` }),
    ]).flat();
    const target = tool('ls');
    const ctx = assembleContext([...turns, target], target.id);
    const total = ctx.conversation.reduce((a, c) => a + c.text.length, 0);
    expect(total).toBeLessThanOrEqual(CONVERSATION_BUDGET);
    expect(ctx.conversation[ctx.conversation.length - 1].text.startsWith('answer 39')).toBe(true);
    expect(ctx.conversation.some((c) => c.text.startsWith('prompt 0 '))).toBe(false);
  });

  it('treats an unknown id as the latest event (the session tail)', () => {
    const p = ev('user_prompt', { prompt: 'hi' });
    const ctx = assembleContext([p], 'not-here');
    expect(ctx.conversation).toHaveLength(1);
  });
});

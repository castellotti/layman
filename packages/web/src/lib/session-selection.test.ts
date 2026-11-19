import { describe, it, expect } from 'vitest';
import { awaitingGloves, gloveLaymanSession, selectGlove, viewTarget } from './session-selection.js';
import type { SessionInfo } from './ws-protocol.js';

const s = (sessionId: string, lastSeen: number, sessionName?: string) =>
  ({ sessionId, cwd: '/w', lastSeen, agentType: 'pi', sessionName }) as unknown as SessionInfo;

describe('session selection', () => {
  const sessions = [s('a', 1, 'g-1'), s('b', 3, 'g-1'), s('c', 2)];

  it('a glove’s Layman session is its newest one by name', () => {
    expect(gloveLaymanSession('g-1', sessions)).toBe('b');
    expect(gloveLaymanSession('g-2', sessions)).toBeNull();
  });

  it('choosing a glove gives its session, else waits for it', () => {
    expect(selectGlove('g-1', sessions)).toEqual({ activeSessionId: 'b', awaitingGlove: null });
    expect(selectGlove('g-2', sessions)).toEqual({ activeSessionId: null, awaitingGlove: 'g-2' });
  });

  it('lists live gloves with no Layman session, and the awaited one even when it is not live', () => {
    const gloves = [{ token: 'g-1', live: true }, { token: 'g-2', live: true }, { token: 'g-3', live: false }];
    expect(awaitingGloves(gloves, sessions, null)).toEqual(['g-2']);
    expect(awaitingGloves(gloves, sessions, 'g-3')).toEqual(['g-2', 'g-3']);
    expect(awaitingGloves(gloves, sessions, 'g-1')).toEqual(['g-2']);
  });

  it('a tab shows the open session, else the awaited glove, else the fallback', () => {
    expect(viewTarget('a', 'g-2', sessions)).toEqual({ sessionId: 'a', glove: null });
    expect(viewTarget(null, 'g-2', sessions)).toEqual({ sessionId: null, glove: 'g-2' });
    expect(viewTarget(null, null, sessions).glove).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { orderDashboardSessions } from './session-state.js';
import type { SessionInfo } from './ws-protocol.js';

const s = (sessionId: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ sessionId, cwd: `/w/${sessionId}`, lastSeen: 0, agentType: 'pi', ...over });
const ids = (xs: SessionInfo[]) => xs.map((x) => x.sessionId);

describe('orderDashboardSessions', () => {
  const all = [s('a', { lastSeen: 1 }), s('b', { lastSeen: 3 }), s('c', { lastSeen: 2, active: false }), s('d', { lastSeen: 4 })];
  it('lists live, undismissed sessions, most recently active first', () => {
    expect(ids(orderDashboardSessions(all, { dismissed: new Set(['d']), sortMode: 'recent', order: [] }))).toEqual(['b', 'a']);
  });
  it('follows a dragged order, unknown sessions last', () => {
    expect(ids(orderDashboardSessions(all, { dismissed: new Set(), sortMode: 'custom', order: ['a', 'd'] }))).toEqual(['a', 'd', 'b']);
  });
  it('filters by name, cwd or id', () => {
    const named = [...all, s('e', { sessionName: 'pi-search-abc123', lastSeen: 9 })];
    expect(ids(orderDashboardSessions(named, { dismissed: new Set(), sortMode: 'recent', order: [], filter: ' SEARCH ' }))).toEqual(['e']);
    expect(ids(orderDashboardSessions(named, { dismissed: new Set(), sortMode: 'recent', order: [], filter: '/w/a' }))).toEqual(['a']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from './sessionStore.js';
import type { SessionInfo } from '../lib/ws-protocol.js';
import type { SyncStatus, HostStats } from '../lib/types.js';

beforeEach(() => {
  useSessionStore.setState({ sessions: [], activeSessionId: null, syncStatus: null, syncHosts: [], config: null });
});

const local = (id: string): SessionInfo => ({ sessionId: id, cwd: '/x', lastSeen: 1, agentType: 'claude-code', active: true });
const remote = (id: string): SessionInfo => ({
  sessionId: id, cwd: '/y', lastSeen: 2, agentType: 'pi', active: true,
  hostId: 'remote-host', hostName: 'Workstation', remote: true,
});

describe('setSessions preserves host attribution', () => {
  it('keeps hostId/hostName/remote on merged remote sessions', () => {
    useSessionStore.getState().setSessions([local('s1'), remote('s2')]);
    const merged = useSessionStore.getState().sessions;
    const s2 = merged.find((s) => s.sessionId === 's2')!;
    expect(s2).toMatchObject({ hostId: 'remote-host', hostName: 'Workstation', remote: true });
    const s1 = merged.find((s) => s.sessionId === 's1')!;
    expect(s1.remote).toBeUndefined();
  });

  it('a later list without host fields drops them (server is source of truth)', () => {
    useSessionStore.getState().setSessions([remote('s2')]);
    useSessionStore.getState().setSessions([{ ...remote('s2'), hostId: undefined, hostName: undefined, remote: undefined }]);
    const s2 = useSessionStore.getState().sessions.find((s) => s.sessionId === 's2')!;
    expect(s2.remote).toBeUndefined();
  });
});

describe('sync status and hosts setters', () => {
  it('stores the latest sync status', () => {
    const status: SyncStatus = {
      role: 'remote', hostId: 'h', hostName: 'box', state: 'backfill', backlog: 42,
      pushAckedSeq: null, backfillKind: 'event', lastSuccessAt: null, lastError: null,
    };
    useSessionStore.getState().setSyncStatus(status);
    expect(useSessionStore.getState().syncStatus).toEqual(status);
  });

  it('stores the hosts table', () => {
    const hosts: HostStats[] = [
      { hostId: 'h', name: 'box', kind: 'local', platform: null, laymanVersion: null, firstSeen: 1, lastSeen: 2, sessionCount: 3, eventCount: 9, contentBytes: 100, firstActivity: 1, lastActivity: 2 },
    ];
    useSessionStore.getState().setSyncHosts(hosts);
    expect(useSessionStore.getState().syncHosts).toEqual(hosts);
  });
});

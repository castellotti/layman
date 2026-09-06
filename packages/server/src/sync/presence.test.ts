import { describe, it, expect } from 'vitest';
import { RemoteSessionRegistry } from './presence.js';
import type { PushBatch, PushEntry, PresencePayload } from './protocol.js';

const HOST = 'remote-1';
const NAME = 'Workstation';

function eventEntry(id: string, sessionId: string, timestamp: number): PushEntry {
  return {
    op: 'upsert', kind: 'event', id,
    row: {
      id, session_id: sessionId, type: 'user_prompt', timestamp, agent_type: 'pi',
      data_json: JSON.stringify({ prompt: 'hi' }), analysis_json: null, laymans_json: null, risk_level: null,
    },
  };
}

function presence(activeIds: string[], now: number): PresencePayload {
  return {
    activeSessionIds: activeIds,
    sessions: activeIds.map((id) => ({ sessionId: id, cwd: '/w', agentType: 'pi', sessionName: 'sesh', lastSeen: now })),
  };
}

function batch(entries: PushEntry[], live?: PresencePayload): PushBatch {
  return { hostId: HOST, entries, live };
}

describe('RemoteSessionRegistry', () => {
  it('surfaces active remote sessions with host attribution', () => {
    let now = 1_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    reg.ingestPush(HOST, NAME, batch([], presence(['s1'], now)));

    const list = reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sessionId: 's1', hostId: HOST, hostName: NAME, remote: true, active: true });
  });

  it('marks a session idle once presence is older than 3× the interval', () => {
    let now = 1_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    reg.setInterval(HOST, 5); // TTL = 15s
    reg.ingestPush(HOST, NAME, batch([], presence(['s1'], now)));
    reg.setInterval(HOST, 5);

    now += 10_000;
    expect(reg.list()[0].active).toBe(true);
    now += 6_000; // 16s since last push > 15s TTL
    expect(reg.list()[0].active).toBe(false);
  });

  it('appends recent events for active sessions to the ring and returns them', () => {
    let now = 2_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    const emitted = reg.ingestPush(HOST, NAME, batch(
      [eventEntry('e1', 's1', now - 1000), eventEntry('e2', 's1', now - 500)],
      presence(['s1'], now),
    ));
    expect(emitted.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(reg.replayEvents().map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('ignores events older than the 10-minute live-tail window (e.g. backfill)', () => {
    let now = 3_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    const emitted = reg.ingestPush(HOST, NAME, batch(
      [eventEntry('old', 's1', now - 11 * 60 * 1000), eventEntry('new', 's1', now - 1000)],
      presence(['s1'], now),
    ));
    expect(emitted.map((e) => e.id)).toEqual(['new']);
  });

  it('ignores events for sessions not in the active set', () => {
    let now = 4_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    const emitted = reg.ingestPush(HOST, NAME, batch(
      [eventEntry('e1', 's-inactive', now)],
      presence(['s-active'], now),
    ));
    expect(emitted).toEqual([]);
  });

  it('caps the ring at 50 events, keeping the newest', () => {
    let now = 5_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    const entries: PushEntry[] = [];
    for (let i = 0; i < 60; i++) entries.push(eventEntry(`e${i}`, 's1', now - (60 - i)));
    reg.ingestPush(HOST, NAME, batch(entries, presence(['s1'], now)));
    const ring = reg.replayEvents();
    expect(ring).toHaveLength(50);
    expect(ring[0].id).toBe('e10');
    expect(ring[49].id).toBe('e59');
  });

  it('dedupes an event already in the ring', () => {
    let now = 6_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    reg.ingestPush(HOST, NAME, batch([eventEntry('e1', 's1', now)], presence(['s1'], now)));
    const second = reg.ingestPush(HOST, NAME, batch([eventEntry('e1', 's1', now)], presence(['s1'], now)));
    expect(second).toEqual([]);
    expect(reg.replayEvents()).toHaveLength(1);
  });

  it('does not replay rings for a stale host', () => {
    let now = 7_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    reg.setInterval(HOST, 5);
    reg.ingestPush(HOST, NAME, batch([eventEntry('e1', 's1', now)], presence(['s1'], now)));
    reg.setInterval(HOST, 5);
    now += 20_000;
    expect(reg.replayEvents()).toEqual([]);
  });

  it('sorts sessions across hosts by recency (newest first)', () => {
    let now = 8_000_000;
    const reg = new RemoteSessionRegistry(() => now);
    reg.ingestPush('h1', 'A', { hostId: 'h1', entries: [], live: { activeSessionIds: ['old'], sessions: [{ sessionId: 'old', cwd: '', agentType: 'pi', lastSeen: now - 100 }] } });
    reg.ingestPush('h2', 'B', { hostId: 'h2', entries: [], live: { activeSessionIds: ['new'], sessions: [{ sessionId: 'new', cwd: '', agentType: 'pi', lastSeen: now }] } });
    expect(reg.list().map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

import { describe, expect, it } from 'vitest';
import { entryLabel, pickSession, pulsesOf, PULSE_MS, shortCount } from './activity-view.js';
import type { Board, BoardEntry } from './activity-board.js';
import { NO_SETUP } from './station.js';
import type { TimelineEvent } from './types.js';
import type { SessionInfo } from './ws-protocol.js';

const session = (sessionId: string, lastSeen: number, active = true): SessionInfo => ({ sessionId, cwd: '/', lastSeen, agentType: 'pi', active });

describe('pickSession', () => {
  it('follows the open session, else the newest live one, else the newest', () => {
    const sessions = [session('a', 5, false), session('b', 3), session('c', 4)];
    expect(pickSession('x', sessions)).toBe('x');
    expect(pickSession(null, sessions)).toBe('c');
    expect(pickSession(null, [session('a', 5, false), session('b', 3, false)])).toBe('a');
    expect(pickSession(null, [])).toBeNull();
  });
});

const board = (entries: BoardEntry[]): Board => ({ entries, counts: {}, pushed: 0, faults: {}, agents: 0, turns: 0 });
const entry = (station: BoardEntry['station'], startedAt: number, extra: Partial<BoardEntry> = {}): BoardEntry => ({
  eventId: `e${startedAt}${station}`, station, from: 'core', status: 'ok', startedAt, endedAt: startedAt + 300, ...extra,
});

describe('pulsesOf', () => {
  it('flies a call out when it starts and back when it ends, and nothing once both are over', () => {
    const b = board([entry('files', 1000)]);
    expect(pulsesOf(b, 1100).map((p) => [p.kind, p.age])).toEqual([['out', 100]]);
    expect(pulsesOf(b, 1400).map((p) => [p.kind, p.age])).toEqual([['out', 400], ['in', 100]]);
    expect(pulsesOf(b, 1300 + PULSE_MS)).toEqual([]);
  });

  it('loops a running call for as long as it runs', () => {
    const b = board([entry('shell', 0, { status: 'run', endedAt: undefined })]);
    expect(pulsesOf(b, 60_000)).toMatchObject([{ kind: 'run', station: 'shell', age: 60_000 }]);
  });

  it('flies what was pushed in towards the core, hollow, with no return', () => {
    const b = board([entry('memory', 1000, { from: 'inbound', endedAt: 1000 })]);
    expect(pulsesOf(b, 1100)).toMatchObject([{ kind: 'in', hollow: true }]);
  });

  it("starts a subagent's call from the Agents station, and marks a refusal", () => {
    const b = board([entry('files', 1000, { from: 'agents', status: 'block' })]);
    expect(pulsesOf(b, 1050)[0]).toMatchObject({ from: 'agents', bad: true });
  });

  it('puts pulses on one spoke at one moment in lanes', () => {
    const b = board([
      entry('files', 0, { status: 'run', endedAt: undefined }),
      entry('files', 1, { status: 'run', endedAt: undefined }),
      entry('files', 2, { status: 'run', endedAt: undefined }),
      entry('shell', 3, { status: 'run', endedAt: undefined }),
    ]);
    expect(pulsesOf(b, 10).map((p) => p.lane)).toEqual([-5, 0, 5, 0]);
  });

  it('draws at most the newest 14', () => {
    const b = board(Array.from({ length: 30 }, (_, i) => entry('files', i, { status: 'run', endedAt: undefined })));
    const p = pulsesOf(b, 100);
    expect(p).toHaveLength(14);
    expect(p[13].key).toBe('e29files:run');
  });
});

describe('shortCount', () => {
  it('fits a count in a few characters', () => {
    expect([0, 999, 1000, 1250, 9999, 12_345].map(shortCount)).toEqual(['0', '999', '1k', '1.3k', '10k', '12k']);
  });
});

describe('entryLabel', () => {
  const ev = (data: TimelineEvent['data'], type: TimelineEvent['type'] = 'tool_call_completed'): TimelineEvent =>
    ({ id: 'e', type, timestamp: 1, sessionId: 's', agentType: 'claude-code', data });

  it('says what the Logs row says, or with names only just the name', () => {
    const bash = ev({ toolName: 'Bash', toolInput: { command: 'curl -H "Authorization: x" https://api.example.dev/v1' } });
    expect(entryLabel(bash, 'network', false, NO_SETUP)).toContain('curl -H');
    expect(entryLabel(bash, 'network', true, NO_SETUP)).toBe('curl');
    const prompt = ev({ prompt: 'my secret plan' }, 'user_prompt');
    expect(entryLabel(prompt, 'you', false, NO_SETUP)).toBe('my secret plan');
    expect(entryLabel(prompt, 'you', true, NO_SETUP)).not.toContain('secret');
  });

  it("falls back to the station's name for an event it no longer has", () => {
    expect(entryLabel(undefined, 'guard', false, NO_SETUP)).toBe('Guard');
  });
});

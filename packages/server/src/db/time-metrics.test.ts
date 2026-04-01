import { describe, it, expect } from 'vitest';
import { computeTimeMetrics } from './time-metrics.js';
import type { TimelineEvent } from '../events/types.js';

function makeEvent(
  overrides: Partial<TimelineEvent> & { type: TimelineEvent['type']; timestamp: number },
): TimelineEvent {
  return {
    id: `evt-${overrides.timestamp}`,
    sessionId: 'test-session',
    agentType: 'claude-code',
    data: {},
    ...overrides,
  };
}

describe('computeTimeMetrics', () => {
  it('returns zeros for empty events', () => {
    const result = computeTimeMetrics([], 5);
    expect(result).toEqual({
      wallClockMs: 0,
      agentActiveMs: 0,
      userActiveMs: 0,
      idleMs: 0,
      idleThresholdMinutes: 5,
    });
  });

  it('returns zeros for single event', () => {
    const events = [makeEvent({ type: 'session_start', timestamp: 1000 })];
    const result = computeTimeMetrics(events, 5);
    expect(result.wallClockMs).toBe(0);
    expect(result.agentActiveMs).toBe(0);
    expect(result.userActiveMs).toBe(0);
    expect(result.idleMs).toBe(0);
  });

  it('classifies tool call with completedAt as agent time', () => {
    const events = [
      makeEvent({
        type: 'tool_call_pending',
        timestamp: 0,
        data: { toolName: 'Bash', completedAt: 5000 },
      }),
      makeEvent({ type: 'tool_call_completed', timestamp: 5000, data: { toolName: 'Bash' } }),
    ];
    const result = computeTimeMetrics(events, 5);
    expect(result.wallClockMs).toBe(5000);
    expect(result.agentActiveMs).toBe(5000);
    expect(result.userActiveMs).toBe(0);
    expect(result.idleMs).toBe(0);
  });

  it('classifies gap before user_prompt as user time', () => {
    const events = [
      makeEvent({ type: 'agent_response', timestamp: 0 }),
      makeEvent({ type: 'user_prompt', timestamp: 30000, data: { prompt: 'hello' } }),
    ];
    const result = computeTimeMetrics(events, 5);
    expect(result.wallClockMs).toBe(30000);
    expect(result.userActiveMs).toBe(30000);
    expect(result.agentActiveMs).toBe(0);
    expect(result.idleMs).toBe(0);
  });

  it('classifies long gap as idle', () => {
    // Gap of 10 minutes (600000ms) > 5 min threshold
    const events = [
      makeEvent({ type: 'agent_response', timestamp: 0 }),
      makeEvent({ type: 'user_prompt', timestamp: 600000, data: { prompt: 'back' } }),
    ];
    const result = computeTimeMetrics(events, 5);
    expect(result.wallClockMs).toBe(600000);
    expect(result.idleMs).toBe(600000);
    expect(result.agentActiveMs).toBe(0);
    expect(result.userActiveMs).toBe(0);
  });

  it('handles mixed agent and user segments', () => {
    const events = [
      // Agent runs a tool (0 -> 3000)
      makeEvent({
        type: 'tool_call_pending',
        timestamp: 0,
        data: { toolName: 'Bash', completedAt: 3000 },
      }),
      makeEvent({ type: 'tool_call_completed', timestamp: 3000, data: { toolName: 'Bash' } }),
      // Agent produces response (3000 -> 4000)
      makeEvent({ type: 'agent_response', timestamp: 4000 }),
      // User thinks for 20 seconds (4000 -> 24000)
      makeEvent({ type: 'user_prompt', timestamp: 24000, data: { prompt: 'next' } }),
      // Agent does another tool call (24000 -> 26000)
      makeEvent({
        type: 'tool_call_pending',
        timestamp: 26000,
        data: { toolName: 'Read', completedAt: 28000 },
      }),
      makeEvent({ type: 'tool_call_completed', timestamp: 28000, data: { toolName: 'Read' } }),
    ];

    const result = computeTimeMetrics(events, 5);
    expect(result.wallClockMs).toBe(28000);
    // Agent: 3000 (first tool completedAt) + 1000 (3000->4000 gap to agent_response) + 2000 (second tool) + 2000 (24000->26000 gap to tool_call_pending)
    expect(result.agentActiveMs).toBe(3000 + 1000 + 2000 + 2000);
    // User: 20000 (4000->24000 gap before user_prompt)
    expect(result.userActiveMs).toBe(20000);
    expect(result.idleMs).toBe(0);
  });

  it('respects configurable idle threshold', () => {
    // 3-minute gap with 2-minute threshold -> idle
    // 3-minute gap with 5-minute threshold -> user
    const events = [
      makeEvent({ type: 'agent_response', timestamp: 0 }),
      makeEvent({ type: 'user_prompt', timestamp: 180000, data: { prompt: 'test' } }),
    ];

    const strict = computeTimeMetrics(events, 2);
    expect(strict.idleMs).toBe(180000);
    expect(strict.userActiveMs).toBe(0);

    const relaxed = computeTimeMetrics(events, 5);
    expect(relaxed.idleMs).toBe(0);
    expect(relaxed.userActiveMs).toBe(180000);
  });

  it('handles the example session from the issue', () => {
    // Simulating the user's example timeline:
    // 1. 23:20:46 — tool_call_completed (Bash, /layman activation)
    // 2. 23:20:50 — agent_response
    // 3. 23:21:15 — user_prompt (cancelled)
    // 4. 23:37:19 — user_prompt (actual prompt, 16min gap)
    // 5. 23:37:26 — tool_call_completed (Bash, git checkout)

    const base = new Date('2024-01-01T23:20:46').getTime();
    const events = [
      makeEvent({
        type: 'tool_call_completed',
        timestamp: base,
        data: { toolName: 'Bash' },
      }),
      makeEvent({
        type: 'agent_response',
        timestamp: base + 4000, // +4s
      }),
      makeEvent({
        type: 'user_prompt',
        timestamp: base + 29000, // +29s from start
        data: { prompt: 'cancelled prompt' },
      }),
      makeEvent({
        type: 'user_prompt',
        timestamp: base + 993000, // +16m33s from start
        data: { prompt: 'actual prompt' },
      }),
      makeEvent({
        type: 'tool_call_completed',
        timestamp: base + 1000000, // +16m40s from start
        data: { toolName: 'Bash' },
      }),
    ];

    const result = computeTimeMetrics(events, 5);

    // Wall clock: ~16m40s
    expect(result.wallClockMs).toBe(1000000);

    // The 16min gap (29000 -> 993000 = 964000ms) should be idle (> 5min)
    expect(result.idleMs).toBeGreaterThan(0);

    // Agent active: 4000 (tool_call_completed -> agent_response) + 7000 (993000 -> 1000000, gap to tool_call_completed)
    // User active: 25000 (4000 -> 29000, gap before first user_prompt)
    expect(result.agentActiveMs).toBeGreaterThan(0);
    expect(result.userActiveMs).toBeGreaterThan(0);

    // Verify it all adds up
    expect(result.agentActiveMs + result.userActiveMs + result.idleMs).toBe(result.wallClockMs);
  });

  it('ensures metrics always sum to wallClockMs', () => {
    const events = [
      makeEvent({ type: 'session_start', timestamp: 0 }),
      makeEvent({
        type: 'tool_call_pending',
        timestamp: 1000,
        data: { toolName: 'Bash', completedAt: 5000 },
      }),
      makeEvent({ type: 'tool_call_completed', timestamp: 5000, data: { toolName: 'Bash' } }),
      makeEvent({ type: 'agent_response', timestamp: 6000 }),
      makeEvent({ type: 'user_prompt', timestamp: 20000, data: { prompt: 'test' } }),
      makeEvent({
        type: 'tool_call_pending',
        timestamp: 21000,
        data: { toolName: 'Read', completedAt: 22000 },
      }),
      makeEvent({ type: 'tool_call_completed', timestamp: 22000, data: { toolName: 'Read' } }),
      makeEvent({ type: 'agent_response', timestamp: 23000 }),
      // 10 minute gap -> idle
      makeEvent({ type: 'user_prompt', timestamp: 623000, data: { prompt: 'back' } }),
      makeEvent({ type: 'session_end', timestamp: 624000 }),
    ];

    const result = computeTimeMetrics(events, 5);
    expect(result.agentActiveMs + result.userActiveMs + result.idleMs).toBe(result.wallClockMs);
  });

  it('classifies gap before tool_call_approved as user time', () => {
    const events = [
      makeEvent({ type: 'tool_call_pending', timestamp: 0, data: { toolName: 'Bash' } }),
      makeEvent({ type: 'tool_call_approved', timestamp: 10000, data: { toolName: 'Bash' } }),
    ];
    const result = computeTimeMetrics(events, 5);
    // tool_call_approved is in both AGENT_ACTIVE and USER_ACTION sets;
    // since it's a user action, classify as user
    expect(result.userActiveMs).toBe(10000);
  });
});

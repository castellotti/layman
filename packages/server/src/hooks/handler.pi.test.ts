import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHookHandler } from './handler.js';
import { PendingApprovalManager } from './pending.js';
import { SessionGate } from './gate.js';
import { EventStore } from '../events/store.js';
import { AnalysisEngine } from '../analysis/engine.js';
import { LaymanConfigSchema, type LaymanConfig } from '../config/schema.js';
import { LiveStreamStore } from '../stream/live.js';

/**
 * End-to-end coverage of the pi arm of the hook handler's agent-type allow-list.
 *
 * These go through a real Fastify `inject()` rather than calling the private
 * handlers, because the thing under test — `agentType` resolution — happens in
 * the route body before any handler is reached, and an unrecognised agent_type
 * fails by being silently recorded as claude-code rather than by throwing.
 */

const SESSION = 'pi-session-1';
const CWD = '/Users/sc/development/ai/pi-local';

interface Harness {
  app: FastifyInstance;
  store: EventStore;
  gate: SessionGate;
  pending: PendingApprovalManager;
  config: LaymanConfig;
}

function makeHarness(overrides: Partial<LaymanConfig> = {}): Harness {
  const app = Fastify();
  const store = new EventStore();
  const gate = new SessionGate();
  const pending = new PendingApprovalManager(1);
  const config = LaymanConfigSchema.parse({ autoApprove: 'none', ...overrides });

  registerHookHandler(app, pending, store, new AnalysisEngine(), () => config, gate);
  return { app, store, gate, pending, config };
}

function piBody(eventName: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: SESSION,
    cwd: CWD,
    hook_event_name: eventName,
    transcript_path: '/tmp/pi-session.jsonl',
    permission_mode: 'default',
    agent_type: 'pi',
    ...extra,
  };
}

let h: Harness;

beforeEach(() => {
  h = makeHarness();
});

describe('pi agent-type resolution', () => {
  it('records pi events as pi, not claude-code', async () => {
    h.gate.activate(SESSION);

    await h.app.inject({
      method: 'POST',
      url: '/hooks/UserPromptSubmit',
      payload: piBody('UserPromptSubmit', { prompt: 'write a linked list' }),
    });

    const events = h.store.getAll().filter((e) => e.type === 'user_prompt');
    expect(events).toHaveLength(1);
    expect(events[0].agentType).toBe('pi');
  });

  it('tracks the session under the pi agent type', async () => {
    h.gate.activate(SESSION);

    await h.app.inject({
      method: 'POST',
      url: '/hooks/SessionStart',
      payload: piBody('SessionStart', { source: 'startup' }),
    });

    const session = h.store.getSessions().find((s) => s.sessionId === SESSION);
    expect(session?.agentType).toBe('pi');
    expect(session?.cwd).toBe(CWD);
  });

  it('still falls back to claude-code for an unknown agent_type', async () => {
    h.gate.activate(SESSION);

    await h.app.inject({
      method: 'POST',
      url: '/hooks/UserPromptSubmit',
      payload: { ...piBody('UserPromptSubmit', { prompt: 'hi' }), agent_type: 'not-a-harness' },
    });

    const events = h.store.getAll().filter((e) => e.type === 'user_prompt');
    expect(events[0].agentType).toBe('claude-code');
  });
});

describe('pi agent responses', () => {
  beforeEach(() => { h.gate.activate(SESSION); });

  it('stores harness-split reasoning as data.thinking', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/hooks/AgentResponse',
      payload: piBody('AgentResponse', {
        response: 'Reverse it iteratively.',
        thinking: 'A linked list reversal needs three pointers.',
      }),
    });

    const [event] = h.store.getAll().filter((e) => e.type === 'agent_response');
    expect(event.data.prompt).toBe('Reverse it iteratively.');
    expect(event.data.thinking).toBe('A linked list reversal needs three pointers.');
  });

  it('omits data.thinking entirely when the harness sends none', async () => {
    // '' would be indistinguishable from "pre-split, no reasoning" downstream,
    // which would suppress the inline <thinking> parsing other harnesses need.
    await h.app.inject({
      method: 'POST',
      url: '/hooks/AgentResponse',
      payload: piBody('AgentResponse', { response: 'plain', thinking: '' }),
    });

    const [event] = h.store.getAll().filter((e) => e.type === 'agent_response');
    expect(event.data.thinking).toBeUndefined();
  });

  it('records a full pi turn that splits into prompt, response and thinking', async () => {
    // autoApprove 'all' so PreToolUse resolves without suspending — the shape a
    // real pi session has, since approvals are off for pi by default.
    const auto = makeHarness({ autoApprove: 'all' });
    auto.gate.activate(SESSION);
    const post = (url: string, payload: object) => auto.app.inject({ method: 'POST', url, payload });

    await post('/hooks/UserPromptSubmit', piBody('UserPromptSubmit', { prompt: 'reverse a list' }));
    await post('/hooks/PreToolUse', piBody('PreToolUse', {
      tool_name: 'Write', tool_input: { path: 'notes.md', content: 'x' },
    }));
    await post('/hooks/PostToolUse', piBody('PostToolUse', {
      tool_name: 'Write', tool_input: { path: 'notes.md', content: 'x' }, tool_output: 'ok',
    }));
    await post('/hooks/AgentResponse', piBody('AgentResponse', {
      response: 'Written to notes.md.', thinking: 'three pointers',
    }));
    await post('/hooks/Stop', piBody('Stop'));

    const { extractTurns } = await import('../turns/extract.js');
    const turns = extractTurns(auto.store.getAll());

    expect(turns).toHaveLength(1);
    expect(turns[0].promptText).toBe('reverse a list');
    expect(turns[0].responseText).toBe('Written to notes.md.');
    expect(turns[0].thinkingText).toBe('three pointers');
    expect(turns[0].toolCallCount).toBe(1);
    expect(turns[0].agentType).toBe('pi');
  });

  it('treats the last of several interstitial responses as the turn answer', async () => {
    // pi fires message_end for every assistant message, including the ones
    // between tool calls. The turn model takes the final one.
    const post = (url: string, payload: object) => h.app.inject({ method: 'POST', url, payload });

    await post('/hooks/UserPromptSubmit', piBody('UserPromptSubmit', { prompt: 'do the thing' }));
    await post('/hooks/AgentResponse', piBody('AgentResponse', { response: 'Let me look.' }));
    await post('/hooks/PostToolUse', piBody('PostToolUse', {
      tool_name: 'Read', tool_input: {}, tool_output: 'contents',
    }));
    await post('/hooks/AgentResponse', piBody('AgentResponse', { response: 'Done.' }));

    const { extractTurns } = await import('../turns/extract.js');
    expect(extractTurns(h.store.getAll())[0].responseText).toBe('Done.');
  });
});

describe('pi tool calls', () => {
  beforeEach(() => { h.gate.activate(SESSION); });

  it('does not block when approvals are not configured', async () => {
    // pi's own position is that a harness should not impose confirmation, so the
    // default must return promptly rather than suspending on a pending approval.
    const res = await h.app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: piBody('PreToolUse', { tool_name: 'Read', tool_input: { path: 'x' } }),
    });

    expect(res.statusCode).toBe(200);
    const types = h.store.getAll().map((e) => e.type);
    expect(types).toContain('tool_call_approved');
    expect(types).not.toContain('tool_call_pending');
  });

  it('does not suspend even a high-risk tool when approvals are off', async () => {
    // autoApprove 'none' would normally force a pending approval for a
    // destructive command. With pi excluded from approvalClients it must not.
    const strict = makeHarness({ autoApprove: 'none', approvalClients: [] });
    strict.gate.activate(SESSION);

    const res = await strict.app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: piBody('PreToolUse', {
        tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(strict.store.getAll().map((e) => e.type)).toContain('tool_call_approved');
  });

  it('suspends when pi is in approvalClients', async () => {
    const blocking = makeHarness({ autoApprove: 'none', approvalClients: ['pi'] });
    blocking.gate.activate(SESSION);

    const inflight = blocking.app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: piBody('PreToolUse', {
        tool_name: 'Bash', tool_input: { command: 'rm -rf build' },
      }),
    });

    // The request is still open; the pending approval is what the UI renders.
    await vi.waitFor(() => {
      expect(blocking.store.getAll().map((e) => e.type)).toContain('tool_call_pending');
    });

    await inflight; // PendingApprovalManager resolves it on its own timeout.
  });

  it('translates a deny decision into a response the extension can block on', async () => {
    const blocking = makeHarness({ autoApprove: 'none', approvalClients: ['pi'] });
    blocking.gate.activate(SESSION);
    const pending = blocking.pending;

    const inflight = blocking.app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: piBody('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    });

    await vi.waitFor(() => expect(pending.getPending()).toHaveLength(1));
    pending.resolveApproval(pending.getPending()[0].id, { decision: 'deny', reason: 'Too broad' });

    const res = await inflight;
    const body = res.json() as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(body.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(body.hookSpecificOutput?.permissionDecisionReason).toBe('Too broad');
  });

  it('leaves other harnesses blocking unconditionally', async () => {
    // approvalClients is consulted only for opt-in harnesses. An empty list must
    // not accidentally switch claude-code's blocking off.
    const strict = makeHarness({ autoApprove: 'none', approvalClients: [] });
    strict.gate.activate('cc-session');

    const inflight = strict.app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: {
        ...piBody('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }),
        session_id: 'cc-session',
        agent_type: 'claude-code',
      },
    });

    await vi.waitFor(() => {
      expect(strict.store.getAll().map((e) => e.type)).toContain('tool_call_pending');
    });

    await inflight;
  });

  it('still delivers an orange drift reminder to a harness it may not block', async () => {
    // The reminder rides back on permissionDecisionReason, which is the only
    // channel pi has for it. Treating "cannot block" as a plain auto-allow
    // returned a bare {} and dropped the reminder for exactly the harnesses
    // that have no second route — pi with approvals off, its default.
    const app = Fastify();
    const store = new EventStore();
    const gate = new SessionGate();
    const config = LaymanConfigSchema.parse({
      autoApprove: 'none',
      approvalClients: [],
      driftMonitoring: { enabled: true },
    });
    const driftMonitor = {
      checkPreToolUse: () => ({
        shouldBlock: false,
        shouldRemind: true,
        reason: 'Drifting from the stated goal',
        rulesSummary: 'Never commit without asking',
      }),
    };
    registerHookHandler(
      app, new PendingApprovalManager(1), store, new AnalysisEngine(),
      () => config, gate, driftMonitor as never,
    );
    gate.activate(SESSION);

    const res = await app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: piBody('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit' } }),
    });

    const body = res.json() as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(body.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(body.hookSpecificOutput?.permissionDecisionReason).toContain('Drifting from the stated goal');
    expect(store.getAll().map((e) => e.type)).toContain('tool_call_approved');
  });

  it('demotes a red drift block to a reminder rather than dropping it', async () => {
    // checkPreToolUse returns shouldBlock and shouldRemind as alternatives —
    // the red branch returns before the orange one is reached — so a red level
    // on a harness Layman may not suspend used to fall past both branches to
    // the auto-allow return and say nothing at all. That inverted the severity
    // ordering: pi with approvals off got a reminder at orange and silence at
    // the strictly worse red.
    const app = Fastify();
    const store = new EventStore();
    const gate = new SessionGate();
    const config = LaymanConfigSchema.parse({
      autoApprove: 'none',
      approvalClients: [],
      driftMonitoring: { enabled: true, blockOnRed: true },
    });
    const driftMonitor = {
      checkPreToolUse: () => ({
        shouldBlock: true,
        shouldRemind: false,
        reason: 'Rewriting files no prompt asked about',
        rulesSummary: 'Never commit without asking',
      }),
    };
    registerHookHandler(
      app, new PendingApprovalManager(1), store, new AnalysisEngine(),
      () => config, gate, driftMonitor as never,
    );
    gate.activate(SESSION);

    const res = await app.inject({
      method: 'POST',
      url: '/hooks/PreToolUse',
      payload: piBody('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit' } }),
    });

    const body = res.json() as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    // The user loses the block, not the signal: the reason still reaches the
    // model and the alert is still recorded for the dashboard.
    expect(body.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(body.hookSpecificOutput?.permissionDecisionReason)
      .toContain('Rewriting files no prompt asked about');
    const alert = store.getAll().find((e) => e.type === 'drift_alert');
    expect(alert?.data.driftLevel).toBe('red');
  });

  it('records a failed tool result as a failure event', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/hooks/PostToolUseFailure',
      payload: piBody('PostToolUseFailure', {
        tool_name: 'Bash', tool_input: { command: 'false' }, tool_error: 'exit 1',
      }),
    });

    expect(h.store.getAll().some((e) => e.type === 'tool_call_failed')).toBe(true);
  });
});

describe('pi session metrics', () => {
  beforeEach(() => { h.gate.activate(SESSION); });

  /** The shape the pi extension synthesises, in claude-code's StatusLine schema. */
  function metricsBody(extra: Record<string, unknown> = {}) {
    return piBody('StatusLine', {
      session_name: 'pi-local',
      model: { id: 'qwen3.8-27b-5090', display_name: 'qwen3.8-27b-5090' },
      thinking_level: 'medium',
      cost: { total_cost_usd: 0 },
      context_window: {
        total_input_tokens: 4321,
        total_output_tokens: 876,
        context_window_size: 262144,
        current_usage: { input_tokens: 1200, output_tokens: 300 },
        used_percentage: 2,
        remaining_percentage: 98,
      },
      ...extra,
    });
  }

  it('maps a synthesised pi payload onto session_metrics', async () => {
    await h.app.inject({ method: 'POST', url: '/hooks/StatusLine', payload: metricsBody() });

    const [event] = h.store.getAll().filter((e) => e.type === 'session_metrics');
    expect(event.agentType).toBe('pi');
    expect(event.data.modelDisplayName).toBe('qwen3.8-27b-5090');
    expect(event.data.totalInputTokens).toBe(4321);
    expect(event.data.totalOutputTokens).toBe(876);
    expect(event.data.contextWindowSize).toBe(262144);
    expect(event.data.contextUsedPct).toBe(2);
  });

  it('carries the reasoning level through', async () => {
    await h.app.inject({ method: 'POST', url: '/hooks/StatusLine', payload: metricsBody() });

    const [event] = h.store.getAll().filter((e) => e.type === 'session_metrics');
    expect(event.data.thinkingLevel).toBe('medium');
  });

  it('keeps metrics out of the timeline', async () => {
    // StatusLine fires after every turn; routing it into the event stream would
    // flood the timeline. It belongs in the dedicated metrics map.
    await h.app.inject({ method: 'POST', url: '/hooks/StatusLine', payload: metricsBody() });
    await h.app.inject({ method: 'POST', url: '/hooks/StatusLine', payload: metricsBody() });

    const { extractTurns } = await import('../turns/extract.js');
    expect(extractTurns(h.store.getAll())).toHaveLength(0);
  });

  it('records a zero cost rather than dropping it', async () => {
    // The zero-cost provider case: the server stores 0 faithfully and the
    // decision to not render it is the metrics bar's, not the handler's.
    await h.app.inject({ method: 'POST', url: '/hooks/StatusLine', payload: metricsBody() });

    const [event] = h.store.getAll().filter((e) => e.type === 'session_metrics');
    expect(event.data.costUsd).toBe(0);
  });

  it('propagates the session name to the sessions list', async () => {
    await h.app.inject({ method: 'POST', url: '/hooks/StatusLine', payload: metricsBody() });

    const session = h.store.getSessions().find((s) => s.sessionId === SESSION);
    expect(session?.sessionName).toBe('pi-local');
  });
});

describe('StreamDelta ingest', () => {
  function streamHarness(overrides: Partial<LaymanConfig> = {}) {
    const app = Fastify();
    const store = new EventStore();
    const gate = new SessionGate();
    const streams = new LiveStreamStore();
    const config = LaymanConfigSchema.parse(overrides);
    registerHookHandler(
      app, new PendingApprovalManager(1), store, new AnalysisEngine(),
      () => config, gate, undefined, streams,
    );
    gate.activate(SESSION);
    return { app, store, streams };
  }

  const deltaBody = (extra: Record<string, unknown> = {}) =>
    piBody('StreamDelta', { message_id: 'm1', seq: 0, text_delta: 'Hel', ...extra });

  it('routes a delta to the live store, never to the timeline', async () => {
    // The whole point of the channel: thousands of these per turn must not be
    // PII-scanned, ring-buffered, persisted and broadcast as events.
    const { app, store, streams } = streamHarness();

    await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });
    await app.inject({
      method: 'POST', url: '/hooks/StreamDelta',
      payload: deltaBody({ seq: 1, text_delta: 'lo' }),
    });

    expect(streams.get(SESSION)?.text).toBe('Hello');
    expect(store.getAll()).toHaveLength(0);
  });

  it('returns promptly rather than blocking the harness', async () => {
    const { app } = streamHarness();
    const res = await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });
    expect(res.statusCode).toBe(200);
  });

  it('attributes the stream to the pi agent type', async () => {
    const { app, streams } = streamHarness();
    await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });
    expect(streams.get(SESSION)?.agentType).toBe('pi');
  });

  it('drops deltas entirely when live tokens are disabled', async () => {
    // Turning the feature off must stop the work server-side, not merely stop
    // the client rendering it.
    const { app, streams } = streamHarness({ liveTokens: { enabled: false, showThinking: true } });

    await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });

    expect(streams.get(SESSION)).toBeUndefined();
  });

  it('suppresses thinking at ingest when showThinking is off', async () => {
    const { app, streams } = streamHarness({ liveTokens: { enabled: true, showThinking: false } });

    await app.inject({
      method: 'POST', url: '/hooks/StreamDelta',
      payload: deltaBody({ text_delta: 'visible', thinking_delta: 'private' }),
    });

    const stream = streams.get(SESSION);
    expect(stream?.text).toBe('visible');
    expect(stream?.thinking).toBe('');
  });

  it('drops a delta for a session that was never activated', async () => {
    // The gate applies to the stream channel like every other hook.
    const app = Fastify();
    const streams = new LiveStreamStore();
    const config = LaymanConfigSchema.parse({});
    registerHookHandler(
      app, new PendingApprovalManager(1), new EventStore(), new AnalysisEngine(),
      () => config, new SessionGate(), undefined, streams,
    );

    await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });

    expect(streams.get(SESSION)).toBeUndefined();
  });

  it('ends the stream on the final delta', async () => {
    const { app, streams } = streamHarness();

    await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });
    await app.inject({
      method: 'POST', url: '/hooks/StreamDelta',
      payload: deltaBody({ seq: 1, text_delta: undefined, done: true }),
    });

    expect(streams.get(SESSION)).toBeUndefined();
  });

  it('closes the live row when the session ends mid-generation', async () => {
    // A harness quit while generating cannot be relied on to flush its own
    // closing delta — pi's extension awaits only SessionEnd, because an
    // un-awaited fetch never leaves an exiting process. Without this the
    // dashboard shows "responding…" with a blinking caret until the idle sweep.
    const { app, streams } = streamHarness();

    await app.inject({ method: 'POST', url: '/hooks/StreamDelta', payload: deltaBody() });
    expect(streams.get(SESSION)).toBeDefined();

    await app.inject({
      method: 'POST', url: '/hooks/SessionEnd',
      payload: piBody('SessionEnd', { reason: 'quit' }),
    });

    expect(streams.get(SESSION)).toBeUndefined();
  });
});

describe('pi activation gate', () => {
  it('drops pi events before the session is activated', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/hooks/UserPromptSubmit',
      payload: piBody('UserPromptSubmit', { prompt: 'before /layman' }),
    });

    expect(h.store.getAll()).toHaveLength(0);
  });

  it('auto-activates when pi is in autoActivateClients', async () => {
    const auto = makeHarness({ autoActivateClients: ['pi'] });

    await auto.app.inject({
      method: 'POST',
      url: '/hooks/UserPromptSubmit',
      payload: piBody('UserPromptSubmit', { prompt: 'no /layman needed' }),
    });

    expect(auto.gate.isActive(SESSION)).toBe(true);
    expect(auto.store.getAll().filter((e) => e.type === 'user_prompt')).toHaveLength(1);
  });

  it('does not auto-activate pi when only claude-code is configured', async () => {
    const auto = makeHarness({ autoActivateClients: ['claude-code'] });

    await auto.app.inject({
      method: 'POST',
      url: '/hooks/UserPromptSubmit',
      payload: piBody('UserPromptSubmit', { prompt: 'still gated' }),
    });

    expect(auto.gate.isActive(SESSION)).toBe(false);
  });
});

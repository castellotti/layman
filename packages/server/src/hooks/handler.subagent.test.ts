import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { registerHookHandler } from './handler.js';
import { PendingApprovalManager } from './pending.js';
import { SessionGate } from './gate.js';
import { EventStore } from '../events/store.js';
import { AnalysisEngine } from '../analysis/engine.js';
import { LaymanConfigSchema } from '../config/schema.js';

// The handler keeps per-session state at module level (which sessions' harness tags subagents),
// so each harness gets its own session id.
let sessionSeq = 0;
function harness() {
  const sessionId = `s${++sessionSeq}`;
  const app = Fastify();
  const store = new EventStore();
  const gate = new SessionGate();
  const config = LaymanConfigSchema.parse({ autoApprove: 'all' });
  registerHookHandler(app, new PendingApprovalManager(1), store, new AnalysisEngine(), () => config, gate);
  gate.activate(sessionId);
  return { app, store, sessionId };
}

const post = (h: ReturnType<typeof harness>, eventName: string, extra: Record<string, unknown> = {}) =>
  h.app.inject({
    method: 'POST',
    url: `/hooks/${eventName}`,
    payload: { session_id: h.sessionId, cwd: '/p', hook_event_name: eventName, transcript_path: '/tmp/none.jsonl', permission_mode: 'default', ...extra },
  });

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ tool_name: name, tool_input: { command: name }, tool_response: 'ok', ...extra });

describe('a hook fired inside a subagent', () => {
  it('tags its events with the subagent as they arrive', async () => {
    const h = harness();
    await post(h, 'SubagentStart', { agent_type: 'Explore', agent_id: 'a1' });
    await post(h, 'PostToolUse', tool('Grep', { agent_type: 'Explore', agent_id: 'a1' }));
    const [call] = h.store.getAll().filter((e) => e.type === 'tool_call_completed');
    expect(call.data.subagentId).toBe('a1');
    expect(call.data.agentType).toBe('Explore');
    // The marker is the parent's, and its agentType stays the subagent's name.
    const [start] = h.store.getAll().filter((e) => e.type === 'subagent_start');
    expect(start.data.subagentId).toBeUndefined();
    // The session is still Claude Code's, not a harness called "Explore".
    expect(call.agentType).toBe('claude-code');
  });

  it("leaves the parent's own calls untagged, even while a subagent runs", async () => {
    const h = harness();
    await post(h, 'SubagentStart', { agent_type: 'general-purpose', agent_id: 'bg' });
    await post(h, 'PostToolUse', tool('Read', { agent_type: 'general-purpose', agent_id: 'bg' }));
    await post(h, 'PostToolUse', tool('Edit')); // the parent, meanwhile
    await post(h, 'SubagentStop', { agent_type: 'general-purpose', agent_id: 'bg' });
    const calls = h.store.getAll().filter((e) => e.type === 'tool_call_completed');
    expect(calls.map((e) => [e.data.toolName, e.data.subagentId])).toEqual([['Read', 'bg'], ['Edit', undefined]]);
  });

  it('is still tagged by time window when the harness sends no agent_id on its hooks', async () => {
    const h = harness();
    await post(h, 'SubagentStart', { agent_type: 'Explore', agent_id: 'old' });
    await post(h, 'PostToolUse', tool('Grep'));
    await post(h, 'SubagentStop', { agent_type: 'Explore', agent_id: 'old' });
    const [call] = h.store.getAll().filter((e) => e.type === 'tool_call_completed');
    expect(call.data.subagentId).toBe('old');
  });
});

describe('a parent and a subagent calling the same tool at once', () => {
  it("each result completes its own agent's call", async () => {
    const h = harness();
    await post(h, 'SubagentStart', { agent_type: 'general-purpose', agent_id: 'bg' });
    await post(h, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/parent' } });
    await post(h, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/sub' }, agent_type: 'general-purpose', agent_id: 'bg' });
    await post(h, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/parent' }, tool_response: 'parent', tool_output: 'parent' });
    await post(h, 'PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/p/sub' }, tool_output: 'sub', agent_type: 'general-purpose', agent_id: 'bg' });
    const reads = h.store.getAll().filter((e) => e.data.toolName === 'Read');
    expect(reads.map((e) => [e.type, e.data.toolInput?.file_path, e.data.toolOutput, e.data.subagentId])).toEqual([
      ['tool_call_completed', '/p/parent', 'parent', undefined],
      ['tool_call_completed', '/p/sub', 'sub', 'bg'],
    ]);
  });

  it("does not tag the parent's calls by time window when the subagent itself called nothing", async () => {
    const h = harness();
    await post(h, 'PostToolUse', tool('Grep', { agent_type: 'Explore', agent_id: 'first' })); // the harness tags subagents
    await post(h, 'SubagentStart', { agent_type: 'Explore', agent_id: 'idle' });
    await post(h, 'PostToolUse', tool('Edit')); // the parent, meanwhile
    await post(h, 'SubagentStop', { agent_type: 'Explore', agent_id: 'idle' });
    const [edit] = h.store.getAll().filter((e) => e.data.toolName === 'Edit');
    expect(edit.data.subagentId).toBeUndefined();
  });
});

describe('a quiet session', () => {
  const quiet = (h: ReturnType<typeof harness>) => h.store.getSessions().find((s) => s.sessionId === h.sessionId)?.quiet;

  it('stays quiet through start-up noise and stops being quiet at its first real event', async () => {
    const h = harness();
    await post(h, 'InstructionsLoaded', { file_path: '/p/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' });
    await post(h, 'ConfigChange', { source: 'user_settings' });
    expect(quiet(h)).toBe(true);
    await post(h, 'UserPromptSubmit', { prompt: 'hello' });
    expect(quiet(h)).toBeUndefined();
  });

  it('announces the change to the session list', async () => {
    const h = harness();
    await post(h, 'InstructionsLoaded', { file_path: '/p/CLAUDE.md' });
    const lists: unknown[] = [];
    h.store.on('sessions:changed', (s) => lists.push(s));
    await post(h, 'PostToolUse', tool('Bash'));
    expect(lists).toHaveLength(1);
    await post(h, 'PostToolUse', tool('Bash'));
    expect(lists).toHaveLength(1); // once, not per event
  });
});

describe('EventStore history probe', () => {
  it('lists a session that did something before a restart as not quiet', () => {
    const store = new EventStore();
    store.setHistoryProbe((id) => id === 'busy');
    store.trackSession('busy', '/p');
    store.trackSession('new', '/p');
    const quiet = Object.fromEntries(store.getSessions().map((s) => [s.sessionId, s.quiet ?? false]));
    expect(quiet).toEqual({ busy: false, new: true });
  });
});

describe('subagent numbers', () => {
  it('numbers each subagent of a session by first appearance, on every event it adds', async () => {
    const h = harness();
    await post(h, 'PostToolUse', tool('Read', { agent_type: 'Explore', agent_id: 'a' }));
    await post(h, 'PostToolUse', tool('Grep', { agent_type: 'Explore', agent_id: 'b' }));
    await post(h, 'PostToolUse', tool('Bash')); // the parent: no number
    await post(h, 'PostToolUse', tool('Glob', { agent_type: 'Explore', agent_id: 'a' }));
    const calls = h.store.getAll().filter((e) => e.type === 'tool_call_completed');
    expect(calls.map((e) => e.data.subagentN)).toEqual([1, 2, undefined, 1]);
  });

  it('numbers a call tagged after the fact by the time window', async () => {
    const h = harness();
    await post(h, 'SubagentStart', { agent_type: 'Explore', agent_id: 'old' });
    await post(h, 'PostToolUse', tool('Read'));
    await post(h, 'SubagentStop', { agent_type: 'Explore', agent_id: 'old' });
    const [call] = h.store.getAll().filter((e) => e.type === 'tool_call_completed');
    expect([call.data.subagentId, call.data.subagentN]).toEqual(['old', 1]);
  });
});

describe('EventStore subagent probe', () => {
  it('carries the numbering on from the recording after a restart', () => {
    const store = new EventStore();
    store.setSubagentProbe((id) => (id === 's' ? ['x', 'y'] : []));
    expect(store.add('tool_call_completed', 's', { subagentId: 'y' }).data.subagentN).toBe(2);
    expect(store.add('tool_call_completed', 's', { subagentId: 'z' }).data.subagentN).toBe(3);
    expect(store.add('tool_call_completed', 'other', { subagentId: 'z' }).data.subagentN).toBe(1);
  });
});

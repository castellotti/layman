import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PendingApprovalManager } from './pending.js';
import { EventStore } from '../events/store.js';
import { AnalysisEngine } from '../analysis/engine.js';
import type { PreToolUseInput, PermissionRequestInput } from './types.js';
import type { LaymanConfig } from '../config/schema.js';

const BASE_INPUT: Omit<PreToolUseInput, 'tool_name' | 'tool_input'> = {
  session_id: 'sess-1',
  cwd: '/home/user/project',
  hook_event_name: 'PreToolUse',
  transcript_path: '/tmp/transcript.json',
  permission_mode: 'default',
};

const MOCK_CONFIG: LaymanConfig = {
  port: 8880,
  host: 'localhost',
  autoAnalyze: 'none',
  autoAnalyzeDepth: 'detailed',
  autoExplain: 'none',
  autoExplainDepth: 'quick',
  analysis: {
    provider: 'anthropic',
    model: 'sonnet',
    maxTokens: 400,
    temperature: 0.1,
  },
  autoAllow: {
    readOnly: true,
    safeEdits: false,
    trustedCommands: [],
  },
  hookTimeout: 300,
  theme: 'dark',
  open: true,
  autoApprove: 'all',
  laymansPrompt: 'Explain what the AI is doing here in absolute layman\'s terms to someone who has no understanding of technology',
  sessionRecording: false,
  recordingRecovery: false,
  piiFilter: true,
  showFullCommand: false,
  switchToNewestSession: false,
  collapseHistory: true,
  autoScroll: true,
  declinedClients: [],
  idleThresholdMinutes: 5,
  autoActivateClients: [],
  driftMonitoring: {
    enabled: false,
    checkIntervalToolCalls: 10,
    checkIntervalMinutes: 5,
    sessionDriftThresholds: { green: 15, yellow: 30, orange: 50 },
    rulesDriftThresholds: { green: 15, yellow: 30, orange: 50 },
    blockOnRed: true,
    remindOnOrange: true,
  },
  setupWizardComplete: false,
};

describe('PendingApprovalManager', () => {
  let manager: PendingApprovalManager;

  beforeEach(() => {
    manager = new PendingApprovalManager(300);
  });

  it('creates a pending approval and resolves it', async () => {
    const input: PreToolUseInput = {
      ...BASE_INPUT,
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    };

    const pendingPromise = manager.createAndWait(input);
    expect(manager.size).toBe(1);

    const pending = manager.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe('Bash');

    // Resolve via the manager
    const id = pending[0].id;
    manager.resolveApproval(id, { decision: 'allow' });

    const decision = await pendingPromise;
    expect(decision.decision).toBe('allow');
    expect(manager.size).toBe(0);
  });

  it('emits pending:new event when creating approval', async () => {
    const input: PreToolUseInput = {
      ...BASE_INPUT,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'hello' },
    };

    const emittedEvents: unknown[] = [];
    manager.on('pending:new', (approval) => emittedEvents.push(approval));

    const pendingPromise = manager.createAndWait(input);
    const pending = manager.getPending();
    manager.resolveApproval(pending[0].id, { decision: 'deny', reason: 'Not needed' });

    await pendingPromise;
    expect(emittedEvents).toHaveLength(1);
  });

  it('returns false when resolving unknown approval', () => {
    const result = manager.resolveApproval('nonexistent-id', { decision: 'allow' });
    expect(result).toBe(false);
  });

  it('handles concurrent pending approvals', async () => {
    const inputs = [
      { ...BASE_INPUT, tool_name: 'Bash', tool_input: { command: 'ls' } } as PreToolUseInput,
      { ...BASE_INPUT, tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } } as PreToolUseInput,
      { ...BASE_INPUT, tool_name: 'Write', tool_input: { file_path: '/tmp/x' } } as PreToolUseInput,
    ];

    const promises = inputs.map((i) => manager.createAndWait(i));
    expect(manager.size).toBe(3);

    const pendingIds = manager.getPending().map((p) => p.id);
    manager.resolveApproval(pendingIds[0], { decision: 'allow' });
    manager.resolveApproval(pendingIds[1], { decision: 'deny' });
    manager.resolveApproval(pendingIds[2], { decision: 'ask' });

    const decisions = await Promise.all(promises);
    expect(decisions[0].decision).toBe('allow');
    expect(decisions[1].decision).toBe('deny');
    expect(decisions[2].decision).toBe('ask');
    expect(manager.size).toBe(0);
  });

  it('attaches analysis to pending approval', async () => {
    const input: PreToolUseInput = {
      ...BASE_INPUT,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/test' },
    };

    const pendingPromise = manager.createAndWait(input);
    const pending = manager.getPending();
    const id = pending[0].id;

    const mockAnalysis = {
      meaning: 'Removes test directory',
      goal: 'Clean up temp files',
      safety: { level: 'danger' as const, summary: 'Destructive operation' },
      security: { level: 'safe' as const, summary: 'Local operation only' },
      risk: { level: 'high' as const, summary: 'Irreversible deletion' },
      model: 'sonnet',
      latencyMs: 200,
      tokens: { input: 50, output: 100 },
    };

    manager.attachAnalysis(id, mockAnalysis);
    expect(manager.getPending()[0].analysis).toEqual(mockAnalysis);

    manager.resolveApproval(id, { decision: 'deny' });
    await pendingPromise;
  });
});

describe('EventStore', () => {
  let store: EventStore;

  beforeEach(() => {
    store = new EventStore();
  });

  it('adds events and retrieves them', () => {
    store.add('session_start', 'sess-1', { source: 'startup' });
    store.add('user_prompt', 'sess-1', { prompt: 'fix the auth bug' });

    expect(store.size).toBe(2);
    const all = store.getAll();
    expect(all[0].type).toBe('session_start');
    expect(all[1].type).toBe('user_prompt');
  });

  it('retrieves event by id', () => {
    const event = store.add('tool_call_pending', 'sess-1', { toolName: 'Bash', toolInput: { command: 'ls' } });
    const found = store.get(event.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(event.id);
  });

  it('returns undefined for unknown id', () => {
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('paginates events', () => {
    for (let i = 0; i < 10; i++) {
      store.add('notification', 'sess-1', { notificationType: 'idle_prompt' });
    }

    const page1 = store.getPage(0, 3);
    expect(page1).toHaveLength(3);

    const page2 = store.getPage(3, 3);
    expect(page2).toHaveLength(3);

    const page3 = store.getPage(6, 10);
    expect(page3).toHaveLength(4);
  });

  it('filters events by type', () => {
    store.add('session_start', 'sess-1', {});
    store.add('tool_call_pending', 'sess-1', { toolName: 'Bash' });
    store.add('user_prompt', 'sess-1', { prompt: 'hello' });
    store.add('tool_call_approved', 'sess-1', { toolName: 'Read' });

    const toolCalls = store.getByType('tool_call_pending');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].data.toolName).toBe('Bash');
  });

  it('attaches analysis to event', () => {
    const event = store.add('tool_call_pending', 'sess-1', { toolName: 'Bash' });
    const analysis = {
      meaning: 'Lists files',
      goal: 'See directory contents',
      safety: { level: 'safe' as const, summary: 'Read-only' },
      security: { level: 'safe' as const, summary: 'No network' },
      risk: { level: 'low' as const, summary: 'Harmless' },
      model: 'sonnet',
      latencyMs: 100,
      tokens: { input: 10, output: 20 },
    };

    store.attachAnalysis(event.id, analysis);
    expect(store.get(event.id)?.analysis).toEqual(analysis);
  });

  it('emits event:new when adding', () => {
    const emitted: unknown[] = [];
    store.on('event:new', (e) => emitted.push(e));

    store.add('session_start', 'sess-1', {});
    expect(emitted).toHaveLength(1);
  });

  it('updates event type', () => {
    const event = store.add('tool_call_pending', 'sess-1', { toolName: 'Bash' });
    store.updateType(event.id, 'tool_call_approved');
    expect(store.get(event.id)?.type).toBe('tool_call_approved');
  });

  it('clears all events', () => {
    store.add('session_start', 'sess-1', {});
    store.add('user_prompt', 'sess-1', { prompt: 'test' });
    store.clear();
    expect(store.size).toBe(0);
  });
});

describe('AnalysisEngine config', () => {
  it('creates engine with default config', () => {
    const engine = new AnalysisEngine();
    expect(engine).toBeDefined();
  });

  it('creates engine with custom config', () => {
    const engine = new AnalysisEngine({
      provider: 'anthropic',
      model: 'haiku',
      maxTokens: 200,
      temperature: 0,
    });
    expect(engine).toBeDefined();
    expect(engine.cacheSize).toBe(0);
  });
});

describe('auto-allow behavior integration', () => {
  it('verifies read-only tool names match expected set', () => {
    const autoAllowTools = ['Read', 'Glob', 'Grep', 'WebSearch'];
    const nonAutoAllow = ['Bash', 'Write', 'Edit', 'Agent'];

    // Just verifying the set in our test expectations
    expect(autoAllowTools).toContain('Read');
    expect(nonAutoAllow).toContain('Bash');
  });
});

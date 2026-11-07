import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventStore } from '../events/store.js';
import { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import { PiSessionWatcher, recordedCursorFrom, type RecordedCursor } from './watcher.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000000';
const ENCODED_CWD = '--Users-test-proj--';
const CWD = '/Users/test/proj';

/** A pi session header + a user prompt, an assistant tool call, and its result. */
const INITIAL_LINES = [
  `{"type":"session","version":3,"id":"s1","timestamp":"2026-08-21T10:00:00.000Z","cwd":"${CWD}"}`,
  '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-21T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"read notes.md"}]}}',
  '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-21T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"notes.md"}}]}}',
  '{"type":"message","id":"tr1","parentId":"a1","timestamp":"2026-08-21T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"hello world"}],"isError":false}}',
];

/** The assistant's final prose, appended after the watcher is already tailing. */
const APPENDED_LINE =
  '{"type":"message","id":"a2","parentId":"tr1","timestamp":"2026-08-21T10:00:06.000Z","message":{"role":"assistant","content":[{"type":"text","text":"the file says hello world"}]}}';

/** A source that reports one pi root, as GloveSource would for a labelled sandbox. */
class FixedSource implements MonitorSource {
  readonly id = 'test';
  constructor(private root: WatchRoot) {}
  roots(): WatchRoot[] {
    return [this.root];
  }
}

function makeConfig(overrides: Partial<LaymanConfig> = {}): () => LaymanConfig {
  return () => ({ autoActivateClients: [], ...overrides } as unknown as LaymanConfig);
}

describe('PiSessionWatcher', () => {
  let tmp: string;
  let sessionsRoot: string;
  let transcript: string;
  let store: EventStore;
  let gate: SessionGate;
  let watcher: PiSessionWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    // Just after the transcript's last timestamp, so it counts as a recent
    // session and replays from the beginning.
    vi.setSystemTime(new Date('2026-08-21T10:00:05.000Z'));

    tmp = mkdtempSync(join(tmpdir(), 'layman-pi-'));
    sessionsRoot = join(tmp, '.pi', 'agent', 'sessions');
    const projectDir = join(sessionsRoot, ENCODED_CWD);
    mkdirSync(projectDir, { recursive: true });
    transcript = join(projectDir, `2026-08-21T10-00-00_${SESSION_ID}.jsonl`);
    writeFileSync(transcript, INITIAL_LINES.join('\n') + '\n');

    store = new EventStore();
    gate = new SessionGate();
    watcher = new PiSessionWatcher(store, gate, makeConfig(), [
      new FixedSource({ path: sessionsRoot, agentType: 'pi', label: 'pi-local' }),
    ]);
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replays a recent session on start, tagged pi with the sandbox label', () => {
    watcher.start();

    const types = store.getAll().map((e) => e.type);
    expect(types).toEqual(['session_start', 'user_prompt', 'tool_call_completed']);

    for (const event of store.getAll()) {
      expect(event.agentType).toBe('pi');
      expect(event.sessionId).toBe(SESSION_ID);
    }

    const prompt = store.getAll().find((e) => e.type === 'user_prompt')!;
    expect(prompt.data.prompt).toBe('read notes.md');

    const tool = store.getAll().find((e) => e.type === 'tool_call_completed')!;
    expect(tool.data.toolName).toBe('Read'); // 'read' -> 'Read'
    expect(tool.data.toolInput).toEqual({ path: 'notes.md' });
    expect(tool.data.toolOutput).toBe('hello world');

    const session = store.getSessions().find((s) => s.sessionId === SESSION_ID)!;
    expect(session.sessionName).toBe('pi-local');
    expect(session.cwd).toBe(CWD);
  });

  it('keeps the transcript\'s own times beside the read time, for joining calls to network flows', () => {
    vi.setSystemTime(new Date('2026-08-21T10:00:09.500Z'));
    watcher.start();
    const prompt = store.getAll().find((e) => e.type === 'user_prompt')!;
    const tool = store.getAll().find((e) => e.type === 'tool_call_completed')!;
    // Read time: when Layman saw it, unchanged.
    expect(tool.timestamp).toBe(Date.parse('2026-08-21T10:00:09.500Z'));
    expect(tool.data.completedAt).toBe(Date.parse('2026-08-21T10:00:09.500Z'));
    // Transcript time: when pi says the call was made and answered.
    expect(prompt.data.transcriptAt).toBe(Date.parse('2026-08-21T10:00:01.000Z'));
    expect(tool.data.transcriptAt).toBe(Date.parse('2026-08-21T10:00:02.000Z'));
    expect(tool.data.transcriptCompletedAt).toBe(Date.parse('2026-08-21T10:00:03.000Z'));
  });

  describe('a restart while the session is still young', () => {
    /** What the database would hold after the first run, as the server's query reads it. */
    const cursorFrom = (events: ReturnType<EventStore['getAll']>, legacy = false): RecordedCursor =>
      recordedCursorFrom(events.map((e) => ({
        tid: legacy ? null : e.data.transcriptEventId ?? null,
        tat: e.data.transcriptAt ?? null,
      })));
    const restart = (recorded: (first: ReturnType<EventStore['getAll']>) => RecordedCursor | null) => {
      watcher.start();
      const first = store.getAll();
      watcher.stop();
      appendFileSync(transcript, APPENDED_LINE + '\n');
      vi.setSystemTime(new Date('2026-08-21T10:00:07.000Z'));
      const again = new EventStore();
      const w = new PiSessionWatcher(again, new SessionGate(), makeConfig(), [
        new FixedSource({ path: sessionsRoot, agentType: 'pi', label: 'pi-local' }),
      ], () => recorded(first));
      w.start();
      w.stop();
      return { first, again: again.getAll().map((e) => e.type) };
    };

    it('records only what arrived since, not the whole session again', () => {
      const r = restart((first) => cursorFrom(first));
      expect(r.first.every((e) => e.type === 'session_start' || typeof e.data.transcriptEventId === 'string')).toBe(true);
      expect(r.again).toEqual(['session_start', 'agent_response']);
    });

    it('also skips rows recorded before the id was kept, by their transcript time', () => {
      const r = restart((first) => cursorFrom(first, true));
      expect(r.again).toEqual(['session_start', 'agent_response']);
    });

    it('matches ids the PII filter redacted before they were exempt from it', () => {
      const mangle = (id: string) => id.replace(/\d{3,}/g, '[REDACTED]');
      const r = restart((first) => {
        const c = cursorFrom(first);
        return { ...c, ids: new Set([...c.ids].map(mangle)), storedAs: mangle };
      });
      expect(r.again).toEqual(['session_start', 'agent_response']);
    });

    it('replays everything when nothing is recorded (recording off)', () => {
      expect(restart(() => null).again).toEqual(['session_start', 'user_prompt', 'tool_call_completed', 'agent_response']);
    });
  });

  it('activates a glove (labelled) session even when autoActivateClients is empty', () => {
    // A labelled root is a glove sandbox: /layman can't reach the host from inside
    // it, so it has no other path onto the Dashboard and must always activate.
    watcher.start();
    expect(gate.isActive(SESSION_ID)).toBe(true);
    // …and is marked gloved, which is what glove.showIpAddresses keys on (not the session name).
    expect(store.isGloved(SESSION_ID)).toBe(true);
  });

  it('does not activate a native (unlabelled) session unless its agent type is opted in', () => {
    const nativeRoot = { path: sessionsRoot, agentType: 'pi' } as WatchRoot;

    const offGate = new SessionGate();
    const offWatcher = new PiSessionWatcher(new EventStore(), offGate, makeConfig(), [
      new FixedSource(nativeRoot),
    ]);
    offWatcher.start();
    expect(offGate.isActive(SESSION_ID)).toBe(false);
    offWatcher.stop();

    const onGate = new SessionGate();
    const onWatcher = new PiSessionWatcher(
      new EventStore(),
      onGate,
      makeConfig({ autoActivateClients: ['pi'] } as Partial<LaymanConfig>),
      [new FixedSource(nativeRoot)],
    );
    onWatcher.start();
    expect(onGate.isActive(SESSION_ID)).toBe(true);
    onWatcher.stop();
  });

  it('emits only newly-appended events on a subsequent poll', () => {
    watcher.start();
    const before = store.getAll().length;

    appendFileSync(transcript, APPENDED_LINE + '\n');
    vi.advanceTimersByTime(2000); // one poll tick

    const added = store.getAll().slice(before);
    expect(added.map((e) => e.type)).toEqual(['agent_response']);
    expect(added[0].data.prompt).toBe('the file says hello world');
    // The already-emitted user_prompt / tool_call_completed are not duplicated.
    expect(store.getAll().filter((e) => e.type === 'user_prompt')).toHaveLength(1);
    expect(store.getAll().filter((e) => e.type === 'tool_call_completed')).toHaveLength(1);
  });

  it('skips history for a session older than the replay window', () => {
    // Advance well past the transcript's last write so it is no longer "recent".
    vi.setSystemTime(new Date('2026-08-21T11:00:00.000Z'));
    watcher.start();

    // Only the session_start marker; the pre-existing turn is not replayed.
    expect(store.getAll().map((e) => e.type)).toEqual(['session_start']);
  });

  it('does not claim vibe roots (agent-type filtered)', () => {
    const vibeWatcher = new PiSessionWatcher(store, gate, makeConfig(), [
      new FixedSource({ path: sessionsRoot, agentType: 'mistral-vibe', label: 'vibe-local' }),
    ]);
    vibeWatcher.start();
    expect(store.getAll()).toHaveLength(0);
    vibeWatcher.stop();
  });

  it('resumes a tombstoned session when its transcript grows again', () => {
    watcher.start();
    expect(store.getAll().map((e) => e.type)).toEqual([
      'session_start', 'user_prompt', 'tool_call_completed',
    ]);

    // Idle past the 15-minute timeout so a scan tick tombstones the session.
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(store.getAll().some((e) => e.type === 'session_end')).toBe(true);

    // A new turn lands after the tombstone; the next scan tick must revive it.
    appendFileSync(transcript, APPENDED_LINE + '\n');
    const before = store.getAll().length;
    vi.advanceTimersByTime(2000);

    const added = store.getAll().slice(before);
    expect(added.map((e) => e.type)).toEqual(['session_start', 'agent_response']);
    expect(added[0].data.source).toBe('resumed');
    expect(added[1].data.prompt).toBe('the file says hello world');
    // The pre-tombstone turn is not re-emitted.
    expect(store.getAll().filter((e) => e.type === 'user_prompt')).toHaveLength(1);
  });

  it('re-activates a still-active session on resume', () => {
    // The default watcher tails a labelled (glove) root, so it activates on start
    // and — never having been deactivated — must come back active after resume.
    watcher.start();
    expect(gate.isActive(SESSION_ID)).toBe(true);

    vi.advanceTimersByTime(16 * 60 * 1000); // idle-timeout tombstone
    expect(gate.isActive(SESSION_ID)).toBe(false); // dropped off the Dashboard

    appendFileSync(transcript, APPENDED_LINE + '\n');
    vi.advanceTimersByTime(2000); // scan tick revives it
    expect(gate.isActive(SESSION_ID)).toBe(true);
  });

  it('does not re-activate on resume a session the user manually deactivated', () => {
    // A native, opted-in session activates on start. If the user then hides it via
    // deactivate, that choice must survive an idle-timeout+resume rather than being
    // silently undone by the initial-activation rule.
    const nativeRoot = { path: sessionsRoot, agentType: 'pi' } as WatchRoot;
    const localGate = new SessionGate();
    const localStore = new EventStore();
    const localWatcher = new PiSessionWatcher(
      localStore,
      localGate,
      makeConfig({ autoActivateClients: ['pi'] } as Partial<LaymanConfig>),
      [new FixedSource(nativeRoot)],
    );

    localWatcher.start();
    expect(localGate.isActive(SESSION_ID)).toBe(true);

    // User hides the session; polling keeps running but the gate stays off.
    localGate.deactivate(SESSION_ID);

    vi.advanceTimersByTime(16 * 60 * 1000); // idle-timeout tombstone
    appendFileSync(transcript, APPENDED_LINE + '\n');
    vi.advanceTimersByTime(2000); // scan tick revives the session data-wise

    // Data resumed, but the manual deactivation is respected.
    expect(localStore.getAll().some((e) => e.data.source === 'resumed')).toBe(true);
    expect(localGate.isActive(SESSION_ID)).toBe(false);
    localWatcher.stop();
  });

  it('emits each parallel tool result exactly once even when they land out of order', () => {
    // Two tool calls issued in one assistant message; the second result is on
    // disk at start, the first arrives on a later poll. Emission keyed by event
    // id (not array position) must not duplicate the already-emitted completion
    // nor drop the late one.
    const parallelId = 'bbbbbbbb-0000-4000-8000-000000000000';
    const projectDir = join(sessionsRoot, ENCODED_CWD);
    const parallelFile = join(projectDir, `2026-08-21T10-10-00_${parallelId}.jsonl`);
    const base = [
      `{"type":"session","version":3,"id":"s2","timestamp":"2026-08-21T10:00:00.000Z","cwd":"${CWD}"}`,
      '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-21T10:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"read both"}]}}',
      '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-21T10:00:02.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"a.md"}},{"type":"toolCall","id":"c2","name":"read","arguments":{"path":"b.md"}}]}}',
      '{"type":"message","id":"tr2","parentId":"a1","timestamp":"2026-08-21T10:00:03.000Z","message":{"role":"toolResult","toolCallId":"c2","toolName":"read","content":[{"type":"text","text":"B"}],"isError":false}}',
    ];
    writeFileSync(parallelFile, base.join('\n') + '\n');

    watcher.start();
    const c2Only = store.getAll().filter(
      (e) => e.sessionId === parallelId && e.type === 'tool_call_completed'
    );
    expect(c2Only).toHaveLength(1);
    expect(c2Only[0].data.toolInput).toEqual({ path: 'b.md' });

    // c1's result arrives late, parented to c2's result (linear tree).
    appendFileSync(
      parallelFile,
      '{"type":"message","id":"tr1","parentId":"tr2","timestamp":"2026-08-21T10:00:04.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"A"}],"isError":false}}\n'
    );
    vi.advanceTimersByTime(2000);

    const completions = store.getAll().filter(
      (e) => e.sessionId === parallelId && e.type === 'tool_call_completed'
    );
    // Exactly one per tool, no duplicate of the first.
    expect(completions).toHaveLength(2);
    const inputs = completions.map((e) => (e.data.toolInput as { path: string }).path).sort();
    expect(inputs).toEqual(['a.md', 'b.md']);
  });
});

describe('PiSessionWatcher token metrics', () => {
  const usage = (input: number, output: number, cacheRead: number, reasoning: number) =>
    `{"input":${input},"output":${output},"cacheRead":${cacheRead},"cacheWrite":0,"reasoning":${reasoning},"totalTokens":${input + output + cacheRead},"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}`;
  /** A gloved pi's file, shaped like a real one (synthetic values): model, a call with usage, its result. */
  const LINES = [
    '{"type":"session","version":3,"id":"s1","timestamp":"2026-11-06T14:17:27.000Z","cwd":"/work"}',
    '{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-11-06T14:17:27.500Z","provider":"glove","modelId":"local-27b"}',
    '{"type":"thinking_level_change","id":"t1","parentId":"m1","timestamp":"2026-11-06T14:17:27.500Z","thinkingLevel":"off"}',
    '{"type":"message","id":"u1","parentId":"t1","timestamp":"2026-11-06T14:17:30.000Z","message":{"role":"user","content":[{"type":"text","text":"go"}]}}',
    `{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-11-06T14:17:33.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"c1","name":"read","arguments":{"path":"a.md"}}],"model":"local-27b","usage":${usage(7000, 100, 0, 40)},"stopReason":"toolUse"}}`,
    '{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-11-06T14:17:34.000Z","message":{"role":"toolResult","toolCallId":"c1","toolName":"read","content":[{"type":"text","text":"x"}],"isError":false}}',
  ];
  const ANSWER = `{"type":"message","id":"a2","parentId":"r1","timestamp":"2026-11-06T14:17:37.000Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"model":"local-27b","usage":${usage(600, 90, 7100, 30)},"stopReason":"stop"}}`;
  const PROMPT = '{"type":"message","id":"u2","parentId":"a2","timestamp":"2026-11-06T14:17:50.000Z","message":{"role":"user","content":[{"type":"text","text":"thanks"}]}}';

  let tmp: string;
  let root: string;
  let file: string;
  let store: EventStore;
  const watchers: PiSessionWatcher[] = [];

  const watch = (contextWindow?: (id: string) => number | null, into = store) => {
    const w = new PiSessionWatcher(into, new SessionGate(), makeConfig(), [
      new FixedSource({ path: root, agentType: 'pi', label: 'pi-mx5-abc123', contextWindow }),
    ]);
    watchers.push(w);
    w.start();
    return w;
  };
  const metrics = (s = store) => s.getAll().filter((e) => e.type === 'session_metrics');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T14:17:40.000Z'));
    tmp = mkdtempSync(join(tmpdir(), 'layman-pi-metrics-'));
    root = join(tmp, 'transcripts');
    mkdirSync(join(root, '--work--'), { recursive: true });
    file = join(root, '--work--', `2026-11-06T14-17-27-000Z_${SESSION_ID}.jsonl`);
    writeFileSync(file, LINES.join('\n') + '\n');
    store = new EventStore();
  });

  afterEach(() => {
    for (const w of watchers.splice(0)) w.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits one session_metrics with every token kind, and no context % without a window', () => {
    watch();
    const [m, ...rest] = metrics();
    expect(rest).toEqual([]);
    expect(m.agentType).toBe('pi');
    expect(m.data).toMatchObject({
      modelId: 'local-27b', modelDisplayName: 'local-27b', thinkingLevel: 'off',
      totalInputTokens: 7000, totalOutputTokens: 100, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalReasoningTokens: 40,
      currentInputTokens: 7000, currentOutputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0, currentReasoningTokens: 40,
    });
    expect(m.data.contextWindowSize).toBeUndefined();
    expect(m.data.contextUsedPct).toBeUndefined();
  });

  it('shows the context % when glove names the model\'s window (session.json models)', () => {
    watch((id) => (id === 'local-27b' ? 71_000 : null));
    const [m] = metrics();
    expect(m.data.contextWindowSize).toBe(71_000);
    expect(m.data.contextUsedPct).toBeCloseTo(10);
    expect(m.data.contextRemainingPct).toBeCloseTo(90);
  });

  it('emits again only when a batch changes the figures, with every field each time', () => {
    watch();
    appendFileSync(file, ANSWER + '\n');
    vi.advanceTimersByTime(2000);
    expect(metrics()).toHaveLength(2);
    expect(metrics()[1].data).toMatchObject({
      totalInputTokens: 7600, totalOutputTokens: 190, totalCacheReadTokens: 7100, totalReasoningTokens: 70,
      currentInputTokens: 600, currentReasoningTokens: 30, modelId: 'local-27b', thinkingLevel: 'off',
    });
    // A prompt changes no figure: no third event.
    appendFileSync(file, PROMPT + '\n');
    vi.advanceTimersByTime(2000);
    expect(metrics()).toHaveLength(2);
  });

  it('replays a restart as one event with the current state, not one per message', () => {
    writeFileSync(file, [...LINES, ANSWER].join('\n') + '\n');
    watch();
    expect(metrics()).toHaveLength(1);
    expect(metrics()[0].data.totalInputTokens).toBe(7600);
  });

  it('shows an older session\'s tokens too, though its history is not replayed', () => {
    vi.setSystemTime(new Date('2026-11-06T14:40:00.000Z'));
    watch();
    expect(store.getAll().map((e) => e.type)).toEqual(['session_start', 'session_metrics']);
  });
});

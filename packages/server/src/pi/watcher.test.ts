import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventStore } from '../events/store.js';
import { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import { PiSessionWatcher } from './watcher.js';

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

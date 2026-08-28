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
});

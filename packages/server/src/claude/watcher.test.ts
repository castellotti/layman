import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { EventStore } from '../events/store.js';
import { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import { GloveSource } from '../monitor/sources.js';
import { recordedCursorFrom } from '../pi/watcher.js';
import { ClaudeCodeSessionWatcher } from './watcher.js';

/** glove's `claude-code` scenario (`netobs/__scenarios_v3__/`), a whole `~/.glove`. */
const SCENARIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'netobs', '__scenarios_v3__', 'claude-code', 'home');
const GLOVE_ID = 'claude-code-0f1a2b';
const SESSION_ID = '7c1d2e3f-0000-4000-8000-0f1a2b3c4d5e';

const line = (o: Record<string, unknown>) => JSON.stringify({ sessionId: SESSION_ID, cwd: '/work', version: '2.1.288', ...o }) + '\n';
/** The fixture's WebFetch call (`toolu_1`) answered. */
const WEBFETCH_RESULT = line({
  type: 'user', uuid: 'u-2', parentUuid: 'a-1', timestamp: '2026-10-01T12:00:03.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Wikipedia, the free encyclopedia' }] },
});
/** The fixture subagent's own call and its result. */
const SUBAGENT_CALL = [
  line({
    type: 'assistant', uuid: 's-2', parentUuid: 's-1', isSidechain: true, agentId: 'a1b2c3', timestamp: '2026-10-01T12:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'searching' }, { type: 'tool_use', id: 'toolu_s1', name: 'WebFetch', input: { url: 'https://arxiv.org/' } }] },
  }),
  line({
    type: 'user', uuid: 's-3', parentUuid: 's-2', isSidechain: true, agentId: 'a1b2c3', timestamp: '2026-10-01T12:00:04.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'arXiv' }] },
  }),
].join('');

class FixedSource implements MonitorSource {
  readonly id = 'test';
  constructor(private list: WatchRoot[]) {}
  roots(): WatchRoot[] {
    return this.list;
  }
}

const config = (): LaymanConfig => ({ autoActivateClients: [] } as unknown as LaymanConfig);

describe('ClaudeCodeSessionWatcher (gloved Claude Code)', () => {
  let tmp: string;
  let home: string;
  let projects: string;
  let main: string;
  let subagent: string;
  let store: EventStore;
  let gate: SessionGate;
  let watcher: ClaudeCodeSessionWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:05.000Z'));
    tmp = mkdtempSync(join(tmpdir(), 'layman-cc-'));
    home = join(tmp, 'glove');
    cpSync(SCENARIO, home, { recursive: true });
    projects = join(home, 'observe', GLOVE_ID, 'transcripts');
    main = join(projects, '-work', `${SESSION_ID}.jsonl`);
    subagent = join(projects, '-work', SESSION_ID, 'subagents', 'agent-a1b2c3.jsonl');
    store = new EventStore();
    gate = new SessionGate();
    // Through GloveSource, as server.ts wires it: the registry row says claude-code.
    watcher = new ClaudeCodeSessionWatcher(store, gate, config, [new GloveSource(() => home)]);
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  const types = () => store.getAll().map((e) => e.type);

  it('replays a young session from the export, labelled with its glove id, gloved and activated', () => {
    watcher.start();
    expect(types()).toEqual(['session_start', 'user_prompt', 'subagent_start']);
    for (const e of store.getAll()) {
      expect(e.sessionId).toBe(SESSION_ID);
      expect(e.agentType).toBe('claude-code');
    }
    expect(store.getAll()[1].data.prompt).toBe('hello');
    const session = store.getSessions().find((s) => s.sessionId === SESSION_ID)!;
    expect(session).toMatchObject({ sessionName: GLOVE_ID, cwd: '/work', agentType: 'claude-code' });
    expect(store.isGloved(SESSION_ID)).toBe(true);
    expect(gate.isActive(SESSION_ID)).toBe(true);
  });

  it('emits a call once its result lands, with the transcript\'s times for Trace', () => {
    watcher.start();
    appendFileSync(main, WEBFETCH_RESULT);
    vi.advanceTimersByTime(2000);
    const tool = store.getAll().find((e) => e.type === 'tool_call_completed')!;
    expect(tool.data).toMatchObject({
      toolName: 'WebFetch', toolInput: { url: 'https://en.wikipedia.org/', prompt: 'summarise' },
      transcriptAt: Date.parse('2026-10-01T12:00:00.000Z'), transcriptCompletedAt: Date.parse('2026-10-01T12:00:03.000Z'),
    });
    expect(tool.data.subagentId).toBeUndefined();
  });

  it('attributes a subagent\'s calls to the parent session, tagged, without its prompt or prose', () => {
    watcher.start();
    appendFileSync(subagent, SUBAGENT_CALL);
    vi.advanceTimersByTime(2000);
    expect(types()).toEqual(['session_start', 'user_prompt', 'subagent_start', 'tool_call_completed']);
    const tool = store.getAll()[3];
    expect(tool.sessionId).toBe(SESSION_ID);
    expect(tool.data).toMatchObject({ toolName: 'WebFetch', subagentId: 'a1b2c3', toolOutput: 'arXiv' });
    expect(store.getAll().filter((e) => e.type === 'user_prompt')).toHaveLength(1); // "look it up" is not a turn
  });

  it('picks up a subagent file that appears after the session is tracked', () => {
    rmSync(join(projects, '-work', SESSION_ID), { recursive: true });
    watcher.start();
    expect(types()).toEqual(['session_start', 'user_prompt']);
    mkdirSync(dirname(subagent), { recursive: true });
    writeFileSync(subagent, SUBAGENT_CALL);
    vi.advanceTimersByTime(2000);
    expect(types()).toEqual(['session_start', 'user_prompt', 'subagent_start', 'tool_call_completed']);
  });

  it('treats a resume file carrying the same session id as the same session', () => {
    watcher.start();
    // A resumed session writes a new file whose lines keep the original id, repeating earlier lines.
    const resumed = join(projects, '-work', '99999999-0000-4000-8000-000000000000.jsonl');
    writeFileSync(resumed, line({ type: 'user', uuid: 'u-1', parentUuid: null, timestamp: '2026-10-01T12:00:00.000Z', message: { role: 'user', content: 'hello' } })
      + line({ type: 'user', uuid: 'u-9', parentUuid: 'u-1', timestamp: '2026-10-01T12:00:06.000Z', message: { role: 'user', content: 'and again' } }));
    vi.advanceTimersByTime(2000);
    expect(types()).toEqual(['session_start', 'user_prompt', 'subagent_start', 'user_prompt']);
    expect(store.getAll()[3].data.prompt).toBe('and again');
  });

  describe('a resume file', () => {
    const RESUMED = () => join(projects, '-work', '99999999-0000-4000-8000-000000000000.jsonl');
    const prompt = (uuid: string, at: string, text: string) => line({ type: 'user', uuid, parentUuid: null, timestamp: at, message: { role: 'user', content: text } });
    const IDLE = 15 * 60 * 1000;

    it('keeps the session active while it grows, though the original went quiet, and ends it once', () => {
      watcher.start();
      writeFileSync(RESUMED(), prompt('r-1', '2026-10-01T12:00:06.000Z', 'resumed'));
      vi.advanceTimersByTime(2000);
      // The original file stays silent while the resume file keeps writing.
      for (let i = 0; i < 9; i++) {
        vi.advanceTimersByTime(2 * 60 * 1000);
        appendFileSync(RESUMED(), prompt(`r-${i + 2}`, new Date(Date.now()).toISOString(), `turn ${i}`));
      }
      vi.advanceTimersByTime(2000);
      expect(types()).not.toContain('session_end');
      expect(gate.isActive(SESSION_ID)).toBe(true);
      vi.advanceTimersByTime(IDLE + 4000);
      expect(types().filter((t) => t === 'session_end')).toHaveLength(1);
      expect(gate.isActive(SESSION_ID)).toBe(false);
    });

    it('brings back a session that had already ended', () => {
      watcher.start();
      vi.advanceTimersByTime(IDLE + 4000);
      expect(types().at(-1)).toBe('session_end');
      expect(gate.isActive(SESSION_ID)).toBe(false);
      writeFileSync(RESUMED(), prompt('r-1', new Date(Date.now()).toISOString(), 'back again'));
      vi.advanceTimersByTime(2000);
      expect(types().slice(-2)).toEqual(['session_start', 'user_prompt']);
      expect(store.getAll().at(-2)!.data.source).toBe('resumed');
      expect(gate.isActive(SESSION_ID)).toBe(true);
    });
  });

  it('attributes sidechain lines an older Claude Code wrote into the main transcript to their subagent', () => {
    rmSync(join(projects, '-work', SESSION_ID), { recursive: true });
    appendFileSync(main, SUBAGENT_CALL);
    watcher.start();
    expect(types()).toEqual(['session_start', 'user_prompt', 'subagent_start', 'tool_call_completed']);
    expect(store.getAll()[3].data).toMatchObject({ toolName: 'WebFetch', subagentId: 'a1b2c3' });
    expect(store.getAll().filter((e) => e.type === 'agent_response')).toEqual([]); // "searching" is the subagent's prose
  });

  it('records only what arrived since on a restart, skipping what the database holds', () => {
    watcher.start();
    const first = store.getAll();
    watcher.stop();
    appendFileSync(main, WEBFETCH_RESULT);
    const again = new EventStore();
    const cursor = recordedCursorFrom(first.map((e) => ({ tid: e.data.transcriptEventId ?? null, tat: e.data.transcriptAt ?? null })));
    const w = new ClaudeCodeSessionWatcher(again, new SessionGate(), config, [new GloveSource(() => home)], () => cursor);
    w.start();
    w.stop();
    expect(again.getAll().map((e) => e.type)).toEqual(['session_start', 'tool_call_completed']);
  });

  it('adopts an old session\'s history without replaying it', () => {
    vi.setSystemTime(new Date('2026-10-01T12:30:00.000Z'));
    watcher.start();
    expect(types()).toEqual(['session_start']);
    appendFileSync(main, WEBFETCH_RESULT);
    vi.advanceTimersByTime(2000);
    expect(types()).toEqual(['session_start', 'tool_call_completed']);
  });

  it('ignores roots of other agent types, and a native ~/.claude/projects is never a source', () => {
    const w = new ClaudeCodeSessionWatcher(store, gate, config, [new FixedSource([{ path: projects, agentType: 'pi', label: GLOVE_ID }])]);
    w.start();
    w.stop();
    expect(store.getAll()).toEqual([]);
  });
});

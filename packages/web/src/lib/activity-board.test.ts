import { describe, expect, it } from 'vitest';
import { foldRows, reduceBoard, routeOf, runningAt, type BoardEntry } from './activity-board.js';
import type { EventData, EventType, TimelineEvent } from './types.js';

let seq = 0;
function ev(type: EventType, timestamp: number, data: EventData = {}, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  seq++;
  return { id: `e${seq}`, type, timestamp, sessionId: 's1', agentType: 'claude-code', data, ...extra };
}
const call = (type: EventType, t: number, toolName: string, toolInput: Record<string, unknown>, data: EventData = {}) =>
  ev(type, t, { toolName, toolInput, ...data });

describe('reduceBoard', () => {
  it('counts a call that completed in place at its tool station, with its own times', () => {
    const b = reduceBoard([call('tool_call_completed', 100, 'Read', { file_path: '/a/b/c.ts' }, { completedAt: 160 })]);
    expect(b.counts).toEqual({ files: 1 });
    expect(b.entries).toEqual([{ eventId: expect.any(String), station: 'files', on: 'files', from: 'core', status: 'ok', startedAt: 100, endedAt: 160 }]);
  });

  it('draws a call where `place` puts it, and counts, faults and the route by that station', () => {
    const b = reduceBoard([
      call('tool_call_completed', 100, 'web_fetch', { url: 'https://a.dev' }),
      call('tool_call_failed', 200, 'web_fetch', { url: 'https://b.dev' }),
    ], { place: (_e, station) => (station === 'network' ? 'gate:proxy' : null) });
    expect(b.entries.map((e) => [e.station, e.on])).toEqual([['network', 'gate:proxy'], ['network', 'gate:proxy']]);
    expect(b.counts).toEqual({ 'gate:proxy': 2 });
    expect(b.faults).toEqual({ 'gate:proxy': 1 });
    expect(routeOf(b.entries).map((s) => s.station)).toEqual(['gate:proxy']);
  });

  it('closes the open call with the same input when its failure arrives as a separate event', () => {
    const b = reduceBoard([
      call('tool_call_approved', 100, 'Bash', { command: 'make lint' }),
      call('tool_call_approved', 110, 'Bash', { command: 'make' }),
      call('tool_call_failed', 150, 'Bash', { command: 'make' }, { error: 'exit 2' }),
    ]);
    expect(b.counts).toEqual({ shell: 2 });
    expect(b.entries.map((e) => [e.startedAt, e.status, e.endedAt])).toEqual([[100, 'run', undefined], [110, 'err', 150]]);
    expect(b.faults).toEqual({ shell: 1 });
  });

  it('records a failure with no open call as its own entry', () => {
    const b = reduceBoard([call('tool_call_failed', 100, 'WebFetch', { url: 'https://x.dev/' })]);
    expect(b.entries.map((e) => [e.station, e.status])).toEqual([['network', 'err']]);
    expect(b.faults).toEqual({ network: 1 });
  });

  it('counts a decision at Guard and a refused call as a fault at its own station', () => {
    const decision = { decision: 'deny' as const };
    const b = reduceBoard([call('tool_call_denied', 100, 'Bash', { command: 'curl https://x.dev' }, { decision, completedAt: 120 } as EventData)]);
    expect(b.counts).toEqual({ guard: 1, network: 1 });
    expect(b.faults).toEqual({ network: 1 });
    expect(b.entries.map((e) => [e.station, e.status])).toEqual([['guard', 'ok'], ['network', 'block']]);
  });

  it('counts a delegated call only at Guard: the call arrives as its own event', () => {
    const decision = { decision: 'delegate' } as unknown as EventData['decision'];
    const b = reduceBoard([
      call('tool_call_delegated', 100, 'Edit', { file_path: '/a/b' }, { decision }),
      call('tool_call_completed', 101, 'Edit', { file_path: '/a/b' }, { completedAt: 130 }),
    ]);
    expect(b.counts).toEqual({ guard: 1, files: 1 });
  });

  it('keeps an approved call that later completed in place as one call plus its decision', () => {
    const decision = { decision: 'allow' } as unknown as EventData['decision'];
    const b = reduceBoard([call('tool_call_completed', 100, 'Write', { file_path: '/a/b' }, { decision, completedAt: 200 })]);
    expect(b.counts).toEqual({ guard: 1, files: 1 });
    expect(b.faults).toEqual({});
  });

  it('clears faults at the next prompt, but not at a re-recorded duplicate of the same prompt', () => {
    const events = [
      ev('user_prompt', 0, { prompt: 'go' }),
      call('tool_call_failed', 10, 'Bash', { command: 'make' }),
      ev('user_prompt', 500, { prompt: 'go' }),
    ];
    const b = reduceBoard(events);
    expect(b.turns).toBe(1);
    expect(b.counts.you).toBe(1);
    expect(b.faults).toEqual({ shell: 1 });
    const next = reduceBoard([...events, ev('user_prompt', 5000, { prompt: 'again' })]);
    expect(next.turns).toBe(2);
    expect(next.faults).toEqual({});
    expect(next.counts).toEqual({ you: 2, shell: 1 });
  });

  it('marks a call still open at the next prompt as unended, not running and not a fault', () => {
    const b = reduceBoard([
      ev('user_prompt', 0, { prompt: 'a' }),
      call('tool_call_approved', 10, 'Bash', { command: 'sleep 9' }),
      ev('user_prompt', 5000, { prompt: 'b' }),
    ]);
    expect(b.entries[1]).toMatchObject({ status: 'unended', endedAt: 5000 });
    expect(runningAt(b)).toEqual({});
    expect(b.faults).toEqual({});
  });

  it('shows open calls as running while the session lives, and as unended once it is over', () => {
    const events = [call('tool_call_pending', 10, 'Read', { file_path: '/a' }), call('tool_call_approved', 12, 'Grep', { pattern: 'x' })];
    expect(runningAt(reduceBoard(events))).toEqual({ files: 2 });
    const over = reduceBoard(events, { ended: true });
    expect(runningAt(over)).toEqual({});
    expect(over.entries.every((e) => e.status === 'unended')).toBe(true);
    const ended = reduceBoard([...events, ev('session_end', 50)]);
    expect(ended.entries.map((e) => e.endedAt)).toEqual([50, 50]);
  });

  it('counts subagents alive by type, a stop with no start ignored', () => {
    const b = reduceBoard([
      ev('subagent_stop', 1, { agentType: 'general-purpose' }),
      ev('subagent_start', 2, { agentType: 'general-purpose' }),
      ev('subagent_start', 3, { agentType: 'Explore' }),
      ev('subagent_stop', 4, { agentType: 'Explore' }),
      ev('subagent_start', 5, { agentType: 'general-purpose' }),
    ]);
    expect(b.agents).toBe(2);
    expect(b.counts).toEqual({});
    expect(reduceBoard([ev('subagent_start', 1, { agentType: 'x' })], { ended: true }).agents).toBe(0);
  });

  it("files a subagent's calls as coming from Agents", () => {
    const b = reduceBoard([call('tool_call_completed', 1, 'Read', { file_path: '/a' }, { subagentId: 'ag1', completedAt: 2 })]);
    expect(b.entries[0].from).toBe('agents');
  });

  it('counts memory pushed into the context apart, and as memory', () => {
    const b = reduceBoard([
      ev('instructions_loaded', 1, { filePath: '/p/CLAUDE.md', memoryType: 'Project' }),
      call('tool_call_completed', 2, 'Read', { file_path: '/Users/x/.claude/projects/p/memory/MEMORY.md' }, { completedAt: 3 }),
    ]);
    expect(b.counts).toEqual({ memory: 2 });
    expect(b.pushed).toBe(1);
    expect(b.entries.map((e) => e.from)).toEqual(['inbound', 'core']);
  });

  it('reads Memory settings through the setup', () => {
    const b = reduceBoard([call('tool_call_completed', 1, 'Read', { file_path: '/n/vault/x.md' }, { completedAt: 2 })], {
      setup: { memoryPaths: ['/vault/'], memoryServers: [] },
    });
    expect(b.counts).toEqual({ memory: 1 });
  });

  it('takes the context fill and the model from session metrics', () => {
    const b = reduceBoard([
      ev('session_metrics', 1, { contextUsedPct: 40, modelDisplayName: 'Opus' }),
      ev('session_metrics', 2, { costUsd: 1 }),
    ]);
    expect(b).toMatchObject({ context: 40, model: 'Opus' });
    expect(b.counts).toEqual({});
  });

  it('files the model, guard and failure events', () => {
    const b = reduceBoard([
      ev('agent_response', 1, { prompt: 'done', model: 'm2' }),
      ev('stop_failure', 2, { error: 'rate limited' }),
      ev('drift_alert', 3, { driftLevel: 'red' }),
      ev('drift_alert', 4, { driftLevel: 'orange' }),
      ev('permission_request', 5, { toolName: 'Bash' }),
      ev('web_search', 6, { prompt: 'q' }),
      ev('file_changed', 7, { filePath: '/a/b' }),
      ev('notification', 8, {}),
    ]);
    expect(b.counts).toEqual({ model: 2, guard: 3, network: 1, files: 1 });
    expect(b.faults).toEqual({ model: 1, guard: 1 });
    expect(b.model).toBe('m2');
    expect(b.entries.find((e) => e.station === 'files')?.from).toBe('inbound');
  });

  it('keeps an elicitation running until its result', () => {
    const asked = reduceBoard([ev('elicitation', 1, {})]);
    expect(runningAt(asked)).toEqual({ you: 1 });
    const answered = reduceBoard([ev('elicitation', 1, {}), ev('elicitation_result', 9, {})]);
    expect(answered.entries).toMatchObject([{ station: 'you', status: 'ok', endedAt: 9 }]);
    expect(answered.counts).toEqual({ you: 1 });
  });

  it("uses a transcript's own times for an event a passive watcher read late", () => {
    const b = reduceBoard([call('tool_call_completed', 900, 'read', { path: '/a/b' }, { completedAt: 950, transcriptAt: 100, transcriptCompletedAt: 140 })]);
    expect(b.entries[0]).toMatchObject({ startedAt: 100, endedAt: 140 });
  });

  it('reads events in time order whatever order they arrive in', () => {
    const b = reduceBoard([
      call('tool_call_failed', 50, 'Bash', { command: 'make' }),
      call('tool_call_approved', 10, 'Bash', { command: 'make' }),
    ]);
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0]).toMatchObject({ status: 'err', startedAt: 10, endedAt: 50 });
  });

  it('keeps only the newest finished entries, and every running one', () => {
    const events = [call('tool_call_approved', 0, 'Bash', { command: 'serve' })];
    for (let i = 1; i <= 10; i++) events.push(call('tool_call_completed', i, 'Read', { file_path: '/a' }, { completedAt: i }));
    const b = reduceBoard(events, { keep: 3 });
    expect(b.entries.map((e) => e.startedAt)).toEqual([0, 8, 9, 10]);
    expect(b.counts).toEqual({ shell: 1, files: 10 });
  });

  it('replays a recorded Claude Code session into its worn spokes', () => {
    // The shape `/api/bookmarks/sessions/:id/events` returns: one row per call, changed in place.
    const t0 = 1_700_000_000_000;
    const at = (s: number) => t0 + s * 1000;
    const done = (s: number, tool: string, input: Record<string, unknown>, data: EventData = {}) =>
      call('tool_call_completed', at(s), tool, input, { completedAt: at(s) + 400, ...data });
    const recorded = [
      ev('session_start', at(0)),
      ev('instructions_loaded', at(0), { filePath: '/r/CLAUDE.md' }),
      ev('user_prompt', at(1), { prompt: 'fix the build' }),
      done(2, 'Read', { file_path: '/r/src/a.ts' }),
      done(3, 'Grep', { pattern: 'build', path: '/r' }),
      done(4, 'Bash', { command: 'pnpm -r test 2>&1 | tail -5' }),
      done(5, 'Edit', { file_path: '/r/src/a.ts' }),
      call('tool_call_approved', at(6), 'Bash', { command: 'git push origin main' }),
      call('tool_call_failed', at(7), 'Bash', { command: 'git push origin main' }, { error: 'rejected' }),
      done(8, 'Task', { description: 'review', prompt: 'review it', subagent_type: 'general-purpose' }),
      ev('subagent_start', at(8), { agentType: 'general-purpose' }),
      done(9, 'Read', { file_path: '/r/src/b.ts' }, { subagentId: 'a1' }),
      ev('subagent_stop', at(10), { agentType: 'general-purpose' }),
      done(11, 'WebFetch', { url: 'https://docs.example.dev/x' }),
      done(12, 'mcp__playwright__browser_navigate', { url: 'http://localhost:3000' }),
      done(13, 'Skill', { skill: 'simplify' }),
      done(14, 'Write', { file_path: '/home/me/.claude/projects/r/memory/build.md' }),
      ev('agent_response', at(15), { prompt: 'Fixed.' }),
      ev('session_metrics', at(15), { contextUsedPct: 22 }),
      ev('session_end', at(20)),
    ];
    const b = reduceBoard(recorded);
    expect(b.counts).toEqual({ you: 1, model: 1, memory: 2, files: 4, shell: 1, network: 2, browser: 1, agents: 1, skills: 1 });
    expect(b.pushed).toBe(1);
    expect(b.faults).toEqual({ network: 1 });
    expect(b.turns).toBe(1);
    expect(b.agents).toBe(0);
    expect(b.context).toBe(22);
    expect(runningAt(b)).toEqual({});
    expect(routeOf(b.entries).map((s) => s.station)).toEqual(['files', 'network', 'agents', 'network', 'browser', 'skills', 'memory']);
  });
});

const entry = (station: BoardEntry['station'], startedAt: number, extra: Partial<BoardEntry> = {}): BoardEntry => ({
  eventId: `x${startedAt}`, station, on: station, from: 'core', status: 'ok', startedAt, endedAt: startedAt + 10, ...extra,
});

describe('routeOf', () => {
  it('leaves out model steps, subagents, Guard and what was pushed in, and joins a station visited twice in a row', () => {
    const r = routeOf([
      entry('you', 1, { from: 'inbound' }), entry('memory', 2, { from: 'inbound' }), entry('guard', 2),
      entry('model', 2), entry('files', 3), entry('guard', 3), entry('files', 4), entry('model', 5),
      entry('files', 6), entry('shell', 7, { from: 'agents' }), entry('network', 8),
    ]);
    expect(r).toEqual([{ station: 'you', at: 1 }, { station: 'files', at: 6 }, { station: 'network', at: 8 }]);
  });

  it('keeps the last `max` stops', () => {
    const stations = ['you', 'files', 'shell', 'files', 'shell', 'network'] as const;
    expect(routeOf(stations.map((s, i) => entry(s, i)), 3).map((s) => s.station)).toEqual(['files', 'shell', 'network']);
  });
});

describe('foldRows', () => {
  it('folds finished calls in a row at one station into the newest of them, newest first', () => {
    const rows = foldRows([entry('files', 1), entry('files', 2), entry('files', 3), entry('shell', 4)]);
    expect(rows.map((r) => [r.entry.startedAt, r.times, r.tookMs])).toEqual([[4, 1, 10], [3, 3, 30]]);
  });

  it('never folds a running, failed or refused entry, or work from another place', () => {
    const rows = foldRows([
      entry('files', 1), entry('files', 2, { status: 'err' }), entry('files', 3),
      entry('files', 4, { from: 'agents' }), entry('files', 5, { status: 'run', endedAt: undefined }),
    ]);
    expect(rows.map((r) => r.times)).toEqual([1, 1, 1, 1, 1]);
    expect(rows[0].tookMs).toBe(0);
  });

  it('stops at `max` rows', () => {
    expect(foldRows([entry('files', 1), entry('shell', 2), entry('files', 3)], 2).map((r) => r.entry.startedAt)).toEqual([3, 2]);
  });
});

describe('reduceBoard: a call and its result recorded apart', () => {
  const vibe = (e: TimelineEvent): TimelineEvent => ({ ...e, agentType: 'mistral-vibe' });

  it('closes the open call with the same input when the result is its own event (Mistral Vibe)', () => {
    const b = reduceBoard([
      vibe(call('tool_call_approved', 10, 'Read', { file_path: '/a' })),
      vibe(call('tool_call_approved', 11, 'Read', { file_path: '/b' })),
      vibe(call('tool_call_completed', 20, 'Read', { file_path: '/b' }, { completedAt: 20 })),
      vibe(call('tool_call_completed', 30, 'Read', { file_path: '/a' }, { completedAt: 30 })),
    ]);
    expect(b.counts).toEqual({ files: 2 });
    expect(b.entries.map((e) => [e.startedAt, e.status, e.endedAt])).toEqual([[10, 'ok', 30], [11, 'ok', 20]]);
  });

  it('never closes a call whose input differs', () => {
    const b = reduceBoard([
      vibe(call('tool_call_approved', 10, 'bash', { command: 'make' })),
      vibe(call('tool_call_completed', 20, 'bash', { command: 'make test' }, { completedAt: 20 })),
    ]);
    expect(b.entries.map((e) => [e.startedAt, e.status])).toEqual([[10, 'run'], [20, 'ok']]);
  });

  it('never lets a call completed in place close a sibling still running (hooks harnesses)', () => {
    const b = reduceBoard([
      call('tool_call_approved', 10, 'Read', { file_path: '/a' }),
      call('tool_call_completed', 11, 'Read', { file_path: '/a' }, { completedAt: 12 }),
    ]);
    expect(b.counts).toEqual({ files: 2 });
    expect(runningAt(b)).toEqual({ files: 1 });
  });

  it('lets a result that arrives after the next prompt close its unended call, counted once and no fault of the new turn', () => {
    const b = reduceBoard([
      ev('user_prompt', 0, { prompt: 'a' }),
      call('tool_call_approved', 10, 'Bash', { command: 'make' }),
      ev('user_prompt', 20, { prompt: 'stop that' }),
      call('tool_call_failed', 30, 'Bash', { command: 'make' }, { error: 'interrupted' }),
    ]);
    expect(b.counts).toEqual({ you: 2, shell: 1 });
    expect(b.faults).toEqual({});
    expect(b.entries[1]).toMatchObject({ status: 'err', endedAt: 30 });
  });
});

describe('reduceBoard: background tasks', () => {
  const notice = (t: number, id: string, status = 'completed') =>
    ev('user_prompt', t, { prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n</task-notification>` });
  const launch = (t: number, id: string) =>
    call('tool_call_completed', t, 'Bash', { command: 'sleep 99', run_in_background: true }, { backgroundTaskId: id });

  it('keeps a background call running until its notice, across prompts', () => {
    const board = reduceBoard([ev('user_prompt', 0, { prompt: 'go' }), launch(10, 'b1'), ev('user_prompt', 20, { prompt: 'next' })]);
    const bg = board.entries.find((e) => e.station === 'shell');
    expect(bg?.status).toBe('run');
    expect(board.turns).toBe(2);
    const after = reduceBoard([ev('user_prompt', 0, { prompt: 'go' }), launch(10, 'b1'), ev('user_prompt', 20, { prompt: 'next' }), notice(30, 'b1')]);
    const done = after.entries.find((e) => e.station === 'shell');
    expect(done?.status).toBe('ok');
    expect(done?.endedAt).toBe(30);
    expect(after.turns).toBe(2);
    expect(after.entries.filter((e) => e.station === 'you')).toHaveLength(2);
  });

  it('marks a failed task, and a notice for an unknown task changes nothing', () => {
    const failed = reduceBoard([launch(10, 'b1'), notice(20, 'b1', 'failed'), notice(21, 'zzz')]);
    expect(failed.entries.find((e) => e.station === 'shell')?.status).toBe('err');
    expect(failed.faults.shell).toBe(1);
    expect(failed.entries.some((e) => e.station === 'you')).toBe(false);
  });

  it('never ended when the session is over', () => {
    const board = reduceBoard([launch(10, 'b1')], { ended: true });
    expect(board.entries.find((e) => e.station === 'shell')?.status).toBe('unended');
  });

  it('a call without a task id is done at once', () => {
    const board = reduceBoard([call('tool_call_completed', 10, 'Bash', { command: 'ls' })]);
    expect(board.entries[0].status).toBe('ok');
  });

  it('names the model a change moved to', () => {
    const board = reduceBoard([ev('model_change', 5, { fromModel: 'a', toModel: 'claude-sonnet-5-5' })]);
    expect(board.model).toBe('claude-sonnet-5-5');
    expect(board.entries).toHaveLength(0);
  });
});

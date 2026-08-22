import { describe, it, expect } from 'vitest';
import { turnToMarkdown, sessionToMarkdown, describeToolCall, firstLine } from './markdown.js';
import { extractTurns } from '../turns/extract.js';
import type { TimelineEvent, EventType } from '../events/types.js';
import type { RecordedSession } from '../db/types.js';

const OPTS = {
  instanceUrl: 'http://nyx.local:8880',
  includeToolCalls: 'summary' as const,
  includeAnalysis: true,
};

let clock = 1_700_000_000_000;
function ev(type: EventType, data: Record<string, unknown> = {}, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  clock += 1000;
  return {
    id: extra.id ?? `${type}-${clock}`,
    type,
    timestamp: clock,
    sessionId: 'sess-1',
    agentType: 'claude-code',
    data,
    ...extra,
  } as TimelineEvent;
}

/** The worked example from the plan: tool calls interleaved with interstitial prose. */
function joystickEvents(): TimelineEvent[] {
  return [
    ev('user_prompt', { prompt: 'plug the original holes and let me reposition the buttons' }, { id: 'p1' }),
    ev('tool_call_completed', { toolName: 'Bash', command: 'x' }, { id: 't1' }),
    ev('agent_response', { prompt: 'This is an edge-on view showing only the corner mounting blocks.' }, { id: 'r1' }),
    ev('tool_call_completed', { toolName: 'Read', toolInput: { file_path: '/tmp/Joystick.scad' } }, { id: 't2' }),
    ev('agent_response', { prompt: 'All three changes are in and verified with full CGAL renders.' }, { id: 'r2' }),
  ];
}

describe('turnToMarkdown', () => {
  it('renders a turn with links, prompt quote and final response', () => {
    const events = joystickEvents();
    const turn = extractTurns(events)[0];

    const md = turnToMarkdown(turn, events, OPTS);

    expect(md).toContain('## 1 · plug the original holes and let me reposition the buttons');
    expect(md).toContain('[Open turn](http://nyx.local:8880/s/sess-1/t/p1)');
    expect(md).toContain('[🔊](http://nyx.local:8880/s/sess-1/t/p1?play=1)');
    expect(md).toContain('> plug the original holes and let me reposition the buttons');
    expect(md).toContain('**Response**');
    // The LAST response is the answer, not the interstitial one.
    expect(md).toContain('All three changes are in and verified');
    expect(md).not.toContain('**Response**\n\nThis is an edge-on view');
    expect(md).toContain('2 tool calls');
  });

  it('summarises tool calls in a collapsed block', () => {
    const events = joystickEvents();
    const md = turnToMarkdown(extractTurns(events)[0], events, OPTS);

    expect(md).toContain('<summary>Tool calls (2)</summary>');
    expect(md).toContain('- `Read` — /tmp/Joystick.scad');
  });

  it('omits the tool block entirely when asked', () => {
    const events = joystickEvents();
    const md = turnToMarkdown(extractTurns(events)[0], events, { ...OPTS, includeToolCalls: 'none' });

    expect(md).not.toContain('<details>');
  });

  it('emits full inputs and outputs in full mode', () => {
    const events = [
      ev('user_prompt', { prompt: 'go' }),
      ev('tool_call_completed', { toolName: 'Bash', toolInput: { command: 'ls' }, toolOutput: 'a\nb' }),
    ];
    const md = turnToMarkdown(extractTurns(events)[0], events, { ...OPTS, includeToolCalls: 'full' });

    expect(md).toContain('"command": "ls"');
    expect(md).toContain('a\nb');
  });

  it('marks failed and denied calls', () => {
    const events = [
      ev('user_prompt', { prompt: 'go' }),
      ev('tool_call_failed', { toolName: 'Bash' }),
      ev('tool_call_denied', { toolName: 'Write' }),
    ];
    const md = turnToMarkdown(extractTurns(events)[0], events, OPTS);

    expect(md).toContain('_(failed)_');
    expect(md).toContain('_(denied)_');
  });

  it('renders a layman explanation as an Obsidian callout', () => {
    const response = ev('agent_response', { prompt: 'done' });
    response.laymans = { explanation: 'Claude filled in the holes.\nThen it cut new ones.', model: 'x', latencyMs: 1, tokens: { input: 1, output: 1 } };
    const events = [ev('user_prompt', { prompt: 'go' }), response];

    const md = turnToMarkdown(extractTurns(events)[0], events, OPTS);

    expect(md).toContain('> [!info] In plain English');
    expect(md).toContain('> Claude filled in the holes.');
    expect(md).toContain('> Then it cut new ones.');
  });

  it('suppresses the callout when analysis is disabled', () => {
    const response = ev('agent_response', { prompt: 'done' });
    response.laymans = { explanation: 'hidden', model: 'x', latencyMs: 1, tokens: { input: 1, output: 1 } };
    const events = [ev('user_prompt', { prompt: 'go' }), response];

    expect(turnToMarkdown(extractTurns(events)[0], events, { ...OPTS, includeAnalysis: false }))
      .not.toContain('In plain English');
  });

  it('says so when a turn produced no response', () => {
    const events = [ev('user_prompt', { prompt: 'unanswered' })];
    const md = turnToMarkdown(extractTurns(events)[0], events, OPTS);

    expect(md).toContain('_No agent response recorded for this turn._');
  });

  it('emits a block anchor only when requested', () => {
    const events = joystickEvents();
    const turn = extractTurns(events)[0];

    expect(turnToMarkdown(turn, events, OPTS)).not.toContain('^turn-');
    expect(turnToMarkdown(turn, events, { ...OPTS, blockAnchors: true })).toContain('^turn-p1');
  });

  it('honours the heading level', () => {
    const events = joystickEvents();
    const md = turnToMarkdown(extractTurns(events)[0], events, { ...OPTS, headingLevel: 4 });

    expect(md).toMatch(/^#### 1 · /m);
  });
});

describe('sessionToMarkdown', () => {
  const session: RecordedSession = {
    sessionId: 'sess-1',
    cwd: '/Users/sc/development/castellotti/3D/joystick',
    agentType: 'claude-code',
    startedAt: 0,
    lastSeen: 0,
  };

  it('titles from the session name, falling back to the cwd basename', () => {
    const events = joystickEvents();
    const turns = extractTurns(events);

    expect(sessionToMarkdown(session, turns, events, OPTS)).toContain('# joystick');
    expect(sessionToMarkdown({ ...session, sessionName: 'Panel plugs' }, turns, events, OPTS))
      .toContain('# Panel plugs');
  });

  it('links back to the instance and renders every turn', () => {
    const events = [
      ...joystickEvents(),
      ev('user_prompt', { prompt: 'now clean up' }, { id: 'p2' }),
      ev('agent_response', { prompt: 'removed the temp dir' }, { id: 'r3' }),
    ];
    const md = sessionToMarkdown(session, extractTurns(events), events, OPTS);

    expect(md).toContain('[Open in Layman](http://nyx.local:8880/s/sess-1)');
    expect(md).toContain('## 1 · plug the original holes');
    expect(md).toContain('## 2 · now clean up');
  });

  it('handles a session with no turns', () => {
    expect(sessionToMarkdown(session, [], [], OPTS)).toContain('_No turns recorded in this session._');
  });
});

describe('describeToolCall', () => {
  it('picks the most identifying argument', () => {
    expect(describeToolCall(ev('tool_call_completed', { toolInput: { command: 'ls -la' } }))).toBe('ls -la');
    expect(describeToolCall(ev('tool_call_completed', { toolInput: { file_path: '/a/b.ts' } }))).toBe('/a/b.ts');
    expect(describeToolCall(ev('tool_call_completed', { toolInput: {} }))).toBe('');
  });

  it("uses a search's pattern, not the directory it searched", () => {
    // Mirrors eventDetail() in packages/web/src/lib/event-styles.ts — an export
    // and the live dashboard must summarise the same call identically.
    expect(describeToolCall(ev('tool_call_completed', {
      toolName: 'Grep', toolInput: { pattern: 'TODO', path: '/repo' },
    }))).toBe('TODO');
  });

  it('flattens newlines and truncates', () => {
    const long = describeToolCall(ev('tool_call_completed', { toolInput: { command: `a\n${'x'.repeat(200)}` } }));

    expect(long).not.toContain('\n');
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('firstLine', () => {
  it('skips leading blank lines and truncates', () => {
    expect(firstLine('\n\n  hello  \nworld')).toBe('hello');
    expect(firstLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(firstLine('')).toBe('');
  });
});

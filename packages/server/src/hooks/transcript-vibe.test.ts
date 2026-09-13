import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  discoverVibeSessionsUnder,
  discoverGloveVibeSessions,
  parseVibeTranscript,
} from './transcript-vibe.js';

const SESSION_ID = '2e914bdc-f84c-c3e3-85ea-7b664886ba5f';
const START = '2026-09-05T05:46:28.000Z';
const END = '2026-09-05T06:00:00.000Z';

const META = {
  session_id: SESSION_ID,
  start_time: START,
  end_time: END,
  environment: { working_directory: '/work' },
};

const MESSAGES = [
  { role: 'user', content: 'hello there', message_id: 'm1' },
  // reasoning-only assistant message (no content) — must still be recorded
  { role: 'assistant', reasoning_content: 'let me think', message_id: 'm2' },
  {
    role: 'assistant',
    content: 'running a command',
    message_id: 'm3',
    tool_calls: [
      { id: 'call_1', function: { name: 'bash', arguments: '{"command":"ls -la /work"}' } },
    ],
  },
  { role: 'tool', name: 'bash', tool_call_id: 'call_1', content: 'total 0\n' },
  { role: 'system', content: 'ignored' },
];

/** Build a `.vibe/logs/session` tree under `base` with one session dir. */
function seedSession(base: string, dirName = 'session_20260905_054628_2e914bdc'): void {
  const dir = join(base, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(META));
  writeFileSync(join(dir, 'messages.jsonl'), MESSAGES.map((m) => JSON.stringify(m)).join('\n') + '\n');
  // The lock dir Vibe keeps alongside sessions must be ignored (no meta.json).
  mkdirSync(join(base, 'active'), { recursive: true });
  writeFileSync(join(base, 'active', 'x.lock'), '');
}

describe('transcript-vibe', () => {
  let root: string;
  let base: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vibe-import-'));
    base = join(root, '.vibe', 'logs', 'session');
    mkdirSync(base, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('discovers a session from meta.json and skips the active/ lock dir', () => {
    seedSession(base);
    const found = discoverVibeSessionsUnder(base, 'vibe-local');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      sessionId: SESSION_ID,
      agentType: 'mistral-vibe',
      cwd: '/work',
      label: 'vibe-local',
    });
    expect(found[0].path.endsWith('messages.jsonl')).toBe(true);
  });

  it('returns nothing for a missing base dir', () => {
    expect(discoverVibeSessionsUnder(join(root, 'nope'))).toEqual([]);
  });

  it('parses messages into ordered, uniquely-identified events', () => {
    seedSession(base);
    const found = discoverVibeSessionsUnder(base);
    const lines = MESSAGES.map((m) => JSON.stringify(m));
    const { events } = parseVibeTranscript(lines, found[0].sessionId);

    const byType = events.reduce<Record<string, number>>((m, e) => {
      m[e.type] = (m[e.type] ?? 0) + 1;
      return m;
    }, {});
    // 1 user, 2 assistant (reasoning-only + text), 1 tool result; system ignored.
    expect(byType).toEqual({ user_prompt: 1, agent_response: 2, tool_call_completed: 1 });

    // reasoning-only message kept, with empty prompt and its thinking preserved
    const reasoningOnly = events.find((e) => e.type === 'agent_response' && e.data.prompt === '');
    expect(reasoningOnly?.data.thinking).toBe('let me think');

    // tool call fully resolved (name mapped, arguments parsed, output attached)
    const tool = events.find((e) => e.type === 'tool_call_completed');
    expect(tool?.data.toolName).toBe('Bash');
    expect((tool?.data.toolInput as { command?: string }).command).toBe('ls -la /work');
    expect(tool?.data.toolOutput).toBe('total 0\n');

    // ids unique, timestamps monotonic and inside the meta.json span
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }
    expect(events[0].timestamp).toBe(new Date(START).getTime());
    expect(events[events.length - 1].timestamp).toBeLessThanOrEqual(new Date(END).getTime());
  });

  it('emits a trailing tool_call_pending for a tool that never returned', () => {
    seedSession(base);
    discoverVibeSessionsUnder(base); // populate the session span
    const lines = [
      JSON.stringify({ role: 'user', content: 'go', message_id: 'm1' }),
      JSON.stringify({
        role: 'assistant',
        message_id: 'm2',
        tool_calls: [{ id: 'call_x', function: { name: 'bash', arguments: '{"command":"sleep 999"}' } }],
      }),
    ];
    const { events } = parseVibeTranscript(lines, SESSION_ID);
    expect(events.some((e) => e.type === 'tool_call_pending')).toBe(true);
  });

  it('discoverGloveVibeSessions scans each root with its env-id label', () => {
    seedSession(base);
    const found = discoverGloveVibeSessions([{ path: base, label: 'vibe-local' }]);
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe('vibe-local');
  });
});

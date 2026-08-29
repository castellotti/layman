import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { EventStore } from '../events/store.js';
import { SessionRecorder } from '../db/recorder.js';
import type { Database } from '../db/database.js';
import type { discoverTranscriptFiles as DiscoverFn, importHistoricalSessions as ImportFn } from './recovery.js';

/**
 * discoverClaudeCodeTranscripts()/discoverPiSessions() resolve homedir() at
 * call time (not module load, unlike installer.ts's OPTIONAL_CLIENTS), so a
 * plain redirect is enough — no vi.resetModules() dance needed.
 */
let home: string;

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => home };
});

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'pi');

/**
 * A minimal in-memory stand-in for better-sqlite3's Database, covering only
 * the exact statement shapes SessionRecorder.importSession() and
 * importHistoricalSessions() issue. The wider test suite avoids a real
 * database entirely (better-sqlite3 has no prebuild for this Node ABI —
 * see turns/store.test.ts), so this follows the same convention.
 */
class FakeDb {
  sessions = new Map<string, { session_id: string; cwd: string; agent_type: string; started_at: number; last_seen: number; source: string; session_name: string | null }>();
  events = new Map<string, { id: string; session_id: string; type: string; timestamp: number }>();

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return fn;
  }

  prepare(sql: string) {
    const db = this;
    if (sql.includes('INSERT INTO recorded_sessions')) {
      return {
        run(sessionId: string, cwd: string, agentType: string, startedAt: number, lastSeen: number, source: string, sessionName: string | null = null) {
          const existing = db.sessions.get(sessionId);
          if (!existing) {
            db.sessions.set(sessionId, { session_id: sessionId, cwd, agent_type: agentType, started_at: startedAt, last_seen: lastSeen, source, session_name: sessionName });
          } else {
            db.sessions.set(sessionId, {
              ...existing,
              last_seen: Math.max(existing.last_seen, lastSeen),
              cwd: existing.cwd === '' ? cwd : existing.cwd,
              source: existing.source === 'live' ? 'live' : source,
              // COALESCE(existing, excluded): keep an existing name, else take the new one.
              session_name: existing.session_name ?? sessionName,
            });
          }
        },
      };
    }
    if (sql.includes('INSERT OR IGNORE INTO recorded_events')) {
      return {
        run(id: string, sessionId: string, type: string, timestamp: number) {
          if (db.events.has(id)) return;
          db.events.set(id, { id, session_id: sessionId, type, timestamp });
        },
      };
    }
    if (sql.includes('SELECT session_id, source FROM recorded_sessions')) {
      return { all: () => Array.from(db.sessions.values()).map((s) => ({ session_id: s.session_id, source: s.source })) };
    }
    if (sql.includes('MAX(timestamp)')) {
      return {
        get: (sessionId: string) => {
          const rows = Array.from(db.events.values()).filter((e) => e.session_id === sessionId);
          return { max_ts: rows.length ? Math.max(...rows.map((r) => r.timestamp)) : null };
        },
      };
    }
    if (sql.includes('SELECT id FROM recorded_events')) {
      return {
        all: (sessionId: string) =>
          Array.from(db.events.values())
            .filter((e) => e.session_id === sessionId)
            .map((e) => ({ id: e.id })),
      };
    }
    // SessionRecorder's constructor eagerly prepares statements for paths
    // these tests never exercise (the live event:new/event:update listeners,
    // recordQA) — a harmless no-op keeps construction from throwing.
    return { run: () => {}, get: () => undefined, all: () => [] };
  }
}

function makeRecorder(db: FakeDb): SessionRecorder {
  return new SessionRecorder(db as unknown as Database, () => true, () => false);
}

const CC_SESSION_ID = '33333333-3333-3333-3333-333333333333';
const PI_SESSION_ID = '01a02406-03d8-7522-876a-b3018042bb23';

function writeClaudeCodeFixture(): void {
  const projectDir = join(home, '.claude', 'projects', '-Users-test-cc-project');
  mkdirSync(projectDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: 'user', uuid: '11111111-1111-1111-1111-111111111111',
      timestamp: '2026-08-21T09:00:00.000Z', cwd: '/Users/test/cc-project', version: '1.2.3',
      message: { role: 'user', content: 'Hello agent' },
    }),
    JSON.stringify({
      type: 'assistant', uuid: '22222222-2222-2222-2222-222222222222',
      timestamp: '2026-08-21T09:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
    }),
  ];
  writeFileSync(join(projectDir, `${CC_SESSION_ID}.jsonl`), lines.join('\n') + '\n');
}

function writePiFixture(): string {
  const sessionsDir = join(home, '.pi', 'agent', 'sessions', '--Users-test-pi-project--');
  mkdirSync(sessionsDir, { recursive: true });
  const content = readFileSync(join(FIXTURES_DIR, 'linear.jsonl'), 'utf-8')
    .replace('aaaaaaaa-0000-7000-8000-000000000000', PI_SESSION_ID);
  const path = join(sessionsDir, `2026-08-21T09-00-00-000Z_${PI_SESSION_ID}.jsonl`);
  writeFileSync(path, content);
  return path;
}

const GLOVE_PI_SESSION_ID = '44444444-4444-4444-4444-444444444444';

/**
 * Write a pi transcript inside a glove sandbox home and return the pi watch
 * root (`.../.pi/agent/sessions`) a GloveSource would report for it, plus the
 * env id label. Sits outside `home` deliberately — a glove session lives under
 * the glove sessions dir, not the native pi home.
 */
function writeGlovePiFixture(envId: string): { root: string; label: string } {
  const sessionsDir = join(home, '.glove', 'envs', envId, 'home', '.pi', 'agent', 'sessions');
  const projectDir = join(sessionsDir, '--Users-test-pi-project--');
  mkdirSync(projectDir, { recursive: true });
  const content = readFileSync(join(FIXTURES_DIR, 'linear.jsonl'), 'utf-8')
    .replace('aaaaaaaa-0000-7000-8000-000000000000', GLOVE_PI_SESSION_ID);
  writeFileSync(join(projectDir, `2026-08-21T09-00-00-000Z_${GLOVE_PI_SESSION_ID}.jsonl`), content);
  return { root: sessionsDir, label: envId };
}

let discoverTranscriptFiles: typeof DiscoverFn;
let importHistoricalSessions: typeof ImportFn;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'layman-recovery-home-'));
  vi.resetModules();
  ({ discoverTranscriptFiles, importHistoricalSessions } = await import('./recovery.js'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('discoverTranscriptFiles', () => {
  it('finds nothing when neither harness has a sessions directory', () => {
    expect(discoverTranscriptFiles()).toEqual([]);
  });

  it('merges claude-code and pi discoverers into one list', () => {
    writeClaudeCodeFixture();
    writePiFixture();

    const found = discoverTranscriptFiles();
    expect(found).toHaveLength(2);

    const cc = found.find((f) => f.agentType === 'claude-code')!;
    expect(cc).toBeDefined();
    expect(cc.sessionId).toBe(CC_SESSION_ID);

    const pi = found.find((f) => f.agentType === 'pi')!;
    expect(pi).toBeDefined();
    expect(pi.sessionId).toBe(PI_SESSION_ID);
    // Directory-name-decoded cwd is a lossy fallback (dashes and path
    // separators are indistinguishable once collapsed) — the pi parser
    // prefers the session file's own header cwd, which importHistoricalSessions
    // uses instead of this value.
    expect(pi.cwd).toBe('/Users/test/pi/project');
  });

  it('ignores glove roots by default (none passed) but discovers pi sessions under them when given', () => {
    const { root, label } = writeGlovePiFixture('pi-local');

    // Without glove roots, the native scan finds nothing here.
    expect(discoverTranscriptFiles()).toEqual([]);

    const found = discoverTranscriptFiles([{ path: root, agentType: 'pi', label }]);
    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe(GLOVE_PI_SESSION_ID);
    expect(found[0].agentType).toBe('pi');
    expect(found[0].label).toBe('pi-local');
  });

  it('does not scan a non-pi glove root (vibe has no history importer)', () => {
    const { root } = writeGlovePiFixture('both');
    // A vibe-typed root pointing at the same tree must be ignored, not parsed as pi.
    expect(discoverTranscriptFiles([{ path: root, agentType: 'mistral-vibe', label: 'both' }])).toEqual([]);
  });
});

describe('importHistoricalSessions', () => {
  it('imports a claude-code session unchanged after the registry refactor (regression)', async () => {
    writeClaudeCodeFixture();
    const db = new FakeDb();
    const recorder = makeRecorder(db);
    const eventStore = new EventStore();

    const result = await importHistoricalSessions(db as unknown as Database, eventStore, recorder);

    expect(result.discovered).toBe(1);
    expect(result.errors).toBe(0);
    const session = result.sessions[0];
    expect(session.sessionId).toBe(CC_SESSION_ID);
    expect(session.agentType).toBe('claude-code');
    expect(session.cwd).toBe('/Users/test/cc-project');
    expect(session.userPromptCount).toBe(1);
    expect(session.eventCount).toBeGreaterThan(0);
    expect(db.sessions.get(CC_SESSION_ID)?.source).toBe('imported');
  });

  it('imports an unknown pi session tagged with agent_type "pi" (mis-attribution guard)', async () => {
    writePiFixture();
    const db = new FakeDb();
    const recorder = makeRecorder(db);
    const eventStore = new EventStore();

    const result = await importHistoricalSessions(db as unknown as Database, eventStore, recorder);

    expect(result.discovered).toBe(1);
    const session = result.sessions[0];
    expect(session.sessionId).toBe(PI_SESSION_ID);
    expect(session.agentType).toBe('pi');
    // The parser's own header cwd wins over the discoverer's decoded fallback.
    expect(session.cwd).toBe('/Users/test/project');
    expect(db.sessions.get(PI_SESSION_ID)?.agent_type).toBe('pi');
    // Per-event agent_type: transcript-pi.test.ts's "tags every event with
    // agentType 'pi'" test covers the parser output directly; FakeDb doesn't
    // retain that column, so it isn't re-checked through the DB layer here.
  });

  it('imports a gloved pi session from a glove root and tags it with the env id', async () => {
    const { root, label } = writeGlovePiFixture('pi-local');
    const db = new FakeDb();
    const recorder = makeRecorder(db);
    const eventStore = new EventStore();

    const result = await importHistoricalSessions(db as unknown as Database, eventStore, recorder, {
      gloveRoots: [{ path: root, agentType: 'pi', label }],
    });

    expect(result.discovered).toBe(1);
    const session = result.sessions[0];
    expect(session.sessionId).toBe(GLOVE_PI_SESSION_ID);
    expect(session.agentType).toBe('pi');
    // The env id rides through to the session name, so the gloved import is
    // tagged just like a passively-watched gloved session.
    expect(db.sessions.get(GLOVE_PI_SESSION_ID)?.session_name).toBe('pi-local');
  });

  it('re-scanning an already-imported session finds nothing new (idempotent)', async () => {
    writeClaudeCodeFixture();
    writePiFixture();
    const db = new FakeDb();
    const recorder = makeRecorder(db);
    const eventStore = new EventStore();

    await importHistoricalSessions(db as unknown as Database, eventStore, recorder);
    const eventCountAfterFirstScan = db.events.size;

    const second = await importHistoricalSessions(db as unknown as Database, eventStore, recorder, { enrichExisting: true });

    expect(second.discovered).toBe(0);
    expect(second.enriched).toBe(0);
    expect(second.skipped).toBe(2);
    expect(db.events.size).toBe(eventCountAfterFirstScan);
  });

  it('enriches rather than duplicates a session already recorded live, and does not downgrade its status', async () => {
    const piPath = writePiFixture();
    const db = new FakeDb();
    const recorder = makeRecorder(db);
    const eventStore = new EventStore();

    // Simulate live recording *as it actually happens*: EventStore.add() mints
    // `randomUUID()` ids, which never match the deterministic ones the pi parser
    // derives from the transcript. Recording the parser's own events here would
    // hand INSERT OR IGNORE a set of ids to collide with and hide the very
    // duplication this test exists to catch.
    const { parsePiTranscript } = await import('./transcript-pi.js');
    const lines = readFileSync(piPath, 'utf-8').trim().split('\n').filter(Boolean);
    const { events } = parsePiTranscript(lines, PI_SESSION_ID);
    const liveEvents = events.map((e) => ({ ...e, id: randomUUID() }));
    recorder.importSession(PI_SESSION_ID, '/Users/test/project', 'pi', liveEvents, 'live');
    expect(db.sessions.get(PI_SESSION_ID)?.source).toBe('live');
    const eventCountAfterLiveRecording = db.events.size;

    const result = await importHistoricalSessions(db as unknown as Database, eventStore, recorder, { enrichExisting: true });

    expect(result.enriched).toBe(0); // nothing new — already fully recorded
    expect(result.skipped).toBe(1);
    expect(db.events.size).toBe(eventCountAfterLiveRecording); // no duplicate rows
    expect(db.sessions.get(PI_SESSION_ID)?.source).toBe('live'); // not downgraded to 'imported'
  });

  it('reports counts describing only what enrichment added, not the whole file', async () => {
    const piPath = writePiFixture();
    const db = new FakeDb();
    const recorder = makeRecorder(db);
    const eventStore = new EventStore();

    // An 'imported' session missing its tail: everything but the last two
    // events is already recorded, under the parser's own ids.
    const { parsePiTranscript } = await import('./transcript-pi.js');
    const lines = readFileSync(piPath, 'utf-8').trim().split('\n').filter(Boolean);
    const { events } = parsePiTranscript(lines, PI_SESSION_ID);
    expect(events.length).toBeGreaterThan(2);
    const missing = events.slice(-2);
    recorder.importSession(
      PI_SESSION_ID, '/Users/test/project', 'pi', events.slice(0, -2), 'imported'
    );

    const result = await importHistoricalSessions(db as unknown as Database, eventStore, recorder, { enrichExisting: true });

    expect(result.enriched).toBe(1);
    const session = result.sessions.find((s) => s.sessionId === PI_SESSION_ID)!;
    expect(session.eventCount).toBe(2);
    // The counts have to be over the added events too. Deriving them from the
    // full parse gave `eventCount: 2, toolCallCount: <every call in the file>`.
    expect(session.toolCallCount).toBe(missing.filter((e) => e.type === 'tool_call_completed').length);
    expect(session.userPromptCount).toBe(missing.filter((e) => e.type === 'user_prompt').length);
    expect(result.totalEvents).toBe(2);
  });
});

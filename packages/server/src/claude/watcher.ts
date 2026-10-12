/**
 * Watches glove-exported Claude Code transcripts and translates newly-appended
 * lines into Layman EventStore events — the passive path for a Claude Code run
 * inside a glove sandbox, which cannot reach Layman's hooks over the network.
 *
 * Native Claude Code is never tailed here: it is recorded over hooks (plus
 * transcript gap recovery), and tailing its transcript as well would record
 * every turn twice. Roots therefore come only from `GloveSource`, filtered to
 * `agentType === 'claude-code'`; there is no native Claude Code source.
 *
 * glove bind-mounts `observe/<id>/transcripts/` over the sandbox's
 * `~/.claude/projects`, so a root holds Claude Code's own layout:
 *
 *   <root>/-work/<uuid>.jsonl                          the main transcript
 *   <root>/-work/<uuid>/subagents/agent-<id>.jsonl     one per subagent
 *
 * Lines are parsed with `parseTranscriptLines()` from `hooks/recovery.ts`, the
 * same parser history import and gap recovery use, so there is no second
 * Claude Code parser to keep in sync. The session is the `sessionId` stamped on
 * the lines, not the filename (a resume/fork writes a new file that keeps the
 * original id), and a session is tracked once however many files it spans.
 *
 * Subagents are attributed the way the hook path attributes them: a subagent's
 * tool calls land in the parent session tagged `subagentId`, after one
 * `subagent_start` marker. Its prompt and prose are left out — they are the
 * Task tool's input and output, not a user turn, and a `user_prompt` here would
 * split the parent's turn in two.
 *
 * A sibling of `PiSessionWatcher` rather than a subclass, with its reliability
 * rules: scan-tick discovery, the recent/idle windows, replay-from-start for
 * young sessions skipping what the database already holds, tombstones that
 * resurrect when a file grows.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { EventStore } from '../events/store.js';
import type { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import { shouldActivateWatchedSession } from '../monitor/sources.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import type { TimelineEvent } from '../events/types.js';
import { buildEvent } from '../hooks/transcript-shared.js';
import { parseTranscriptLines, resolveClaudeCodeSessionId } from '../hooks/recovery.js';
import { emitTranscriptEvent, isRecorded, type RecordedCursor } from '../pi/watcher.js';

const AGENT_TYPE = 'claude-code';
const SCAN_INTERVAL_MS = 2000;
const RECENT_SESSION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
/** Sessions modified within this window are replayed from the beginning; older ones skip history. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
/** If no transcript file of the session has grown in this long, it is treated as ended. */
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const UUID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const SUBAGENT_FILE_RE = /^agent-(.+)\.jsonl$/;

interface TrackedFile {
  path: string;
  /** Byte size at the last read. Claude Code only appends, so an unchanged size means nothing new. */
  size: number;
  /** Set for a subagent transcript; its events are tagged with it. */
  subagentId?: string;
}

/**
 * One Claude Code session, however many files it spans: a resume/fork writes a
 * new main transcript under the same `sessionId`, and every subagent has its own
 * file. One entry per session means one idle timer, one `session_end` and one
 * resume, whichever file is growing.
 */
interface TrackedSession {
  sessionId: string;
  cwd: string;
  /** Every main transcript and subagent file of the session, keyed by path. */
  files: Map<string, TrackedFile>;
  /** `<project>/<file uuid>/subagents` of each main transcript, polled for new subagent files. */
  subagentDirs: Set<string>;
  /** Parser ids already emitted, across all of the session's files. */
  emittedIds: Set<string>;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastActivityMs: number;
  agentType: string;
  label?: string;
}

export class ClaudeCodeSessionWatcher {
  /** Tracked sessions, keyed by session id. */
  private sessions = new Map<string, TrackedSession>();
  /** Main transcripts already claimed by a session, so discovery skips them. */
  private mainFiles = new Set<string>();
  private activeRoots = new Map<string, WatchRoot>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private eventStore: EventStore,
    private gate: SessionGate,
    private getConfig: () => LaymanConfig,
    private sources: MonitorSource[],
    private recorded: (sessionId: string) => RecordedCursor | null = () => null,
  ) {}

  start(): void {
    this.reconcileRoots();
    this.scanExistingSessions();
    this.scanTimer = setInterval(() => {
      this.reconcileRoots();
      this.scanExistingSessions();
      this.cleanupEndedSessions();
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const session of this.sessions.values()) {
      if (session.pollTimer) clearInterval(session.pollTimer);
    }
    this.sessions.clear();
    this.mainFiles.clear();
    this.activeRoots.clear();
  }

  /** Keep only the sources' claude-code roots; the pi and vibe watchers claim the rest. */
  private reconcileRoots(): void {
    const desired = new Map<string, WatchRoot>();
    for (const source of this.sources) {
      for (const root of source.roots()) {
        if (root.agentType !== AGENT_TYPE) continue;
        if (!desired.has(root.path)) desired.set(root.path, root);
      }
    }
    for (const path of this.activeRoots.keys()) {
      if (!desired.has(path)) {
        this.activeRoots.delete(path);
        console.log(`[claude-code] Stopped watching root ${path}`);
      }
    }
    for (const [path, root] of desired) {
      if (this.activeRoots.has(path)) continue;
      this.activeRoots.set(path, root);
      const tag = root.label ? ` (glove: ${root.label})` : '';
      console.log(`[claude-code] Watching root ${path}${tag}`);
    }
  }

  /** Enumerate `<root>/<project>/<uuid>.jsonl` and register any recent, unclaimed main transcript. */
  private scanExistingSessions(): void {
    const now = Date.now();
    for (const root of this.activeRoots.values()) {
      for (const projectDir of listDir(root.path)) {
        const projectPath = join(root.path, projectDir);
        if (!isDirectory(projectPath)) continue;
        for (const file of listDir(projectPath)) {
          const m = UUID_FILE_RE.exec(file);
          if (!m) continue;
          const filePath = join(projectPath, file);
          if (this.mainFiles.has(filePath)) continue;
          try {
            const stat = statSync(filePath);
            if (!stat.isFile() || now - stat.mtimeMs > RECENT_SESSION_THRESHOLD_MS) continue;
          } catch {
            continue;
          }
          this.tryAddMainFile(filePath, join(projectPath, m[1], 'subagents'), projectDir, root, m[1]);
        }
      }
    }
  }

  /**
   * Claim a main transcript: start tracking its session, or, when its lines name
   * a session already tracked (a resume/fork), add it to that session.
   */
  private tryAddMainFile(mainFile: string, subagentDir: string, projectDir: string, root: WatchRoot, fileUuid: string): void {
    // Size before read: a concurrent append can only make it an under-estimate (re-read, deduped).
    const size = sizeOf(mainFile);
    const lines = readLines(mainFile);
    // Empty or unreadable: Claude Code has not written its first line yet. Try next scan.
    if (!lines || lines.length === 0) return;

    const sessionId = resolveClaudeCodeSessionId(lines) ?? fileUuid;
    const { events, metadata } = mainFileEvents(lines, sessionId);

    let session = this.sessions.get(sessionId);
    const known = !!session;
    if (!session) {
      const cwd = metadata.cwd || projectDir.replace(/-/g, '/');
      session = {
        sessionId, cwd, files: new Map(), subagentDirs: new Set(), emittedIds: new Set(),
        pollTimer: null, lastActivityMs: Date.now(), agentType: root.agentType, label: root.label,
      };
      this.sessions.set(sessionId, session);
      if (shouldActivateWatchedSession(root.agentType, root.label, this.getConfig().autoActivateClients)) {
        this.gate.activate(sessionId);
      }
      this.eventStore.trackSession(sessionId, cwd, root.agentType, undefined, root.label);
      if (root.label) this.eventStore.markGloved(sessionId);
      this.eventStore.add('session_start', sessionId, { source: 'startup' }, undefined, root.agentType);
    }
    this.mainFiles.add(mainFile);
    session.files.set(mainFile, { path: mainFile, size });
    session.subagentDirs.add(subagentDir);
    const tag = root.label ? ` [glove: ${root.label}]` : '';
    console.log(`[claude-code] Tracking session ${sessionId.slice(0, 8)} (${basename(mainFile)})${tag}`);

    const all = [...events, ...this.discoverSubagents(session).flatMap((f) => this.readFile(session!, f, true) ?? [])];
    const lastTouchedMs = metadata.lastTimestamp || mtimeOf(mainFile);
    if (Date.now() - lastTouchedMs < REPLAY_WINDOW_MS) {
      // Replaying re-sends what a previous run recorded under fresh live ids; skip what the database holds.
      const done = this.recorded(sessionId);
      if (done) for (const ev of all) if (isRecorded(ev, done)) session.emittedIds.add(ev.id);
      const fresh = all.filter((ev) => !session!.emittedIds.has(ev.id)).sort(byTime);
      // A resume file of a session that had already ended brings it back.
      if (known && !session.pollTimer && fresh.length > 0) this.wake(session);
      this.emitNew(session, fresh);
      if (fresh.length > 0) session.lastActivityMs = Date.now();
    } else {
      // Old file: adopt its history as emitted, so only future turns are recorded.
      for (const ev of all) session.emittedIds.add(ev.id);
    }

    if (!known) session.pollTimer = setInterval(() => this.pollSession(session!), SCAN_INTERVAL_MS);
  }

  /** Register subagent files not yet tracked, returning the new ones (with size 0, so they are read). */
  private discoverSubagents(session: TrackedSession): TrackedFile[] {
    const added: TrackedFile[] = [];
    for (const dir of session.subagentDirs) {
      for (const file of listDir(dir)) {
        const m = SUBAGENT_FILE_RE.exec(file);
        if (!m) continue;
        const path = join(dir, file);
        if (session.files.has(path)) continue;
        const tracked: TrackedFile = { path, size: 0, subagentId: m[1] };
        session.files.set(path, tracked);
        added.push(tracked);
      }
    }
    return added;
  }

  /**
   * Re-read one file if it grew, returning its parsed events (all of them; the
   * caller dedupes by id), or null when it has not grown. `force` reads it
   * regardless, for the first read of a newly found file.
   */
  private readFile(session: TrackedSession, file: TrackedFile, force = false): TimelineEvent[] | null {
    const size = sizeOf(file.path);
    if (!force && size <= file.size) return null;
    const lines = readLines(file.path);
    if (!lines) return null;
    file.size = size;
    if (file.subagentId === undefined) return mainFileEvents(lines, session.sessionId).events;
    return subagentEvents(lines, session.sessionId, file.subagentId);
  }

  /** Every new event across the session's files, in transcript order. */
  private readGrown(session: TrackedSession): TimelineEvent[] {
    const fresh = this.discoverSubagents(session);
    const out: TimelineEvent[] = [];
    for (const file of session.files.values()) {
      const events = this.readFile(session, file, fresh.includes(file));
      if (events) out.push(...events.filter((ev) => !session.emittedIds.has(ev.id)));
    }
    return out.sort(byTime);
  }

  private pollSession(session: TrackedSession): void {
    const events = this.readGrown(session);
    if (events.length === 0) return;
    this.emitNew(session, events);
    session.lastActivityMs = Date.now();
  }

  private emitNew(session: TrackedSession, events: TimelineEvent[]): void {
    for (const ev of events) {
      if (session.emittedIds.has(ev.id)) continue;
      emitTranscriptEvent(this.eventStore, session.sessionId, session.agentType, ev);
      session.emittedIds.add(ev.id);
    }
  }

  private cleanupEndedSessions(): void {
    for (const session of this.sessions.values()) {
      // Tombstone: the only place a resumed session comes back (discovery skips claimed files).
      if (!session.pollTimer) {
        this.tryResumeSession(session);
        continue;
      }
      const idleMs = Date.now() - session.lastActivityMs;
      if (idleMs < SESSION_IDLE_TIMEOUT_MS) continue;

      // One final poll before declaring the session over, in case a late write landed.
      const before = session.emittedIds.size;
      this.pollSession(session);
      if (session.emittedIds.size > before) continue;

      this.eventStore.add('session_end', session.sessionId, {}, undefined, session.agentType);
      // Suspend rather than deactivate, so a manual deactivation survives a resume (see SessionGate).
      this.gate.suspend(session.sessionId);
      clearInterval(session.pollTimer);
      session.pollTimer = null;
      console.log(`[claude-code] Session ${session.sessionId.slice(0, 8)} ended (idle ${Math.round(idleMs / 60000)}m)`);
    }
  }

  private tryResumeSession(session: TrackedSession): void {
    const events = this.readGrown(session);
    if (events.length === 0) return;
    this.wake(session);
    this.emitNew(session, events);
  }

  /** Bring a tombstoned session back: a `resumed` marker, its activation restored, polling again. */
  private wake(session: TrackedSession): void {
    const lastStored = this.eventStore.findLast((e) => e.sessionId === session.sessionId);
    const resumedAt = Date.now();
    const gapMinutes = lastStored ? Math.round((resumedAt - lastStored.timestamp) / 60000) : 0;

    this.eventStore.trackSession(session.sessionId, session.cwd, session.agentType, undefined, session.label);
    this.eventStore.add('session_start', session.sessionId, { source: 'resumed', gapMinutes }, undefined, session.agentType);
    this.gate.resume(session.sessionId);
    session.lastActivityMs = resumedAt;
    session.pollTimer = setInterval(() => this.pollSession(session), SCAN_INTERVAL_MS);
    console.log(`[claude-code] Session ${session.sessionId.slice(0, 8)} resumed (gap ${gapMinutes}m)`);
  }
}

/**
 * A main transcript's events. Older Claude Code versions wrote subagent
 * (sidechain) lines into the main transcript; those are grouped by `agentId`
 * and attributed as a subagent file's are (`subagentEvents`), never as the main
 * session's turns.
 */
export function mainFileEvents(lines: string[], sessionId: string): ReturnType<typeof parseTranscriptLines> {
  const main: string[] = [];
  const sidechains = new Map<string, string[]>();
  for (const line of lines) {
    let obj: Record<string, unknown> | null = null;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { /* left to the parser, which skips it */ }
    if (obj?.isSidechain !== true) {
      main.push(line);
      continue;
    }
    const agentId = typeof obj.agentId === 'string' && obj.agentId ? obj.agentId : 'sidechain';
    sidechains.set(agentId, [...(sidechains.get(agentId) ?? []), line]);
  }
  const parsed = parseTranscriptLines(main, sessionId, AGENT_TYPE);
  const side = [...sidechains].flatMap(([agentId, ls]) => subagentEvents(ls, sessionId, agentId));
  return { events: [...parsed.events, ...side], metadata: parsed.metadata };
}

/**
 * A subagent transcript's contribution to its parent session: a
 * `subagent_start` marker, then its tool calls tagged `subagentId`, as the hook
 * path tags them on `SubagentStop`. Ids come from the line uuids, so they are as
 * stable as the main transcript's.
 */
export function subagentEvents(lines: string[], sessionId: string, fallbackAgentId: string): TimelineEvent[] {
  let subagentId = fallbackAgentId;
  for (const line of lines) {
    const m = /"agentId"\s*:\s*"([^"]+)"/.exec(line);
    if (m) { subagentId = m[1]; break; }
  }
  const { events, metadata } = parseTranscriptLines(lines, sessionId, AGENT_TYPE);
  const tools = events
    .filter((e) => e.type === 'tool_call_completed')
    .map((e) => ({ ...e, data: { ...e.data, subagentId } }));
  if (metadata.firstTimestamp === 0) return tools;
  const start = buildEvent(`${sessionId}_subagent_${subagentId}`, 'subagent_start', sessionId, AGENT_TYPE, metadata.firstTimestamp, { subagentId });
  return [start, ...tools];
}

const byTime = (a: TimelineEvent, b: TimelineEvent) => a.timestamp - b.timestamp;

function listDir(path: string): string[] {
  try {
    return existsSync(path) ? readdirSync(path) : [];
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readLines(filePath: string): string[] | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.length === 0 ? [] : content.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function mtimeOf(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function sizeOf(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

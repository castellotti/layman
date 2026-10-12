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
 * original id), and every file of one session shares one set of emitted ids.
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

interface TrackedSession {
  sessionId: string;
  cwd: string;
  /** The main transcript, which keys the session in `sessions`. */
  mainFile: string;
  /** `<project>/<file uuid>/subagents`, polled for new subagent files. */
  subagentDir: string;
  files: Map<string, TrackedFile>;
  /** Parser ids already emitted. Shared by every tracked file of the same `sessionId`. */
  emittedIds: Set<string>;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastActivityMs: number;
  agentType: string;
  label?: string;
}

export class ClaudeCodeSessionWatcher {
  /** Tracked sessions, keyed by absolute main-transcript path. */
  private sessions = new Map<string, TrackedSession>();
  /** Emitted ids per session id, so a resume/fork file of a tracked session does not re-emit. */
  private emittedBySession = new Map<string, Set<string>>();
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
    this.emittedBySession.clear();
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

  /** Enumerate `<root>/<project>/<uuid>.jsonl` and register any recent, untracked main transcript. */
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
          if (this.sessions.has(filePath)) continue;
          try {
            const stat = statSync(filePath);
            if (!stat.isFile() || now - stat.mtimeMs > RECENT_SESSION_THRESHOLD_MS) continue;
          } catch {
            continue;
          }
          this.tryAddSession(filePath, join(projectPath, m[1], 'subagents'), projectDir, root, m[1]);
        }
      }
    }
  }

  private tryAddSession(mainFile: string, subagentDir: string, projectDir: string, root: WatchRoot, fileUuid: string): void {
    // Size before read: a concurrent append can only make it an under-estimate (re-read, deduped).
    const size = sizeOf(mainFile);
    const lines = readLines(mainFile);
    // Empty or unreadable: Claude Code has not written its first line yet. Try next scan.
    if (!lines || lines.length === 0) return;

    const sessionId = resolveClaudeCodeSessionId(lines) ?? fileUuid;
    const { events, metadata } = parseTranscriptLines(mainLines(lines), sessionId, AGENT_TYPE);
    const cwd = metadata.cwd || projectDir.replace(/-/g, '/');

    // A second file of a session already tracked (a resume/fork) shares its ids and its start.
    const known = this.emittedBySession.get(sessionId);
    const emittedIds = known ?? new Set<string>();
    this.emittedBySession.set(sessionId, emittedIds);
    if (!known) {
      if (shouldActivateWatchedSession(root.agentType, root.label, this.getConfig().autoActivateClients)) {
        this.gate.activate(sessionId);
      }
      this.eventStore.trackSession(sessionId, cwd, root.agentType, undefined, root.label);
      if (root.label) this.eventStore.markGloved(sessionId);
      this.eventStore.add('session_start', sessionId, { source: 'startup' }, undefined, root.agentType);
    }
    const tag = root.label ? ` [glove: ${root.label}]` : '';
    console.log(`[claude-code] Tracking session ${sessionId.slice(0, 8)} (${basename(mainFile)})${tag}`);

    const session: TrackedSession = {
      sessionId, cwd, mainFile, subagentDir,
      files: new Map([[mainFile, { path: mainFile, size }]]),
      emittedIds, pollTimer: null, lastActivityMs: Date.now(), agentType: root.agentType, label: root.label,
    };
    this.sessions.set(mainFile, session);

    const lastTouchedMs = metadata.lastTimestamp || mtimeOf(mainFile);
    const isRecent = Date.now() - lastTouchedMs < REPLAY_WINDOW_MS;
    const all = [...events, ...this.discoverSubagents(session).flatMap((f) => this.readFile(session, f, true) ?? [])];
    if (isRecent) {
      // Replaying re-sends what a previous run recorded under fresh live ids; skip what the database holds.
      const done = this.recorded(sessionId);
      if (done) for (const ev of all) if (isRecorded(ev, done)) emittedIds.add(ev.id);
      this.emitNew(session, all.sort(byTime));
    } else {
      // Old session: adopt its history as emitted, so only future turns are recorded.
      for (const ev of all) emittedIds.add(ev.id);
    }

    session.pollTimer = setInterval(() => this.pollSession(session), SCAN_INTERVAL_MS);
  }

  /** Register subagent files not yet tracked, returning the new ones (with size 0, so they are read). */
  private discoverSubagents(session: TrackedSession): TrackedFile[] {
    const added: TrackedFile[] = [];
    for (const file of listDir(session.subagentDir)) {
      const m = SUBAGENT_FILE_RE.exec(file);
      if (!m) continue;
      const path = join(session.subagentDir, file);
      if (session.files.has(path)) continue;
      const tracked: TrackedFile = { path, size: 0, subagentId: m[1] };
      session.files.set(path, tracked);
      added.push(tracked);
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
    if (file.subagentId === undefined) return parseTranscriptLines(mainLines(lines), session.sessionId, AGENT_TYPE).events;
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
      // Tombstone: the only place a resumed session comes back (discovery skips tracked paths).
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

    const lastStored = this.eventStore.findLast((e) => e.sessionId === session.sessionId);
    const resumedAt = Date.now();
    const gapMinutes = lastStored ? Math.round((resumedAt - lastStored.timestamp) / 60000) : 0;

    this.eventStore.trackSession(session.sessionId, session.cwd, session.agentType, undefined, session.label);
    this.eventStore.add('session_start', session.sessionId, { source: 'resumed', gapMinutes }, undefined, session.agentType);
    this.gate.resume(session.sessionId);

    this.emitNew(session, events);
    session.lastActivityMs = resumedAt;
    session.pollTimer = setInterval(() => this.pollSession(session), SCAN_INTERVAL_MS);
    console.log(`[claude-code] Session ${session.sessionId.slice(0, 8)} resumed (gap ${gapMinutes}m)`);
  }
}

/**
 * The main session's own lines. Older Claude Code versions wrote subagent
 * (sidechain) lines into the main transcript; they are attributed like a
 * subagent file's, never as the main session's turns.
 */
function mainLines(lines: string[]): string[] {
  return lines.filter((l) => !/"isSidechain"\s*:\s*true/.test(l));
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

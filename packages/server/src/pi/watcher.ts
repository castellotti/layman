/**
 * Watches pi session transcript files for newly-appended events and translates
 * them into Layman EventStore events — the passive, "outside looking in" path
 * that mirrors `vibe/watcher.ts`, used for glove-sandboxed pi runs (which
 * cannot reach Layman over the network) and native pi when no live extension
 * is installed.
 *
 * pi persists each session as a format-version-3 JSONL tree at
 * `<root>/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. This is one level
 * deeper than Vibe's `<root>/<dir>/messages.jsonl`, and the transcript is the
 * `.jsonl` file itself rather than a fixed name inside a per-session dir. We
 * reuse `parsePiTranscript()` — the same parser used for historical import —
 * so there is no second pi parser to keep in sync.
 *
 * Roots come from a list of `MonitorSource`s (the native `~/.pi/agent/sessions`
 * root plus any glove sandbox roots), re-queried on every scan tick so sandboxes
 * appearing or disappearing mid-run are picked up without a restart. Each root
 * carries the agent type and an optional sandbox label; a session inherits both.
 * See `../monitor/sources.ts`.
 *
 * A sibling class rather than a shared base with `VibeSessionWatcher`: the two
 * differ in enough load-bearing ways (a session is a *file* not a dir; the
 * transcript is a re-parsed tree, not a byte-appended log; there is no local
 * process to detect since a gloved pi runs in a container) that a shared base
 * would be mostly overrides. The reliability *patterns* are reused verbatim:
 * scan-tick reconciliation, the recent/idle windows, replay-from-start for
 * young sessions.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { EventStore } from '../events/store.js';
import type { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import type { TimelineEvent } from '../events/types.js';
import { extractAccess } from '../events/access-extractor.js';
import { parsePiTranscript, decodeCwd, sessionIdFromPiFilename } from '../hooks/transcript-pi.js';

const AGENT_TYPE = 'pi';
const SCAN_INTERVAL_MS = 2000;
const RECENT_SESSION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
/** Sessions modified within this window are replayed from the beginning; older ones skip history. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
/** If the transcript file hasn't grown in this long, the pi session is treated as ended. */
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

interface TrackedSession {
  sessionId: string;
  cwd: string;
  /** Absolute path to the session's `.jsonl` transcript. */
  file: string;
  /**
   * Ids of *committed* events already emitted to the store, keyed by the parser's
   * deterministic event id (`${sessionId}_${entryId}...`). Committed excludes
   * trailing `tool_call_pending` (an in-flight tool that has no result yet): a
   * pending shares its id with the `tool_call_completed` that replaces it once the
   * result lands, so it is simply not emitted until then. Tracking by id rather
   * than by count is what keeps re-emission stable when the parsed order shifts —
   * parallel tool calls can complete out of order, moving earlier positions, but
   * an id is emitted at most once regardless of where it lands.
   */
  emittedIds: Set<string>;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastActivityMs: number;
  /**
   * Byte size of the transcript at the last read. pi only appends, so a poll
   * whose file size hasn't grown has nothing new to parse and short-circuits
   * before the full re-read — the same guard `VibeSessionWatcher` gets from its
   * byte offset.
   */
  lastSize: number;
  agentType: string;
  label?: string;
}

export class PiSessionWatcher {
  private eventStore: EventStore;
  private gate: SessionGate;
  private getConfig: () => LaymanConfig;
  private sources: MonitorSource[];
  /** Tracked sessions, keyed by absolute transcript file path. */
  private sessions = new Map<string, TrackedSession>();
  /** Roots currently being scanned, keyed by absolute path. */
  private activeRoots = new Map<string, WatchRoot>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    eventStore: EventStore,
    gate: SessionGate,
    getConfig: () => LaymanConfig,
    sources: MonitorSource[],
  ) {
    this.eventStore = eventStore;
    this.gate = gate;
    this.getConfig = getConfig;
    this.sources = sources;
  }

  start(): void {
    this.reconcileRoots();
    this.scanExistingSessions();

    // The periodic scan is the sole discovery mechanism. fs.watch is unreliable
    // on Docker Desktop bind mounts, and pi writes transcript files one level
    // below the watched root — a root-level watcher wouldn't see new lines anyway
    // (appends are picked up by each session's poll timer, not by discovery).
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
    this.activeRoots.clear();
  }

  /**
   * Bring the set of scanned roots in line with what the sources currently
   * report. A glove source now emits both Vibe and pi roots; this watcher only
   * parses pi, so it ignores anything else (the vibe watcher claims those).
   */
  private reconcileRoots(): void {
    const desired = new Map<string, WatchRoot>();
    for (const source of this.sources) {
      for (const root of source.roots()) {
        if (root.agentType !== AGENT_TYPE) continue;
        // First source to claim a path wins; native precedes glove in the list.
        if (!desired.has(root.path)) desired.set(root.path, root);
      }
    }

    // Drop roots no longer reported. Sessions under them idle-timeout naturally.
    for (const path of this.activeRoots.keys()) {
      if (!desired.has(path)) {
        this.activeRoots.delete(path);
        console.log(`[pi] Stopped watching root ${path}`);
      }
    }

    // Add roots that appeared.
    for (const [path, root] of desired) {
      if (this.activeRoots.has(path)) continue;
      this.activeRoots.set(path, root);
      const tag = root.label ? ` (glove: ${root.label})` : '';
      console.log(`[pi] Watching root ${path}${tag}`);
    }
  }

  /** Enumerate `<root>/<encoded-cwd>/*.jsonl` and register any recent, untracked session file. */
  private scanExistingSessions(): void {
    const now = Date.now();
    for (const root of this.activeRoots.values()) {
      if (!existsSync(root.path)) continue;

      let projectDirs: string[];
      try {
        projectDirs = readdirSync(root.path);
      } catch {
        continue;
      }

      for (const projectDir of projectDirs) {
        const projectPath = join(root.path, projectDir);
        let files: string[];
        try {
          if (!statSync(projectPath).isDirectory()) continue;
          files = readdirSync(projectPath);
        } catch {
          continue;
        }

        for (const file of files) {
          const filePath = join(projectPath, file);
          if (this.sessions.has(filePath)) continue;
          const sessionId = sessionIdFromPiFilename(file);
          if (!sessionId) continue;

          try {
            const stat = statSync(filePath);
            if (!stat.isFile()) continue;
            if (now - stat.mtimeMs > RECENT_SESSION_THRESHOLD_MS) continue;
            this.tryAddSession(filePath, projectDir, root, sessionId);
          } catch {
            // skip inaccessible entries
          }
        }
      }
    }
  }

  private tryAddSession(filePath: string, projectDir: string, root: WatchRoot, sessionId: string): void {
    // Size before read, so a concurrent append can only make the stored size an
    // under-estimate (re-parsed next poll, then deduped) — never an over-estimate
    // that would skip a real append.
    const size = this.sizeOf(filePath);
    const lines = this.readLines(filePath);
    if (!lines) return;

    const { events, metadata } = parsePiTranscript(lines, sessionId);
    // Not a parseable version-3 pi transcript yet (or empty) — try again next scan.
    if (metadata.version !== '3') return;

    const cwd = metadata.cwd || decodeCwd(projectDir);
    const committed = committedEvents(events);

    // Register with the EventStore. The sandbox label (undefined for native)
    // rides through as the session name so gloved sessions are tagged in the UI.
    if (this.getConfig().autoActivateClients.includes(root.agentType)) {
      this.gate.activate(sessionId);
    }
    this.eventStore.trackSession(sessionId, cwd, root.agentType, undefined, root.label);
    this.eventStore.add('session_start', sessionId, { source: 'startup' }, undefined, root.agentType);
    const tag = root.label ? ` [glove: ${root.label}]` : '';
    console.log(`[pi] Tracking session ${sessionId.slice(0, 8)} (${basename(filePath)})${tag}`);

    // Replay recently-touched sessions from the beginning; skip history for old ones.
    const lastTouchedMs = metadata.lastTimestamp || this.mtimeOf(filePath);
    const isRecent = Date.now() - lastTouchedMs < REPLAY_WINDOW_MS;

    const session: TrackedSession = {
      sessionId,
      cwd,
      file: filePath,
      emittedIds: new Set<string>(),
      lastActivityMs: Date.now(),
      lastSize: size,
      agentType: root.agentType,
      label: root.label,
      pollTimer: null,
    };
    this.sessions.set(filePath, session);

    if (isRecent) {
      this.emitNew(session, committed);
    } else {
      // Old session: adopt the existing history as already-emitted so only future
      // turns are recorded, without replaying the backlog.
      for (const ev of committed) session.emittedIds.add(ev.id);
    }

    session.pollTimer = setInterval(() => this.pollSession(session), SCAN_INTERVAL_MS);
  }

  private pollSession(session: TrackedSession): void {
    // pi only appends: an unchanged file size means no new lines, so skip the
    // full re-read + re-parse (which grows O(n) with the transcript) entirely.
    const size = this.sizeOf(session.file);
    if (size <= session.lastSize) return;

    const lines = this.readLines(session.file);
    if (!lines) return;
    session.lastSize = size;

    const { events } = parsePiTranscript(lines, session.sessionId);
    const committed = committedEvents(events);
    const before = session.emittedIds.size;
    this.emitNew(session, committed);
    if (session.emittedIds.size > before) {
      session.lastActivityMs = Date.now();
    }
  }

  /**
   * Emit every committed event this session hasn't emitted yet, keyed by the
   * parser's deterministic event id. Iterating by id (not by array index) is what
   * makes this safe when a re-parse reorders the committed list — e.g. a late tool
   * result inserting an earlier-timestamped completion ahead of one already sent.
   * Each id is emitted at most once; a shifted position can neither duplicate nor
   * skip an event.
   */
  private emitNew(session: TrackedSession, committed: TimelineEvent[]): void {
    for (const ev of committed) {
      if (session.emittedIds.has(ev.id)) continue;
      this.emitEvent(session, ev);
      session.emittedIds.add(ev.id);
    }
  }

  /**
   * Translate one parsed event into an EventStore.add() call. Uses the store's
   * live path (fresh id, current timestamp) exactly as the vibe watcher does, so
   * a passively-tailed session is a `live` source and history-import re-parsing
   * won't double-record it. Tool completions get the same file/url access
   * extraction the vibe watcher performs.
   */
  private emitEvent(session: TrackedSession, ev: TimelineEvent): void {
    const { sessionId, agentType } = session;

    if (ev.type === 'tool_call_completed') {
      const toolName = String(ev.data.toolName ?? 'unknown');
      const toolInput = (ev.data.toolInput as Record<string, unknown>) ?? {};
      const toolOutput = ev.data.toolOutput ?? '';
      const completedAt = Date.now();

      const access = extractAccess(toolName, toolInput, toolOutput, '', completedAt);
      const filesWithId = access.files.length > 0 ? access.files : undefined;
      const urlsWithId = access.urls.length > 0 ? access.urls : undefined;

      const event = this.eventStore.add('tool_call_completed', sessionId, {
        ...ev.data,
        completedAt,
        fileAccess: filesWithId,
        urlAccess: urlsWithId,
      }, ev.riskLevel, agentType);

      if (filesWithId) filesWithId.forEach(f => f.eventId = event.id);
      if (urlsWithId) urlsWithId.forEach(u => u.eventId = event.id);
      if (filesWithId || urlsWithId) {
        this.eventStore.recordAccess(sessionId, filesWithId ?? [], urlsWithId ?? []);
      }
      return;
    }

    this.eventStore.add(ev.type, sessionId, ev.data, ev.riskLevel, agentType);
  }

  private cleanupEndedSessions(): void {
    for (const session of this.sessions.values()) {
      // Tombstoned session: resurrect it if its transcript has grown again.
      // scanExistingSessions skips paths already in `this.sessions`, so a
      // tombstone left in the map with no pollTimer is never re-added there —
      // this is the only place a resumed pi session can come back to life.
      // Mirrors VibeSessionWatcher.cleanupEndedSessions.
      if (!session.pollTimer) {
        this.tryResumeSession(session);
        continue;
      }

      const idleMs = Date.now() - session.lastActivityMs;
      if (idleMs < SESSION_IDLE_TIMEOUT_MS) continue;

      // One final poll before declaring the session over, in case a late write landed.
      const beforeCount = session.emittedIds.size;
      this.pollSession(session);
      if (session.emittedIds.size > beforeCount) {
        session.lastActivityMs = Date.now();
        continue;
      }

      this.eventStore.add('session_end', session.sessionId, {}, undefined, session.agentType);
      this.gate.deactivate(session.sessionId);
      clearInterval(session.pollTimer);
      session.pollTimer = null; // tombstone; resurrected by tryResumeSession if it grows
      console.log(`[pi] Session ${session.sessionId.slice(0, 8)} ended (idle ${Math.round(idleMs / 60000)}m)`);
    }
  }

  /**
   * Bring a tombstoned (idle-timed-out) session back to life when its transcript
   * has new committed events. Emits a `resumed` session_start before catching up
   * so the marker lands at the right point in the timeline, restarts the poll
   * timer, and re-applies auto-activation exactly as tryAddSession does.
   */
  private tryResumeSession(session: TrackedSession): void {
    // A tombstone stays in the map forever; short-circuit on unchanged size so an
    // ended session isn't re-read and re-parsed on every scan tick indefinitely.
    const size = this.sizeOf(session.file);
    if (size <= session.lastSize) return;

    const lines = this.readLines(session.file);
    if (!lines) return;
    session.lastSize = size;

    const { events } = parsePiTranscript(lines, session.sessionId);
    const committed = committedEvents(events);
    const hasNew = committed.some((ev) => !session.emittedIds.has(ev.id));
    if (!hasNew) return;

    const lastStored = this.eventStore.findLast((e) => e.sessionId === session.sessionId);
    const resumedAt = Date.now();
    const gapMinutes = lastStored ? Math.round((resumedAt - lastStored.timestamp) / 60000) : 0;

    this.eventStore.trackSession(session.sessionId, session.cwd, session.agentType, undefined, session.label);
    this.eventStore.add('session_start', session.sessionId, { source: 'resumed', gapMinutes }, undefined, session.agentType);
    if (this.getConfig().autoActivateClients.includes(session.agentType)) {
      this.gate.activate(session.sessionId);
    }

    this.emitNew(session, committed);
    session.lastActivityMs = resumedAt;
    session.pollTimer = setInterval(() => this.pollSession(session), SCAN_INTERVAL_MS);
    console.log(`[pi] Session ${session.sessionId.slice(0, 8)} resumed (gap ${gapMinutes}m)`);
  }

  private readLines(filePath: string): string[] | null {
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content.length === 0 ? [] : content.split('\n').filter(Boolean);
    } catch {
      return null;
    }
  }

  private mtimeOf(filePath: string): number {
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private sizeOf(filePath: string): number {
    try {
      return statSync(filePath).size;
    } catch {
      return 0;
    }
  }
}

/**
 * Events safe to emit while tailing: everything except `tool_call_pending`.
 * A pending is an in-flight tool with no result yet; once the result lands the
 * parser replaces it with a `tool_call_completed` bearing the *same* event id.
 * Emission dedupes by id (see `emitNew`), so a pending is simply withheld until
 * it completes — and reordering of already-committed events, as happens when
 * parallel tools finish out of order, can neither duplicate nor drop one.
 */
function committedEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events.filter((e) => e.type !== 'tool_call_pending');
}

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

import { watch, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import type { FSWatcher } from 'fs';
import type { EventStore } from '../events/store.js';
import type { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import type { TimelineEvent } from '../events/types.js';
import { extractAccess } from '../events/access-extractor.js';
import { parsePiTranscript, decodeCwd } from '../hooks/transcript-pi.js';

const AGENT_TYPE = 'pi';
const SCAN_INTERVAL_MS = 2000;
const RECENT_SESSION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
/** Sessions modified within this window are replayed from the beginning; older ones skip history. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
/** If the transcript file hasn't grown in this long, the pi session is treated as ended. */
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Matches pi session filenames `<timestamp>_<sessionId>.jsonl`. */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derive the session id from a `<timestamp>_<sessionId>.jsonl` filename, or null. */
function sessionIdFromFile(file: string): string | null {
  if (!file.endsWith('.jsonl')) return null;
  const stem = file.slice(0, -'.jsonl'.length);
  const idx = stem.lastIndexOf('_');
  if (idx === -1) return null;
  const id = stem.slice(idx + 1);
  return SESSION_ID_PATTERN.test(id) ? id : null;
}

interface TrackedSession {
  sessionId: string;
  cwd: string;
  /** Absolute path to the session's `.jsonl` transcript. */
  file: string;
  /**
   * Count of *committed* events already emitted to the store. Committed excludes
   * trailing `tool_call_pending` (an in-flight tool that has no result yet): those
   * become `tool_call_completed` once the result line lands, so emitting them
   * would leave a stale pending we could never reconcile. The committed prefix
   * grows monotonically as a linear session proceeds, so slicing by count is safe.
   */
  emittedCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  lastActivityMs: number;
  agentType: string;
  label?: string;
}

/** A watch root the watcher is actively tailing, plus its fs.watch handle. */
interface ActiveRoot {
  path: string;
  agentType: string;
  label?: string;
  watcher: FSWatcher | null;
}

export class PiSessionWatcher {
  private eventStore: EventStore;
  private gate: SessionGate;
  private getConfig: () => LaymanConfig;
  private sources: MonitorSource[];
  /** Tracked sessions, keyed by absolute transcript file path. */
  private sessions = new Map<string, TrackedSession>();
  /** Currently-watched roots, keyed by absolute path. */
  private activeRoots = new Map<string, ActiveRoot>();
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

    // Periodic scan is the primary discovery mechanism: fs.watch is unreliable on
    // Docker Desktop bind mounts, and pi writes files one level below the watched
    // root, so a root-level watcher wouldn't see new transcript lines anyway.
    this.scanTimer = setInterval(() => {
      this.reconcileRoots();
      this.scanExistingSessions();
      this.cleanupEndedSessions();
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    for (const active of this.activeRoots.values()) {
      if (active.watcher) active.watcher.close();
    }
    this.activeRoots.clear();
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const session of this.sessions.values()) {
      if (session.pollTimer) clearInterval(session.pollTimer);
    }
    this.sessions.clear();
  }

  /**
   * Bring the set of watched roots in line with what the sources currently
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
    for (const [path, active] of this.activeRoots) {
      if (!desired.has(path)) {
        if (active.watcher) active.watcher.close();
        this.activeRoots.delete(path);
        console.log(`[pi] Stopped watching root ${path}`);
      }
    }

    // Add roots that appeared.
    for (const [path, root] of desired) {
      if (this.activeRoots.has(path)) continue;
      const active: ActiveRoot = { path, agentType: root.agentType, label: root.label, watcher: null };
      active.watcher = this.startDirWatcher(active);
      this.activeRoots.set(path, active);
      const tag = root.label ? ` (glove: ${root.label})` : '';
      console.log(`[pi] Watching root ${path}${tag}`);
    }
  }

  private startDirWatcher(root: ActiveRoot): FSWatcher | null {
    try {
      // Best-effort responsiveness only; the periodic scan does the real work.
      return watch(root.path, { recursive: true }, () => this.scanExistingSessions());
    } catch {
      return null; // fs.watch may fail (or lack recursive support) — periodic scan covers it
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
          if (!sessionIdFromFile(file)) continue;

          try {
            const stat = statSync(filePath);
            if (!stat.isFile()) continue;
            if (now - stat.mtimeMs > RECENT_SESSION_THRESHOLD_MS) continue;
            this.tryAddSession(filePath, projectDir, root);
          } catch {
            // skip inaccessible entries
          }
        }
      }
    }
  }

  private tryAddSession(filePath: string, projectDir: string, root: ActiveRoot): void {
    if (this.sessions.has(filePath)) return;

    const sessionId = sessionIdFromFile(basename(filePath));
    if (!sessionId) return;

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
      emittedCount: isRecent ? 0 : committed.length,
      lastActivityMs: Date.now(),
      agentType: root.agentType,
      label: root.label,
      pollTimer: null,
    };
    this.sessions.set(filePath, session);

    if (isRecent) this.emitNew(session, committed);

    session.pollTimer = setInterval(() => this.pollSession(session), SCAN_INTERVAL_MS);
  }

  private pollSession(session: TrackedSession): void {
    const lines = this.readLines(session.file);
    if (!lines) return;

    const { events } = parsePiTranscript(lines, session.sessionId);
    const committed = committedEvents(events);
    if (committed.length > session.emittedCount) {
      this.emitNew(session, committed);
      session.lastActivityMs = Date.now();
    }
  }

  /** Emit committed events past what this session has already emitted, advancing the cursor. */
  private emitNew(session: TrackedSession, committed: TimelineEvent[]): void {
    for (let i = session.emittedCount; i < committed.length; i++) {
      this.emitEvent(session, committed[i]);
    }
    session.emittedCount = committed.length;
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
      if (!session.pollTimer) continue; // already tombstoned

      const idleMs = Date.now() - session.lastActivityMs;
      if (idleMs < SESSION_IDLE_TIMEOUT_MS) continue;

      // One final poll before declaring the session over, in case a late write landed.
      const beforeCount = session.emittedCount;
      this.pollSession(session);
      if (session.emittedCount > beforeCount) {
        session.lastActivityMs = Date.now();
        continue;
      }

      this.eventStore.add('session_end', session.sessionId, {}, undefined, session.agentType);
      this.gate.deactivate(session.sessionId);
      clearInterval(session.pollTimer);
      session.pollTimer = null; // tombstone; the file may still be re-scanned if it grows
      console.log(`[pi] Session ${session.sessionId.slice(0, 8)} ended (idle ${Math.round(idleMs / 60000)}m)`);
    }
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
}

/**
 * Events safe to emit while tailing: everything except `tool_call_pending`.
 * A pending is an in-flight tool with no result yet; once the result lands the
 * parser replaces it with a `tool_call_completed`. The committed prefix grows
 * monotonically as a linear session proceeds, so emitting it by count is stable.
 */
function committedEvents(events: TimelineEvent[]): TimelineEvent[] {
  return events.filter((e) => e.type !== 'tool_call_pending');
}

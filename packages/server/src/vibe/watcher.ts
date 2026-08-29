/**
 * Watches Mistral Vibe session log directories for new JSONL messages
 * and translates them into Layman EventStore events.
 *
 * Vibe writes incremental JSONL to <root>/<dir>/messages.jsonl after each turn;
 * we poll from a tracked byte offset to pick up new lines.
 *
 * Roots are not hardcoded: they come from a list of `MonitorSource`s, re-queried
 * on every scan tick, so the native `~/.vibe` root and any number of glove
 * sandbox roots are watched at once and appear/disappear dynamically. Each root
 * carries the agent type and an optional sandbox label; a session inherits both,
 * so sandboxed sessions are tagged with their sandbox name. See
 * `../monitor/sources.ts`.
 */

import { watch, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { open } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, basename } from 'path';
import type { FSWatcher } from 'fs';
import type { EventStore } from '../events/store.js';
import type { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import type { MonitorSource, WatchRoot } from '../monitor/sources.js';
import { classifyRisk } from '../events/classifier.js';
import { extractAccess } from '../events/access-extractor.js';

const execFileAsync = promisify(execFile);

/** Returns the set of PIDs for running vibe processes */
async function getVibePids(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-x', 'vibe'], { timeout: 5000 });
    return new Set(
      stdout.trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n))
    );
  } catch {
    return new Set();
  }
}

/** Returns the working directory of a process by PID (macOS/Linux) */
async function getProcessCwd(pid: number): Promise<string> {
  try {
    // macOS/Linux: lsof -p PID -a -d cwd -Fn outputs "pPID\nnPATH"
    const { stdout } = await execFileAsync('lsof', ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'], { timeout: 5000 });
    const match = stdout.match(/^n(.+)$/m);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

const AGENT_TYPE = 'mistral-vibe';
const POLL_INTERVAL_MS = 2000;
const SCAN_INTERVAL_MS = 2000;
const RECENT_SESSION_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
/** Sessions started within this window are read from the beginning; older ones skip history */
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
/**
 * If messages.jsonl hasn't grown in this long, the Vibe process is likely gone.
 * Note: Vibe sets end_time on every save_interaction() call (not just on close),
 * so end_time is NOT a reliable signal that a session has ended.
 */
const SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Map Vibe snake_case tool names to Layman PascalCase */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  webfetch: 'WebFetch',
  web_fetch: 'WebFetch',
  websearch: 'WebSearch',
  web_search: 'WebSearch',
  list_directory: 'ListDirectory',
};

function mapToolName(vibeName: string): string {
  return TOOL_NAME_MAP[vibeName] ?? vibeName;
}

interface VibeToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface VibeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  message_id?: string;
  tool_calls?: VibeToolCall[] | null;
  tool_call_id?: string;
  name?: string;
}

interface VibeMetadata {
  session_id: string;
  start_time?: string;
  end_time?: string | null;
  environment?: {
    working_directory?: string;
  };
  title?: string;
}

interface TrackedSession {
  sessionId: string;
  cwd: string;
  dir: string;
  byteOffset: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** Timestamp of last new message seen, used for idle timeout detection */
  lastActivityMs: number;
  /** Map of tool_call_id → { toolName, toolInput } for correlating tool results */
  pendingTools: Map<string, { toolName: string; toolInput: Record<string, unknown> }>;
  /** Agent type this session is attributed to, from its watch root. */
  agentType: string;
  /** Sandbox label from the root (surfaced as session name); undefined for native. */
  label?: string;
}

/** A watch root the watcher is actively tailing, plus its fs.watch handle. */
interface ActiveRoot {
  path: string;
  agentType: string;
  label?: string;
  watcher: FSWatcher | null;
}

/** A synthetic placeholder session created when a vibe process is detected at launch,
 *  before the first user message creates meta.json. */
interface PendingSession {
  sessionId: string;
  cwd: string;
}

export class VibeSessionWatcher {
  private eventStore: EventStore;
  private gate: SessionGate;
  private getConfig: () => LaymanConfig;
  private sources: MonitorSource[];
  private sessions = new Map<string, TrackedSession>();
  /** Currently-watched roots, keyed by absolute path. */
  private activeRoots = new Map<string, ActiveRoot>();
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** PIDs of vibe processes we've already seen */
  private knownVibePids = new Set<number>();
  /** Synthetic placeholder sessions keyed by PID, active before real meta.json appears */
  private pendingSessions = new Map<number, PendingSession>();
  private vibeCheckInProgress = false;

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
    void this.checkVibeProcesses();

    this.reconcileRoots();
    this.scanExistingSessions();

    // Periodic scan to catch anything fs.watch misses (fs.watch is unreliable on
    // Docker Desktop bind mounts), to pick up roots that appear later (a sandbox
    // launched or vibe installed after Layman started), and to detect ended sessions.
    this.scanTimer = setInterval(() => {
      this.reconcileRoots();
      this.scanExistingSessions();
      void this.cleanupEndedSessions();
      void this.checkVibeProcesses();
    }, SCAN_INTERVAL_MS);
  }

  /**
   * Bring the set of watched roots in line with what the sources currently
   * report: open watchers for roots that appeared, close watchers for roots
   * that vanished. Called on every scan tick, which is what makes glove
   * sandboxes appearing or disappearing mid-run take effect without a restart.
   */
  private reconcileRoots(): void {
    const desired = new Map<string, WatchRoot>();
    for (const source of this.sources) {
      for (const root of source.roots()) {
        // A glove source now emits both Vibe and pi roots; this watcher only
        // parses Vibe, so ignore anything else (the pi watcher claims those).
        if (root.agentType !== AGENT_TYPE) continue;
        // First source to claim a path wins; native precedes glove in the list.
        if (!desired.has(root.path)) desired.set(root.path, root);
      }
    }

    // Drop roots no longer reported. Sessions under them are left to idle-timeout
    // naturally (their log files stop growing), so no events are lost mid-flight.
    for (const [path, active] of this.activeRoots) {
      if (!desired.has(path)) {
        if (active.watcher) active.watcher.close();
        this.activeRoots.delete(path);
        console.log(`[vibe] Stopped watching root ${path}`);
      }
    }

    // Add roots that appeared.
    for (const [path, root] of desired) {
      if (this.activeRoots.has(path)) continue;
      const active: ActiveRoot = { path, agentType: root.agentType, label: root.label, watcher: null };
      active.watcher = this.startDirWatcher(active);
      this.activeRoots.set(path, active);
      const tag = root.label ? ` (glove: ${root.label})` : '';
      console.log(`[vibe] Watching root ${path}${tag}`);
    }
  }

  private startDirWatcher(root: ActiveRoot): FSWatcher | null {
    try {
      return watch(root.path, (_eventType, filename) => {
        if (!filename) return;
        const dirPath = join(root.path, filename);
        if (this.sessions.has(dirPath)) return;
        // Small delay for meta.json to be written
        setTimeout(() => this.tryAddSession(dirPath, root), 500);
      });
    } catch {
      // fs.watch may fail on some systems — fall back to periodic scan
      return null;
    }
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
    this.pendingSessions.clear();
    this.knownVibePids.clear();
  }

  /**
   * Detects running vibe processes and creates synthetic placeholder sessions at
   * launch, before the user sends the first message (which is when Vibe writes meta.json).
   * When the real session directory appears, tryAddSession transitions away from the
   * placeholder. When the process exits without a real session, the placeholder is closed.
   */
  private async checkVibeProcesses(): Promise<void> {
    if (this.vibeCheckInProgress) return;
    this.vibeCheckInProgress = true;
    try {
      await this.doCheckVibeProcesses();
    } finally {
      this.vibeCheckInProgress = false;
    }
  }

  private async doCheckVibeProcesses(): Promise<void> {
    const currentPids = await getVibePids();

    // Resolve cwds for all new PIDs in parallel
    const newPids = [...currentPids].filter(pid => !this.knownVibePids.has(pid));
    for (const pid of newPids) this.knownVibePids.add(pid);

    const newPidCwds = await Promise.all(
      newPids.map(pid => getProcessCwd(pid).then(cwd => ({ pid, cwd })))
    );

    for (const { pid, cwd } of newPidCwds) {
      if (this.cwdCovered(cwd)) continue;

      const sessionId = `vibe-pending-${pid}`;
      this.pendingSessions.set(pid, { sessionId, cwd });

      this.eventStore.trackSession(sessionId, cwd, AGENT_TYPE);
      this.eventStore.add('session_start', sessionId, { source: 'process-detected' }, undefined, AGENT_TYPE);

      if (this.getConfig().autoActivateClients.includes(AGENT_TYPE)) {
        this.gate.activate(sessionId);
      }

      console.log(`[vibe] Placeholder session ${sessionId} for process PID ${pid} (${cwd || 'unknown cwd'})`);
    }

    // Close placeholders whose process has exited without producing a real session.
    // Collect first to avoid mutating the Set while iterating it.
    const exitedPids = [...this.knownVibePids].filter(pid => !currentPids.has(pid));
    for (const pid of exitedPids) {
      this.knownVibePids.delete(pid);

      const pending = this.pendingSessions.get(pid);
      if (!pending) continue;
      this.pendingSessions.delete(pid);

      this.eventStore.add('session_end', pending.sessionId, {}, undefined, AGENT_TYPE);
      this.gate.deactivate(pending.sessionId);
      console.log(`[vibe] Placeholder session ${pending.sessionId} closed (process PID ${pid} exited)`);
    }
  }

  /** Returns true if any tracked or pending session already covers the given cwd. */
  private cwdCovered(cwd: string): boolean {
    for (const s of this.sessions.values()) if (s.cwd === cwd) return true;
    for (const s of this.pendingSessions.values()) if (s.cwd === cwd) return true;
    return false;
  }

  private scanExistingSessions(): void {
    const now = Date.now();
    for (const root of this.activeRoots.values()) {
      if (!existsSync(root.path)) continue;

      let entries: string[];
      try {
        entries = readdirSync(root.path);
      } catch {
        continue;
      }

      for (const name of entries) {
        const dirPath = join(root.path, name);
        if (this.sessions.has(dirPath)) continue;

        try {
          const stat = statSync(dirPath);
          if (!stat.isDirectory()) continue;
          if (now - stat.mtimeMs > RECENT_SESSION_THRESHOLD_MS) continue;
          this.tryAddSession(dirPath, root);
        } catch {
          // skip inaccessible entries
        }
      }
    }
  }

  private tryAddSession(dirPath: string, root: ActiveRoot): void {
    if (this.sessions.has(dirPath)) return;

    const metaPath = join(dirPath, 'meta.json');
    if (!existsSync(metaPath)) return;

    let meta: VibeMetadata;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as VibeMetadata;
    } catch {
      return;
    }

    const sessionStartedMs = meta.start_time ? new Date(meta.start_time).getTime() : 0;

    // Skip sessions that are too old to be worth replaying
    if (Date.now() - sessionStartedMs > RECENT_SESSION_THRESHOLD_MS) return;

    const sessionId = meta.session_id;
    const cwd = meta.environment?.working_directory ?? '';

    // If a placeholder session exists for this cwd, close it before registering the real one
    for (const [pid, pending] of this.pendingSessions) {
      if (pending.cwd === cwd) {
        this.pendingSessions.delete(pid);
        this.eventStore.add('session_end', pending.sessionId, {}, undefined, AGENT_TYPE);
        this.gate.deactivate(pending.sessionId);
        console.log(`[vibe] Placeholder session ${pending.sessionId} replaced by real session ${sessionId.slice(0, 8)}`);
        break;
      }
    }

    // Auto-activate: if configured, activate Vibe sessions via the gate
    const config = this.getConfig();
    if (config.autoActivateClients.includes(root.agentType)) {
      this.gate.activate(sessionId);
    }

    // Register session with EventStore. The sandbox label (undefined for native)
    // rides through as the session name so gloved sessions are tagged in the UI.
    this.eventStore.trackSession(sessionId, cwd, root.agentType, undefined, root.label);
    this.eventStore.add('session_start', sessionId, { source: 'startup' }, undefined, root.agentType);
    const tag = root.label ? ` [glove: ${root.label}]` : '';
    console.log(`[vibe] Tracking session ${sessionId.slice(0, 8)} (${basename(dirPath)})${tag}`);

    const messagesPath = join(dirPath, 'messages.jsonl');

    // For sessions started recently, replay from the beginning so their messages appear.
    // For older sessions (e.g. ones that predate this Layman startup), skip history.
    const isRecent = Date.now() - sessionStartedMs < REPLAY_WINDOW_MS;

    let initialOffset = 0;
    if (!isRecent) {
      try {
        const stat = statSync(messagesPath);
        initialOffset = stat.size;
      } catch {
        // File doesn't exist yet — start from 0
      }
    }

    const session: TrackedSession = {
      sessionId,
      cwd,
      dir: dirPath,
      byteOffset: initialOffset,
      lastActivityMs: Date.now(),
      pendingTools: new Map(),
      agentType: root.agentType,
      label: root.label,
      pollTimer: setInterval(() => void this.pollSession(session), POLL_INTERVAL_MS),
    };

    this.sessions.set(dirPath, session);
  }

private async pollSession(session: TrackedSession): Promise<void> {
    const messagesPath = join(session.dir, 'messages.jsonl');

    let fh;
    try {
      fh = await open(messagesPath, 'r');
      const stat = await fh.stat();
      if (stat.size <= session.byteOffset) {
        await fh.close();
        return;
      }

      const buf = Buffer.alloc(stat.size - session.byteOffset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, session.byteOffset);
      await fh.close();

      if (bytesRead === 0) return;

      const chunk = buf.subarray(0, bytesRead).toString('utf-8');

      // Only process up to the last complete line
      const lastNewline = chunk.lastIndexOf('\n');
      if (lastNewline === -1) return; // no complete line yet

      const complete = chunk.substring(0, lastNewline);
      session.byteOffset += Buffer.byteLength(complete, 'utf-8') + 1; // +1 for the \n

      const lines = complete.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as VibeMessage;
          this.processMessage(session, msg);
        } catch {
          // skip malformed lines
        }
      }
      session.lastActivityMs = Date.now();
    } catch {
      // File not ready or deleted
      if (fh) await fh.close().catch(() => {});
    }
  }

  private processMessage(session: TrackedSession, msg: VibeMessage): void {
    const { sessionId, agentType } = session;

    switch (msg.role) {
      case 'user': {
        if (msg.content) {
          this.eventStore.add('user_prompt', sessionId, {
            prompt: msg.content,
          }, undefined, agentType);
        }
        break;
      }

      case 'assistant': {
        // Emit text content as agent_response
        if (msg.content) {
          this.eventStore.add('agent_response', sessionId, {
            prompt: msg.content,
          }, undefined, agentType);
        }

        // Emit tool calls (observed post-execution, not blocking)
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const rawName = tc.function?.name ?? 'unknown';
            const toolName = mapToolName(rawName);
            let toolInput: Record<string, unknown> = {};
            try {
              if (tc.function?.arguments) {
                toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
              }
            } catch {
              toolInput = { raw: tc.function?.arguments };
            }

            const riskLevel = classifyRisk(toolName, toolInput);
            this.eventStore.add('tool_call_approved', sessionId, {
              toolName,
              toolInput,
            }, riskLevel, agentType);

            // Track for correlation with tool result
            if (tc.id) {
              session.pendingTools.set(tc.id, { toolName, toolInput });
            }
          }
        }
        break;
      }

      case 'tool': {
        const toolCallId = msg.tool_call_id;
        const pending = toolCallId ? session.pendingTools.get(toolCallId) : undefined;
        const toolName = pending?.toolName ?? mapToolName(msg.name ?? 'unknown');
        const toolInput = pending?.toolInput ?? {};
        const toolOutput = msg.content ?? '';
        const completedAt = Date.now();

        const access = extractAccess(toolName, toolInput, toolOutput, '', completedAt);
        const filesWithId = access.files.length > 0 ? access.files : undefined;
        const urlsWithId = access.urls.length > 0 ? access.urls : undefined;

        const event = this.eventStore.add('tool_call_completed', sessionId, {
          toolName,
          toolInput,
          toolOutput,
          completedAt,
          fileAccess: filesWithId,
          urlAccess: urlsWithId,
        }, undefined, agentType);

        if (filesWithId) filesWithId.forEach(f => f.eventId = event.id);
        if (urlsWithId) urlsWithId.forEach(u => u.eventId = event.id);
        if (filesWithId || urlsWithId) {
          this.eventStore.recordAccess(sessionId, filesWithId ?? [], urlsWithId ?? []);
        }

        if (toolCallId) {
          session.pendingTools.delete(toolCallId);
        }
        break;
      }

      // system messages are ignored
    }
  }

  private async cleanupEndedSessions(): Promise<void> {
    // NOTE: Vibe sets end_time after every turn (not just on close), so end_time is NOT
    // a reliable session-end signal. Instead we use file inactivity as a proxy.
    for (const [, session] of this.sessions) {
      // Handle tombstoned sessions: check if they have resumed activity
      if (!session.pollTimer) {
        const hasNewActivity = this.checkForNewActivity(session);
        if (hasNewActivity) {
          // Measure gap before doing anything else
          const lastStoredEvent = this.getLastSessionEvent(session.sessionId);
          const resumedAt = Date.now();
          const gapMs = lastStoredEvent ? resumedAt - lastStoredEvent.timestamp : 0;
          const gapMinutes = Math.round(gapMs / 60000);

          console.log(`[vibe] Session ${session.sessionId.slice(0, 8)} resuming — recovering ${gapMinutes}m of missed data`);

          // Restore session tracking and emit session_start *before* catch-up events
          // so the marker appears at the right position in the timeline
          this.eventStore.trackSession(session.sessionId, session.cwd, session.agentType, undefined, session.label);
          this.eventStore.add('session_start', session.sessionId, {
            source: 'resumed',
            gapMinutes,
          }, undefined, session.agentType);

          session.lastActivityMs = resumedAt;
          session.pollTimer = setInterval(() => void this.pollSession(session), POLL_INTERVAL_MS);

          // Catch up on any missed messages from the gap
          const beforeOffset = session.byteOffset;
          await this.pollSession(session);
          const messagesBytesDelta = session.byteOffset - beforeOffset;
          console.log(`[vibe] Session ${session.sessionId.slice(0, 8)} resumed: caught up ${messagesBytesDelta} bytes over ${gapMinutes}m gap`);
        }
        continue;
      }

      const idleMs = Date.now() - session.lastActivityMs;
      if (idleMs < SESSION_IDLE_TIMEOUT_MS) continue;

      // Do one final poll before declaring the session over
      const beforeOffset = session.byteOffset;
      await this.pollSession(session);

      // If the final poll detected new activity, keep the session alive
      if (session.byteOffset > beforeOffset) {
        session.lastActivityMs = Date.now();
        console.log(`[vibe] Session ${session.sessionId.slice(0, 8)} resumed (activity detected after timeout)`);
        continue;
      }

      this.eventStore.add('session_end', session.sessionId, {}, undefined, session.agentType);
      this.gate.deactivate(session.sessionId);
      clearInterval(session.pollTimer);
      session.pollTimer = null; // convert to tombstone
      console.log(`[vibe] Session ${session.sessionId.slice(0, 8)} ended (idle ${Math.round(idleMs / 60000)}m)`);
    }
  }

  /** Check if a session has new data without actually processing it */
  private checkForNewActivity(session: TrackedSession): boolean {
    const messagesPath = join(session.dir, 'messages.jsonl');
    try {
      const stat = statSync(messagesPath);
      return stat.size > session.byteOffset;
    } catch {
      return false;
    }
  }

  /** Get the most recent event in the store for a given session */
  private getLastSessionEvent(sessionId: string): { timestamp: number } | null {
    const allEvents = this.eventStore.getAll();
    for (let i = allEvents.length - 1; i >= 0; i--) {
      if (allEvents[i].sessionId === sessionId) {
        return { timestamp: allEvents[i].timestamp };
      }
    }
    return null;
  }
}

/**
 * Watches Mistral Vibe session log directories for new JSONL messages
 * and translates them into Layman EventStore events.
 *
 * Vibe writes incremental JSONL to ~/.vibe/logs/session/<dir>/messages.jsonl
 * after each turn. We poll from a tracked byte offset to pick up new lines.
 */

import { watch, existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { open, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import type { FSWatcher } from 'fs';
import type { EventStore } from '../events/store.js';
import type { SessionGate } from '../hooks/gate.js';
import type { LaymanConfig } from '../config/schema.js';
import { classifyRisk } from '../events/classifier.js';
import { extractAccess } from '../events/access-extractor.js';

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
}

/** Resolve the Vibe session log directory, trying Docker mount first */
function resolveSessionLogDir(): string | null {
  const dockerPath = '/root/.vibe/logs/session';
  if (existsSync(dockerPath)) return dockerPath;

  const hostPath = join(homedir(), '.vibe', 'logs', 'session');
  if (existsSync(hostPath)) return hostPath;

  return null;
}

export class VibeSessionWatcher {
  private eventStore: EventStore;
  private gate: SessionGate;
  private getConfig: () => LaymanConfig;
  private sessions = new Map<string, TrackedSession>();
  private dirWatcher: FSWatcher | null = null;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private logDir: string | null = null;

  constructor(eventStore: EventStore, gate: SessionGate, getConfig: () => LaymanConfig) {
    this.eventStore = eventStore;
    this.gate = gate;
    this.getConfig = getConfig;
  }

  start(): void {
    this.logDir = resolveSessionLogDir();
    if (!this.logDir) return; // Vibe not installed or no sessions yet

    console.log(`[vibe] Session watcher started, watching ${this.logDir}`);

    // Scan for recently-active sessions
    this.scanExistingSessions();

    // Watch for new session directories
    try {
      this.dirWatcher = watch(this.logDir, (eventType, filename) => {
        if (!filename || !this.logDir) return;
        const dirPath = join(this.logDir, filename);
        if (this.sessions.has(dirPath)) return;
        // Small delay for meta.json to be written
        setTimeout(() => this.tryAddSession(dirPath), 500);
      });
    } catch {
      // fs.watch may fail on some systems — fall back to periodic scan
    }

    // Periodic scan to catch anything fs.watch misses (fs.watch is unreliable on
    // Docker Desktop bind mounts) and to detect newly-ended sessions.
    this.scanTimer = setInterval(() => {
      this.scanExistingSessions();
      void this.cleanupEndedSessions();
    }, SCAN_INTERVAL_MS);
  }

  stop(): void {
    if (this.dirWatcher) {
      this.dirWatcher.close();
      this.dirWatcher = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const session of this.sessions.values()) {
      if (session.pollTimer) clearInterval(session.pollTimer);
    }
    this.sessions.clear();
  }

  private scanExistingSessions(): void {
    if (!this.logDir || !existsSync(this.logDir)) return;

    const now = Date.now();
    let entries: string[];
    try {
      entries = readdirSync(this.logDir);
    } catch {
      return;
    }

    for (const name of entries) {
      const dirPath = join(this.logDir, name);
      if (this.sessions.has(dirPath)) continue;

      try {
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) continue;
        if (now - stat.mtimeMs > RECENT_SESSION_THRESHOLD_MS) continue;
        this.tryAddSession(dirPath);
      } catch {
        // skip inaccessible entries
      }
    }
  }

  private tryAddSession(dirPath: string): void {
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

    // Auto-activate: if configured, activate Vibe sessions via the gate
    const config = this.getConfig();
    if (config.autoActivateClients.includes(AGENT_TYPE)) {
      this.gate.activate(sessionId);
    }

    // Register session with EventStore
    this.eventStore.trackSession(sessionId, cwd, AGENT_TYPE);
    this.eventStore.add('session_start', sessionId, { source: 'startup' }, undefined, AGENT_TYPE);
    console.log(`[vibe] Tracking session ${sessionId.slice(0, 8)} (${basename(dirPath)})`);

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
    const { sessionId } = session;

    switch (msg.role) {
      case 'user': {
        if (msg.content) {
          this.eventStore.add('user_prompt', sessionId, {
            prompt: msg.content,
          }, undefined, AGENT_TYPE);
        }
        break;
      }

      case 'assistant': {
        // Emit text content as agent_response
        if (msg.content) {
          this.eventStore.add('agent_response', sessionId, {
            prompt: msg.content,
          }, undefined, AGENT_TYPE);
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
            }, riskLevel, AGENT_TYPE);

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
        }, undefined, AGENT_TYPE);

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
          this.eventStore.trackSession(session.sessionId, session.cwd, AGENT_TYPE);
          this.eventStore.add('session_start', session.sessionId, {
            source: 'resumed',
            gapMinutes,
          }, undefined, AGENT_TYPE);

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

      this.eventStore.add('session_end', session.sessionId, {}, undefined, AGENT_TYPE);
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

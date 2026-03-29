/**
 * Pre-activation transcript recovery for Claude Code sessions.
 *
 * When /layman is run mid-session, this module reads the Claude Code JSONL
 * transcript up to (but not including) the layman:activate Bash command and
 * injects the prior events into the EventStore.
 *
 * Key guarantees:
 *   - No overlap with hooks: Claude Code blocks on PreToolUse while we read,
 *     so no hook events can arrive for this session until we return.
 *   - No SQLite duplicates: every injected event gets a deterministic ID
 *     derived from its JSONL line UUID, so INSERT OR IGNORE in the recorder
 *     silently skips rows that were already written by a prior recovery run.
 *   - No in-memory duplicates: gate.activate() is checked by the caller before
 *     invoking this function, so recovery only runs once per session lifetime.
 */

import { readFile } from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { classifyRisk } from '../events/classifier.js';
import type { EventStore } from '../events/store.js';
import type { TimelineEvent } from '../events/types.js';
import type { Database } from '../db/database.js';

const ACTIVATION_PATTERN = /echo\s+["']?layman:activate["']?|curl\b.*\/api\/activate/;

/** Remap host ~/.claude path to the Docker-mounted container path */
function remapPath(p: string): string {
  const m = p.match(/\.claude\/(.+)$/);
  return m ? `/root/.claude/${m[1]}` : p;
}

async function readTranscript(path: string): Promise<string | null> {
  for (const candidate of [remapPath(path), path]) {
    try { return await readFile(candidate, 'utf-8'); } catch { /* try next */ }
  }
  return null;
}

type Block = Record<string, unknown>;

function buildEvent(
  id: string,
  type: TimelineEvent['type'],
  sessionId: string,
  agentType: string,
  timestamp: number,
  data: TimelineEvent['data'],
  riskLevel?: 'low' | 'medium' | 'high'
): TimelineEvent {
  return { id, type, sessionId, agentType, timestamp, data, riskLevel };
}

/**
 * Parse and inject all events from the transcript that occurred before the
 * /layman activation command.
 *
 * Returns the total number of events injected (including session_start).
 */
export async function recoverPreActivationHistory(
  transcriptPath: string,
  sessionId: string,
  agentType: string,
  eventStore: EventStore
): Promise<number> {
  const content = await readTranscript(transcriptPath);
  if (!content) return 0;

  const lines = content.trim().split('\n').filter(Boolean);
  const events: TimelineEvent[] = [];

  // Pending tool calls keyed by tool_call_id, carried forward from assistant
  // turns until the corresponding tool_result block appears in a user turn.
  const pendingTools = new Map<string, {
    eventId: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: number;
  }>();

  let firstEventTs: number | null = null;

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const lineType = obj.type as string | undefined;
    if (lineType !== 'user' && lineType !== 'assistant') continue;

    const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
    const ts = typeof obj.timestamp === 'string'
      ? new Date(obj.timestamp).getTime()
      : Date.now();

    if (firstEventTs === null) firstEventTs = ts;

    const msg = obj.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;

    if (lineType === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content as Block[] : [];
      const textParts: string[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        if (block.type === 'text' && typeof block.text === 'string') {
          const text = (block.text as string).trim();
          if (text) textParts.push(text);

        } else if (block.type === 'tool_use') {
          const toolCallId = typeof block.id === 'string' ? block.id : null;
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          const toolInput = (block.input && typeof block.input === 'object')
            ? block.input as Record<string, unknown>
            : {};

          // Activation boundary — stop here; everything from this point on
          // is owned by the live hook pipeline.
          if (toolName === 'Bash') {
            const cmd = (toolInput as { command?: string }).command ?? '';
            if (ACTIVATION_PATTERN.test(cmd)) {
              // Flush any accumulated text before stopping
              if (textParts.length > 0 && uuid) {
                events.push(buildEvent(
                  `${uuid}_resp`, 'agent_response',
                  sessionId, agentType, ts,
                  { prompt: textParts.join('\n\n') }
                ));
              }
              return flush(sessionId, agentType, firstEventTs ?? ts, events, eventStore);
            }
          }

          if (toolCallId && uuid) {
            pendingTools.set(toolCallId, {
              eventId: `${uuid}_tc_${i}`,
              name: toolName,
              input: toolInput,
              timestamp: ts,
            });
          }
        }
      }

      if (textParts.length > 0 && uuid) {
        events.push(buildEvent(
          `${uuid}_resp`, 'agent_response',
          sessionId, agentType, ts,
          { prompt: textParts.join('\n\n') }
        ));
      }

    } else if (lineType === 'user') {
      const content = msg.content;

      if (typeof content === 'string') {
        // Plain text user prompt — skip system-injected XML wrappers
        const text = content.trim();
        if (text && !text.startsWith('<') && uuid) {
          events.push(buildEvent(
            uuid, 'user_prompt',
            sessionId, agentType, ts,
            { prompt: text }
          ));
        }

      } else if (Array.isArray(content)) {
        for (const block of content as Block[]) {
          if (block.type !== 'tool_result') continue;

          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
          const pending = toolUseId ? pendingTools.get(toolUseId) : undefined;

          const toolName = pending?.name ?? 'unknown';
          const toolInput = pending?.input ?? {};

          // tool_result content may be a string, an array of text blocks, or null
          let toolOutput: unknown = block.content;
          if (Array.isArray(block.content)) {
            toolOutput = (block.content as Array<{ text?: string }>)
              .map(b => b.text ?? '').join('');
          }

          const riskLevel = classifyRisk(toolName, toolInput);
          const eventId = pending?.eventId
            ?? (uuid ? `${uuid}_tr_${toolUseId ?? ''}` : null);

          // Skip if we can't form a stable ID — better to omit than risk duplicates
          if (!eventId) continue;

          events.push(buildEvent(
            eventId, 'tool_call_completed',
            sessionId, agentType, pending?.timestamp ?? ts,
            { toolName, toolInput, toolOutput, completedAt: ts },
            riskLevel
          ));

          if (toolUseId) pendingTools.delete(toolUseId);
        }
      }
    }
  }

  // Reached end of transcript without finding the activation boundary.
  return flush(sessionId, agentType, firstEventTs ?? Date.now(), events, eventStore);
}

/**
 * Prepend a deterministic session_start event and inject everything into
 * the EventStore. addRaw() emits 'event:new', which the SessionRecorder
 * picks up and writes via INSERT OR IGNORE — safe to call multiple times.
 */
function flush(
  sessionId: string,
  agentType: string,
  startTs: number,
  events: TimelineEvent[],
  eventStore: EventStore
): number {
  if (events.length === 0) return 0;

  // Deterministic ID: same session always produces the same session_start row.
  // If recovery runs again (server restart), INSERT OR IGNORE skips the duplicate.
  const sessionStart = buildEvent(
    `${sessionId}_recovered_start`,
    'session_start',
    sessionId,
    agentType,
    startTs,
    { source: 'recovered' }
  );

  eventStore.addRaw(sessionStart);
  for (const event of events) {
    eventStore.addRaw(event);
  }

  return events.length + 1; // +1 for session_start
}

// ---------------------------------------------------------------------------
// Startup gap recovery
// ---------------------------------------------------------------------------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Convert an absolute cwd path to the Claude Code project directory name */
function cwdToProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

function resolveTranscriptPath(cwd: string, sessionId: string): string | null {
  const projectDir = cwdToProjectDir(cwd);
  for (const base of ['/root/.claude/projects', join(homedir(), '.claude', 'projects')]) {
    const p = join(base, projectDir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * On server startup, scan SQLite for claude-code sessions that have no
 * session_end event and whose JSONL transcript contains events written
 * after the last recorded SQLite timestamp — meaning the server was down
 * while the session continued.
 *
 * Each recovered event gets a deterministic ID, so INSERT OR IGNORE in the
 * recorder silently skips rows already present if recovery is run again.
 * Stops at the next layman:activate boundary to avoid overlapping with
 * events that were subsequently captured by live hooks.
 */
export async function recoverSessionGaps(
  db: Database,
  eventStore: EventStore
): Promise<number> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  // Sessions with no session_end and last activity within 7 days
  type SessionRow = { session_id: string; cwd: string; last_event_ts: number };
  const sessions = db.prepare(`
    SELECT rs.session_id, rs.cwd, MAX(re.timestamp) AS last_event_ts
    FROM recorded_sessions rs
    JOIN recorded_events re ON re.session_id = rs.session_id
    WHERE rs.agent_type = 'claude-code'
      AND rs.cwd != ''
      AND rs.last_seen >= ?
      AND rs.session_id NOT IN (
        SELECT session_id FROM recorded_events WHERE type = 'session_end'
      )
    GROUP BY rs.session_id
  `).all(cutoff) as SessionRow[];

  let totalEvents = 0;
  let totalSessions = 0;
  for (const { session_id, cwd, last_event_ts } of sessions) {
    const transcriptPath = resolveTranscriptPath(cwd, session_id);
    if (!transcriptPath) continue;

    const content = await readTranscript(transcriptPath);
    if (!content) continue;

    const injected = await injectGapEvents(
      content, session_id, 'claude-code', last_event_ts, eventStore
    );
    if (injected > 0) {
      console.log(`[recovery] Filled ${injected}-event gap for session ${session_id.slice(0, 8)}`);
      totalEvents += injected;
      totalSessions += 1;
    }
  }
  return { events: totalEvents, sessions: totalSessions };
}

/**
 * Parse JSONL events that fall strictly after `afterTimestamp` and before
 * the next layman:activate boundary, then inject them into the EventStore.
 *
 * Phase 1 (pre-scan): walk lines up to afterTimestamp to build a map of
 * pending tool calls whose results may appear inside the gap.
 * Phase 2 (gap): emit events from afterTimestamp to the activation boundary.
 */
async function injectGapEvents(
  content: string,
  sessionId: string,
  agentType: string,
  afterTimestamp: number,
  eventStore: EventStore
): Promise<number> {
  const lines = content.trim().split('\n').filter(Boolean);

  // Phase 1: collect tool_use blocks that started before the gap but whose
  // tool_result may appear inside it.
  const pendingTools = new Map<string, {
    eventId: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: number;
  }>();

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const ts = typeof obj.timestamp === 'string'
      ? new Date(obj.timestamp).getTime() : 0;
    if (ts > afterTimestamp) break; // reached the gap — stop pre-scan

    if (obj.type !== 'assistant') continue;
    const msg = obj.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(msg?.content) ? msg!.content as Block[] : [];
    const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== 'tool_use') continue;
      const toolCallId = typeof block.id === 'string' ? block.id : null;
      if (!toolCallId || !uuid) continue;
      pendingTools.set(toolCallId, {
        eventId: `${uuid}_tc_${i}`,
        name: typeof block.name === 'string' ? block.name : 'unknown',
        input: (block.input && typeof block.input === 'object')
          ? block.input as Record<string, unknown> : {},
        timestamp: ts,
      });
    }

    // Remove tools resolved before the gap
    if (obj.type === 'user') {
      const content = (obj.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Block[]) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            pendingTools.delete(block.tool_use_id);
          }
        }
      }
    }
  }

  // Phase 2: process the gap itself
  const events: TimelineEvent[] = [];

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    const lineType = obj.type as string | undefined;
    if (lineType !== 'user' && lineType !== 'assistant') continue;

    const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
    const ts = typeof obj.timestamp === 'string'
      ? new Date(obj.timestamp).getTime() : 0;

    if (ts <= afterTimestamp) continue; // before the gap

    const msg = obj.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;

    if (lineType === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content as Block[] : [];
      const textParts: string[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];

        if (block.type === 'text' && typeof block.text === 'string') {
          const text = (block.text as string).trim();
          if (text) textParts.push(text);

        } else if (block.type === 'tool_use') {
          const toolCallId = typeof block.id === 'string' ? block.id : null;
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          const toolInput = (block.input && typeof block.input === 'object')
            ? block.input as Record<string, unknown> : {};

          // Stop at re-activation boundary
          if (toolName === 'Bash') {
            const cmd = (toolInput as { command?: string }).command ?? '';
            if (ACTIVATION_PATTERN.test(cmd)) {
              if (textParts.length > 0 && uuid) {
                events.push(buildEvent(`${uuid}_resp_gap`, 'agent_response',
                  sessionId, agentType, ts, { prompt: textParts.join('\n\n') }));
              }
              return injectAll(events, eventStore);
            }
          }

          if (toolCallId && uuid) {
            pendingTools.set(toolCallId, {
              eventId: `${uuid}_tc_${i}`,
              name: toolName,
              input: toolInput,
              timestamp: ts,
            });
          }
        }
      }

      if (textParts.length > 0 && uuid) {
        events.push(buildEvent(`${uuid}_resp_gap`, 'agent_response',
          sessionId, agentType, ts, { prompt: textParts.join('\n\n') }));
      }

    } else if (lineType === 'user') {
      const userContent = msg.content;

      if (typeof userContent === 'string') {
        const text = userContent.trim();
        if (text && !text.startsWith('<') && uuid) {
          events.push(buildEvent(`${uuid}_gap`, 'user_prompt',
            sessionId, agentType, ts, { prompt: text }));
        }
      } else if (Array.isArray(userContent)) {
        for (const block of userContent as Block[]) {
          if (block.type !== 'tool_result') continue;

          const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : null;
          const pending = toolUseId ? pendingTools.get(toolUseId) : undefined;

          const toolName = pending?.name ?? 'unknown';
          const toolInput = pending?.input ?? {};

          let toolOutput: unknown = block.content;
          if (Array.isArray(block.content)) {
            toolOutput = (block.content as Array<{ text?: string }>)
              .map(b => b.text ?? '').join('');
          }

          const eventId = pending?.eventId
            ?? (uuid ? `${uuid}_tr_gap_${toolUseId ?? ''}` : null);
          if (!eventId) continue;

          events.push(buildEvent(
            eventId, 'tool_call_completed',
            sessionId, agentType, pending?.timestamp ?? ts,
            { toolName, toolInput, toolOutput, completedAt: ts },
            classifyRisk(toolName, toolInput)
          ));

          if (toolUseId) pendingTools.delete(toolUseId);
        }
      }
    }
  }

  return injectAll(events, eventStore);
}

function injectAll(events: TimelineEvent[], eventStore: EventStore): number {
  for (const event of events) {
    eventStore.addRaw(event);
  }
  return events.length;
}

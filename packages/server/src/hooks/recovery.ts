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
import { classifyRisk } from '../events/classifier.js';
import type { EventStore } from '../events/store.js';
import type { TimelineEvent } from '../events/types.js';

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

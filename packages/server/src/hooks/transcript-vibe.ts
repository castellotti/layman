/**
 * Historical session import for Mistral Vibe. Sibling of transcript-pi.ts; the
 * live counterpart it mirrors is the passive tailer in `vibe/watcher.ts`, whose
 * `processMessage()` this reproduces for whole-file replay.
 *
 * A Vibe session lives in a directory `session_<YYYYMMDD>_<HHMMSS>_<shorthash>/`
 * holding two files: `meta.json` (session id, cwd, start/end time) and
 * `messages.jsonl` (a flat, append-only sequence of role-tagged messages). The
 * transcript we hand the parser is `messages.jsonl`; everything else comes from
 * `meta.json`, read at discovery time.
 *
 * Timestamps are the one wrinkle. Vibe's messages carry *no* per-message time
 * (which is why the live watcher stamps them with `Date.now()`), so a
 * standalone parse of `messages.jsonl` has nothing to anchor a session's date
 * to. The session's real span is in `meta.json` (`start_time`/`end_time`), read
 * during discovery and stashed in `sessionSpans` keyed by session id; `parse()`
 * reads it back and spreads events evenly across that span so `importSession()`
 * (which derives started_at/last_seen from the first/last event) lands the
 * session on the right day. discover() always runs before parse() within one
 * `importHistoricalSessions()` pass (discoverTranscriptFiles() is called first),
 * which is what makes the hand-off safe; a missing span falls back to now.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { classifyRisk } from '../events/classifier.js';
import type { TimelineEvent } from '../events/types.js';
import type { DiscoveredTranscript, TranscriptMetadata, TranscriptSource } from './transcript-shared.js';
import { buildEvent } from './transcript-shared.js';

const AGENT_TYPE = 'mistral-vibe';

/**
 * Map Vibe snake_case tool names to Layman PascalCase. A deliberate duplicate of
 * the identically-named table in `vibe/watcher.ts`: the two are the same rule
 * applied to the live and historical paths, and there is no shared package for a
 * short table. Keep both in sync by hand.
 */
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

function mapToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

interface VibeMeta {
  session_id?: string;
  start_time?: string;
  end_time?: string | null;
  environment?: { working_directory?: string };
}

/** Session time spans captured at discovery, consumed by parse(). See file header. */
const sessionSpans = new Map<string, { startMs: number; endMs: number }>();

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan one `.vibe/logs/session` directory for `session_*` subdirectories, each
 * of which pairs a `meta.json` with a `messages.jsonl`. The session id is
 * `meta.json`'s `session_id` (the same id the live watcher records, so dedupe
 * against an already-watched session works via the live-source skip in
 * recovery.ts). `label` tags a glove-sandboxed root (its env id) and is
 * undefined for the native root.
 *
 * The `active/` directory Vibe keeps alongside the sessions holds only lock
 * files and is skipped by the `meta.json` existence check.
 */
export function discoverVibeSessionsUnder(base: string, label?: string): DiscoveredTranscript[] {
  const results: DiscoveredTranscript[] = [];
  if (!existsSync(base)) return results;

  let entries: string[];
  try { entries = readdirSync(base); } catch { return results; }

  for (const name of entries) {
    const dir = join(base, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const metaPath = join(dir, 'meta.json');
    const messagesPath = join(dir, 'messages.jsonl');
    if (!existsSync(metaPath) || !existsSync(messagesPath)) continue;

    let meta: VibeMeta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as VibeMeta;
    } catch {
      continue;
    }

    const sessionId = meta.session_id;
    if (!sessionId) continue;

    const startMs = meta.start_time ? new Date(meta.start_time).getTime() : 0;
    const endMs = meta.end_time ? new Date(meta.end_time).getTime() : startMs;
    sessionSpans.set(sessionId, {
      startMs: startMs || Date.now(),
      endMs: endMs && endMs >= startMs ? endMs : startMs || Date.now(),
    });

    results.push({
      path: messagesPath,
      sessionId,
      projectDir: name,
      agentType: AGENT_TYPE,
      cwd: meta.environment?.working_directory ?? '',
      label,
    });
  }

  return results;
}

/**
 * Discover native Vibe sessions from `~/.vibe/logs/session/` (Docker-mounted at
 * `/root/.vibe/...` first, same base-path order the other sources use). Only the
 * first base path that yields results is used.
 */
export function discoverVibeSessions(): DiscoveredTranscript[] {
  const basePaths = [
    join('/root', '.vibe', 'logs', 'session'),
    join(homedir(), '.vibe', 'logs', 'session'),
  ];

  for (const base of basePaths) {
    const results = discoverVibeSessionsUnder(base);
    if (results.length > 0) return results;
  }

  return [];
}

/**
 * Discover Vibe sessions inside glove sandbox homes. `roots` are the Vibe watch
 * roots `GloveSource` reports (each `.../.vibe/logs/session` path plus its env id
 * label); scanning them here is what makes **Import session history** cover
 * gloved Vibe runs, tagged with their env id. Returns nothing when glove is
 * disabled (the caller passes no Vibe roots).
 */
export function discoverGloveVibeSessions(roots: Array<{ path: string; label?: string }>): DiscoveredTranscript[] {
  return roots.flatMap((root) => discoverVibeSessionsUnder(root.path, root.label));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface VibeToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface VibeMessage {
  role?: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string | null;
  message_id?: string;
  tool_calls?: VibeToolCall[] | null;
  tool_call_id?: string;
  name?: string;
}

/**
 * Spread event timestamps evenly across the session's real span so an imported
 * session sorts onto the right day. `i` is the source line index; the first line
 * gets startMs and the last gets endMs (see file header for why messages carry
 * no time of their own).
 */
function tsForIndex(i: number, total: number, startMs: number, endMs: number): number {
  if (total <= 1 || endMs <= startMs) return startMs + i;
  return Math.round(startMs + (endMs - startMs) * (i / (total - 1)));
}

/**
 * Parse one Vibe `messages.jsonl` into Layman events, reproducing the live
 * watcher's `processMessage()` over the whole file. Emits `tool_call_completed`
 * (not the live path's separate `tool_call_approved` + `_completed` pair, which
 * would double-count in history) and a trailing `tool_call_pending` for any tool
 * left unmatched when the session ended — the same shape the pi importer uses.
 */
export function parseVibeTranscript(
  lines: string[],
  sessionId: string
): { events: TimelineEvent[]; metadata: TranscriptMetadata } {
  const metadata: TranscriptMetadata = { cwd: '', gitBranch: '', version: '', firstTimestamp: 0, lastTimestamp: 0 };
  const events: TimelineEvent[] = [];
  if (lines.length === 0) return { events, metadata };

  const span = sessionSpans.get(sessionId);
  const startMs = span?.startMs ?? Date.now();
  const endMs = span?.endMs ?? startMs;
  const total = lines.length;

  // tool_call_id -> the tool call's event id, name, input, and timestamp
  const pendingTools = new Map<string, {
    eventId: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: number;
  }>();

  for (let i = 0; i < lines.length; i++) {
    let msg: VibeMessage;
    try { msg = JSON.parse(lines[i]) as VibeMessage; } catch { continue; }

    const ts = tsForIndex(i, total, startMs, endMs);
    if (metadata.firstTimestamp === 0) metadata.firstTimestamp = ts;
    metadata.lastTimestamp = ts;

    if (msg.role === 'user') {
      if (msg.content) {
        events.push(buildEvent(
          `${sessionId}_${msg.message_id ?? `u${i}`}`,
          'user_prompt', sessionId, AGENT_TYPE, ts,
          { prompt: msg.content }
        ));
      }

    } else if (msg.role === 'assistant') {
      // A reasoning-only message (no content, only reasoning_content) is still
      // recorded so an aborted turn keeps its reasoning — matching the turn rule.
      if (msg.content || msg.reasoning_content) {
        events.push(buildEvent(
          `${sessionId}_${msg.message_id ?? `a${i}`}_resp`,
          'agent_response', sessionId, AGENT_TYPE, ts,
          { prompt: msg.content ?? '', thinking: msg.reasoning_content || undefined }
        ));
      }

      if (msg.tool_calls) {
        for (let ci = 0; ci < msg.tool_calls.length; ci++) {
          const tc = msg.tool_calls[ci];
          const toolName = mapToolName(tc.function?.name ?? 'unknown');
          let toolInput: Record<string, unknown> = {};
          try {
            if (tc.function?.arguments) {
              toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            }
          } catch {
            toolInput = { raw: tc.function?.arguments };
          }
          if (tc.id) {
            pendingTools.set(tc.id, {
              eventId: `${sessionId}_${msg.message_id ?? `a${i}`}_tc_${ci}`,
              name: toolName,
              input: toolInput,
              timestamp: ts,
            });
          }
        }
      }

    } else if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id;
      const pending = toolCallId ? pendingTools.get(toolCallId) : undefined;
      const toolName = pending?.name ?? mapToolName(msg.name ?? 'unknown');
      const toolInput = pending?.input ?? {};
      const toolOutput = msg.content ?? '';
      const riskLevel = classifyRisk(toolName, toolInput);
      const eventId = pending?.eventId ?? `${sessionId}_tr_${toolCallId ?? i}`;

      events.push(buildEvent(
        eventId, 'tool_call_completed', sessionId, AGENT_TYPE, pending?.timestamp ?? ts,
        { toolName, toolInput, toolOutput, completedAt: ts },
        riskLevel
      ));
      if (toolCallId) pendingTools.delete(toolCallId);
    }
    // system messages are ignored, matching the live watcher.
  }

  // Anything still pending means the session ended mid-call.
  for (const pending of pendingTools.values()) {
    events.push(buildEvent(
      pending.eventId, 'tool_call_pending', sessionId, AGENT_TYPE, pending.timestamp,
      { toolName: pending.name, toolInput: pending.input },
      classifyRisk(pending.name, pending.input)
    ));
  }

  // tool_call_completed borrows its earlier tool-call timestamp and the trailing
  // pending flush can land out of order, so sort — importSession() reads
  // events[0]/events[last] for the session's time range.
  events.sort((a, b) => a.timestamp - b.timestamp);

  return { events, metadata };
}

export const vibeTranscriptSource: TranscriptSource = {
  agentType: AGENT_TYPE,
  discover: discoverVibeSessions,
  parse: parseVibeTranscript,
};

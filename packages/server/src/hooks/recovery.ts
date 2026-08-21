/**
 * Pre-activation transcript recovery and historical session import.
 *
 * This module handles three scenarios:
 *   1. Pre-activation recovery: When /layman is run mid-session, reads the JSONL
 *      transcript up to the activation command and injects prior events.
 *      Claude Code only — the only harness that sends transcript_path.
 *   2. Startup gap recovery: Fills events that occurred while Layman was down.
 *      Claude Code only — see GAP_RECOVERY_AGENT_TYPES below for why.
 *   3. Historical import: Discovers ALL transcript files across every
 *      registered TranscriptSource (the "Transcript source registry" section
 *      below) and imports sessions that were never monitored live. Adding a
 *      harness here is the only change needed to cover it.
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
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { classifyRisk } from '../events/classifier.js';
import type { EventStore } from '../events/store.js';
import type { TimelineEvent } from '../events/types.js';
import type { Database } from '../db/database.js';
import type { SessionRecorder } from '../db/recorder.js';
import type { DiscoveredTranscript, TranscriptMetadata, TranscriptSource } from './transcript-shared.js';
import { buildEvent } from './transcript-shared.js';
import { piTranscriptSource } from './transcript-pi.js';

export type { DiscoveredTranscript, TranscriptMetadata, TranscriptSource } from './transcript-shared.js';

const ACTIVATION_PATTERN = /echo\s+["']?layman:activate["']?|curl\b.*\/api\/activate/;

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Shared transcript parser (claude-code)
// ---------------------------------------------------------------------------

interface ParseOptions {
  stopAtActivation?: boolean;
  afterTimestamp?: number;
}

/**
 * Parse Claude Code JSONL lines into TimelineEvents.
 * Shared by pre-activation recovery, gap recovery, and full history import.
 */
export function parseTranscriptLines(
  lines: string[],
  sessionId: string,
  agentType: string,
  options: ParseOptions = {}
): { events: TimelineEvent[]; metadata: TranscriptMetadata } {
  const { stopAtActivation = false, afterTimestamp } = options;

  const metadata: TranscriptMetadata = {
    cwd: '',
    gitBranch: '',
    version: '',
    firstTimestamp: 0,
    lastTimestamp: 0,
  };

  const events: TimelineEvent[] = [];

  // Pending tool calls keyed by tool_call_id
  const pendingTools = new Map<string, {
    eventId: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: number;
  }>();

  // Phase 1 (if afterTimestamp set): pre-scan to collect tool_use blocks before the gap
  let startIndex = 0;
  if (afterTimestamp !== undefined) {
    for (let i = 0; i < lines.length; i++) {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(lines[i]) as Record<string, unknown>; } catch { continue; }

      const ts = typeof obj.timestamp === 'string'
        ? new Date(obj.timestamp).getTime() : 0;
      if (ts > afterTimestamp) { startIndex = i; break; }

      // Collect metadata from any line
      if (!metadata.cwd && typeof obj.cwd === 'string') metadata.cwd = obj.cwd;
      if (!metadata.version && typeof obj.version === 'string') metadata.version = obj.version;
      if (!metadata.gitBranch && typeof obj.gitBranch === 'string') metadata.gitBranch = obj.gitBranch;

      if (obj.type === 'assistant') {
        const msg = obj.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(msg?.content) ? msg!.content as Block[] : [];
        const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;

        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi];
          if (block.type !== 'tool_use') continue;
          const toolCallId = typeof block.id === 'string' ? block.id : null;
          if (!toolCallId || !uuid) continue;
          pendingTools.set(toolCallId, {
            eventId: `${uuid}_tc_${bi}`,
            name: typeof block.name === 'string' ? block.name : 'unknown',
            input: (block.input && typeof block.input === 'object')
              ? block.input as Record<string, unknown> : {},
            timestamp: ts,
          });
        }
      } else if (obj.type === 'user') {
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
    // If no gap found (all events <= afterTimestamp), nothing to import
    if (startIndex === 0 && lines.length > 0) {
      const lastObj = tryParse(lines[lines.length - 1]);
      if (lastObj) {
        const lastTs = typeof lastObj.timestamp === 'string'
          ? new Date(lastObj.timestamp).getTime() : 0;
        if (lastTs <= afterTimestamp) return { events, metadata };
      }
    }
  }

  // Phase 2: parse events
  for (let i = startIndex; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(lines[i]) as Record<string, unknown>; } catch { continue; }

    const lineType = obj.type as string | undefined;
    if (lineType !== 'user' && lineType !== 'assistant') {
      // Still extract metadata from non-content lines
      if (!metadata.cwd && typeof obj.cwd === 'string') metadata.cwd = obj.cwd;
      if (!metadata.version && typeof obj.version === 'string') metadata.version = obj.version;
      if (!metadata.gitBranch && typeof obj.gitBranch === 'string') metadata.gitBranch = obj.gitBranch;
      continue;
    }

    const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;
    const ts = typeof obj.timestamp === 'string'
      ? new Date(obj.timestamp).getTime()
      : Date.now();

    // Extract metadata from first relevant line
    if (!metadata.cwd && typeof obj.cwd === 'string') metadata.cwd = obj.cwd;
    if (!metadata.version && typeof obj.version === 'string') metadata.version = obj.version;
    if (!metadata.gitBranch && typeof obj.gitBranch === 'string') metadata.gitBranch = obj.gitBranch;

    if (metadata.firstTimestamp === 0) metadata.firstTimestamp = ts;
    metadata.lastTimestamp = ts;

    // Skip events before the gap when afterTimestamp is set
    if (afterTimestamp !== undefined && ts <= afterTimestamp) continue;

    const msg = obj.message as { role?: string; content?: unknown } | undefined;
    if (!msg) continue;

    if (lineType === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content as Block[] : [];
      const textParts: string[] = [];

      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];

        if (block.type === 'text' && typeof block.text === 'string') {
          const text = (block.text as string).trim();
          if (text) textParts.push(text);

        } else if (block.type === 'tool_use') {
          const toolCallId = typeof block.id === 'string' ? block.id : null;
          const toolName = typeof block.name === 'string' ? block.name : 'unknown';
          const toolInput = (block.input && typeof block.input === 'object')
            ? block.input as Record<string, unknown>
            : {};

          // Activation boundary check
          if (stopAtActivation && toolName === 'Bash') {
            const cmd = (toolInput as { command?: string }).command ?? '';
            if (ACTIVATION_PATTERN.test(cmd)) {
              if (textParts.length > 0 && uuid) {
                events.push(buildEvent(
                  `${uuid}_resp`, 'agent_response',
                  sessionId, agentType, ts,
                  { prompt: textParts.join('\n\n') }
                ));
              }
              return { events, metadata };
            }
          }

          if (toolCallId && uuid) {
            pendingTools.set(toolCallId, {
              eventId: `${uuid}_tc_${bi}`,
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

          let toolOutput: unknown = block.content;
          if (Array.isArray(block.content)) {
            toolOutput = (block.content as Array<{ text?: string }>)
              .map(b => b.text ?? '').join('');
          }

          const riskLevel = classifyRisk(toolName, toolInput);
          const eventId = pending?.eventId
            ?? (uuid ? `${uuid}_tr_${toolUseId ?? ''}` : null);

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

  return { events, metadata };
}

function tryParse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Transcript source registry
//
// Each harness that can be discovered and imported from on-disk transcripts
// registers one TranscriptSource here. Adding a harness to this list is what
// makes discoverTranscriptFiles() and importHistoricalSessions() see it —
// there is no other place agentType is hardcoded for either function.
// ---------------------------------------------------------------------------

/**
 * Discover all Claude Code JSONL transcript files from ~/.claude/projects/.
 * Returns one entry per main transcript file (excludes subagent transcripts).
 */
function discoverClaudeCodeTranscripts(): DiscoveredTranscript[] {
  const results: DiscoveredTranscript[] = [];
  const basePaths = ['/root/.claude/projects', join(homedir(), '.claude', 'projects')];

  for (const base of basePaths) {
    if (!existsSync(base)) continue;

    let projectDirs: string[];
    try { projectDirs = readdirSync(base); } catch { continue; }

    for (const projectDir of projectDirs) {
      const projectPath = join(base, projectDir);
      let stat;
      try { stat = statSync(projectPath); } catch { continue; }
      if (!stat.isDirectory()) continue;

      let files: string[];
      try { files = readdirSync(projectPath); } catch { continue; }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        // Skip non-UUID filenames (e.g. config files)
        const sessionId = file.replace('.jsonl', '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId)) continue;

        results.push({
          path: join(projectPath, file),
          sessionId,
          projectDir,
          agentType: 'claude-code',
        });
      }
    }

    // Only use the first base path that exists (Docker or native)
    if (results.length > 0) break;
  }

  return results;
}

const claudeCodeSource: TranscriptSource = {
  agentType: 'claude-code',
  discover: discoverClaudeCodeTranscripts,
  parse: (lines, sessionId) => parseTranscriptLines(lines, sessionId, 'claude-code'),
  parseAfter: (lines, sessionId, afterTimestamp) =>
    parseTranscriptLines(lines, sessionId, 'claude-code', { afterTimestamp }),
};

const TRANSCRIPT_SOURCES: TranscriptSource[] = [claudeCodeSource, piTranscriptSource];

// ---------------------------------------------------------------------------
// Pre-activation recovery (called mid-session when /layman activates)
// ---------------------------------------------------------------------------

/**
 * Parse and inject all events from the transcript that occurred before the
 * /layman activation command.
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
  const { events } = parseTranscriptLines(lines, sessionId, agentType, {
    stopAtActivation: true,
  });

  return flush(sessionId, agentType, events, eventStore);
}

/**
 * Prepend a deterministic session_start event and inject everything into
 * the EventStore. addRaw() emits 'event:new', which the SessionRecorder
 * picks up and writes via INSERT OR IGNORE — safe to call multiple times.
 */
function flush(
  sessionId: string,
  agentType: string,
  events: TimelineEvent[],
  eventStore: EventStore
): number {
  if (events.length === 0) return 0;

  const startTs = events[0].timestamp;

  // Deterministic ID: same session always produces the same session_start row.
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

  return events.length + 1;
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
 * Startup gap recovery supports claude-code only. pi has no `transcript_path`
 * in its hook payloads (deliberately — see the root CLAUDE.md), and its
 * on-disk directory naming isn't the cwd-to-dashes scheme
 * resolveTranscriptPath() assumes, so there is nothing to resolve a live
 * session's path from here. Reading this off the registry's own agentType,
 * rather than a second `'claude-code'` string literal, keeps this list from
 * silently drifting from the one in TRANSCRIPT_SOURCES.
 */
const GAP_RECOVERY_AGENT_TYPES = [claudeCodeSource.agentType];

/**
 * On server startup, scan SQLite for claude-code sessions that have no
 * session_end event and whose JSONL transcript contains events written
 * after the last recorded SQLite timestamp.
 */
export async function recoverSessionGaps(
  db: Database,
  eventStore: EventStore
): Promise<{ events: number; sessions: number }> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  type SessionRow = { session_id: string; cwd: string; last_event_ts: number };
  const placeholders = GAP_RECOVERY_AGENT_TYPES.map(() => '?').join(',');
  const sessions = db.prepare(`
    SELECT rs.session_id, rs.cwd, MAX(re.timestamp) AS last_event_ts
    FROM recorded_sessions rs
    JOIN recorded_events re ON re.session_id = rs.session_id
    WHERE rs.agent_type IN (${placeholders})
      AND rs.cwd != ''
      AND rs.last_seen >= ?
      AND rs.session_id NOT IN (
        SELECT session_id FROM recorded_events WHERE type = 'session_end'
      )
    GROUP BY rs.session_id
  `).all(...GAP_RECOVERY_AGENT_TYPES, cutoff) as SessionRow[];

  let totalEvents = 0;
  let totalSessions = 0;
  for (const { session_id, cwd, last_event_ts } of sessions) {
    const transcriptPath = resolveTranscriptPath(cwd, session_id);
    if (!transcriptPath) continue;

    const content = await readTranscript(transcriptPath);
    if (!content) continue;

    const lines = content.trim().split('\n').filter(Boolean);
    const { events } = parseTranscriptLines(lines, session_id, claudeCodeSource.agentType, {
      afterTimestamp: last_event_ts,
    });

    if (events.length > 0) {
      for (const event of events) {
        eventStore.addRaw(event);
      }
      console.log(`[recovery] Filled ${events.length}-event gap for session ${session_id.slice(0, 8)}`);
      totalEvents += events.length;
      totalSessions += 1;
    }
  }
  return { events: totalEvents, sessions: totalSessions };
}

// ---------------------------------------------------------------------------
// Historical session import
// ---------------------------------------------------------------------------

export interface ImportedSessionSummary {
  sessionId: string;
  cwd: string;
  agentType: string;
  startedAt: number;
  lastSeen: number;
  eventCount: number;
  toolCallCount: number;
  userPromptCount: number;
  status: 'discovered' | 'enriched' | 'skipped';
}

export interface ImportResult {
  discovered: number;
  enriched: number;
  totalEvents: number;
  skipped: number;
  errors: number;
  sessions: ImportedSessionSummary[];
}

/**
 * Discover all known-harness transcript files on disk by asking every
 * registered TranscriptSource where its files live. There is no default
 * agentType here — a file only appears in the result if some source claimed
 * it, and every entry already carries the agentType that claimed it.
 */
export function discoverTranscriptFiles(): DiscoveredTranscript[] {
  return TRANSCRIPT_SOURCES.flatMap((source) => source.discover());
}

/**
 * Import historical sessions from any registered harness's transcript files.
 * Discovers all files, imports unknown sessions, and optionally enriches
 * existing sessions with missing events.
 */
export async function importHistoricalSessions(
  db: Database,
  eventStore: EventStore,
  recorder: SessionRecorder,
  options?: { enrichExisting?: boolean }
): Promise<ImportResult> {
  const { enrichExisting = false } = options ?? {};

  const result: ImportResult = {
    discovered: 0,
    enriched: 0,
    totalEvents: 0,
    skipped: 0,
    errors: 0,
    sessions: [],
  };

  const transcriptFiles = discoverTranscriptFiles();
  if (transcriptFiles.length === 0) return result;

  const sourceByAgentType = new Map(TRANSCRIPT_SOURCES.map((s) => [s.agentType, s]));

  // Get existing sessions from DB
  type SessionRow = { session_id: string; source: string | null };
  const existingRows = db.prepare(
    'SELECT session_id, source FROM recorded_sessions'
  ).all() as SessionRow[];
  const existingSessions = new Map(existingRows.map(r => [r.session_id, r.source]));

  for (const discovered of transcriptFiles) {
    const { path, sessionId, agentType } = discovered;
    const source = sourceByAgentType.get(agentType)!;

    const existingSource = existingSessions.get(sessionId);
    const isKnown = existingSource !== undefined;

    // If known and we're not enriching, skip
    if (isKnown && !enrichExisting) {
      result.skipped++;
      continue;
    }

    try {
      const content = await readTranscript(path);
      if (!content) {
        result.skipped++;
        continue;
      }

      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        result.skipped++;
        continue;
      }

      if (!isKnown) {
        // Full import of unknown session
        const { events, metadata } = source.parse(lines, sessionId);

        if (events.length === 0) {
          result.skipped++;
          continue;
        }

        const cwd = metadata.cwd || discovered.cwd || '';

        // Batch insert via recorder
        recorder.importSession(sessionId, cwd, agentType, events, 'imported');

        const toolCallCount = events.filter(e => e.type === 'tool_call_completed').length;
        const userPromptCount = events.filter(e => e.type === 'user_prompt').length;

        result.discovered++;
        result.totalEvents += events.length;
        result.sessions.push({
          sessionId,
          cwd,
          agentType,
          startedAt: metadata.firstTimestamp,
          lastSeen: metadata.lastTimestamp,
          eventCount: events.length,
          toolCallCount,
          userPromptCount,
          status: 'discovered',
        });

      } else if (enrichExisting && source.parseAfter) {
        // Enrich existing session — find events after last recorded timestamp
        type TsRow = { max_ts: number | null };
        const tsRow = db.prepare(
          'SELECT MAX(timestamp) as max_ts FROM recorded_events WHERE session_id = ?'
        ).get(sessionId) as TsRow | undefined;
        const lastRecordedTs = tsRow?.max_ts ?? 0;

        const { events, metadata } = source.parseAfter(lines, sessionId, lastRecordedTs);

        if (events.length === 0) {
          result.skipped++;
          continue;
        }

        // Use addRaw for enrichment — triggers recorder via event:new listener
        for (const event of events) {
          eventStore.addRaw(event);
        }

        const toolCallCount = events.filter(e => e.type === 'tool_call_completed').length;
        const userPromptCount = events.filter(e => e.type === 'user_prompt').length;

        result.enriched++;
        result.totalEvents += events.length;
        result.sessions.push({
          sessionId,
          cwd: metadata.cwd || '',
          agentType,
          startedAt: metadata.firstTimestamp,
          lastSeen: metadata.lastTimestamp,
          eventCount: events.length,
          toolCallCount,
          userPromptCount,
          status: 'enriched',
        });

      } else if (enrichExisting) {
        // No incremental parse for this harness (e.g. pi's tree structure
        // doesn't support a flat afterTimestamp cutoff): re-parse the whole
        // file and let importSession()'s INSERT OR IGNORE upsert skip
        // whatever is already recorded, so this stays idempotent.
        const before = (db.prepare(
          'SELECT COUNT(*) as c FROM recorded_events WHERE session_id = ?'
        ).get(sessionId) as { c: number }).c;

        const { events, metadata } = source.parse(lines, sessionId);
        if (events.length === 0) {
          result.skipped++;
          continue;
        }

        const cwd = metadata.cwd || discovered.cwd || '';
        // importSession()'s own upsert never downgrades an existing 'live'
        // session's source, so 'imported' here is safe regardless of what
        // existingSource currently is.
        recorder.importSession(sessionId, cwd, agentType, events, 'imported');

        const after = (db.prepare(
          'SELECT COUNT(*) as c FROM recorded_events WHERE session_id = ?'
        ).get(sessionId) as { c: number }).c;
        const added = after - before;

        if (added === 0) {
          result.skipped++;
          continue;
        }

        const toolCallCount = events.filter(e => e.type === 'tool_call_completed').length;
        const userPromptCount = events.filter(e => e.type === 'user_prompt').length;

        result.enriched++;
        result.totalEvents += added;
        result.sessions.push({
          sessionId,
          cwd,
          agentType,
          startedAt: metadata.firstTimestamp,
          lastSeen: metadata.lastTimestamp,
          eventCount: added,
          toolCallCount,
          userPromptCount,
          status: 'enriched',
        });
      }
    } catch (err) {
      console.error(`[import] Failed to parse ${path}:`, err);
      result.errors++;
    }
  }

  return result;
}

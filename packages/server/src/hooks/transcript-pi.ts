/**
 * Historical session import for pi. Sibling of transcript.ts (which handles
 * claude-code's subagent sidechain format); the full-session claude-code
 * parser this mirrors lives in recovery.ts's parseTranscriptLines().
 *
 * pi's session files are format-version-3 JSONL trees (id/parentId, not a
 * flat sequence — pi branches in place on /fork rather than starting a new
 * file), documented in pi's own `docs/session-format.md`. See
 * docs/plans/plan-pi-history-import.md for the design.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { classifyRisk } from '../events/classifier.js';
import type { TimelineEvent } from '../events/types.js';
import type { DiscoveredTranscript, TranscriptMetadata, TranscriptSource } from './transcript-shared.js';
import { buildEvent } from './transcript-shared.js';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive a pi session id from a `<timestamp>_<sessionId>.jsonl` filename, or
 * null when the name isn't a pi transcript. The session id is the uuid suffix —
 * the same id pi's live extension reports, which is what makes dedupe against an
 * already-recorded session work.
 *
 * Shared by history import (`discoverPiSessionsUnder`) and the passive watcher
 * (`pi/watcher.ts`) so the two never disagree about what counts as a pi
 * transcript. If pi's filename format changes, this is the single place to edit.
 */
export function sessionIdFromPiFilename(file: string): string | null {
  if (!file.endsWith('.jsonl')) return null;
  const stem = file.slice(0, -'.jsonl'.length);
  const underscoreIdx = stem.lastIndexOf('_');
  if (underscoreIdx === -1) return null;
  const sessionId = stem.slice(underscoreIdx + 1);
  return SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
}

/**
 * pi names its tools in lowercase; Layman's risk classifier and read-only
 * auto-allow list are keyed on claude-code's PascalCase names.
 *
 * This is a deliberate duplicate of the identically-named map in
 * `packages/pi-extension/src/index.ts`. That file is installed verbatim to
 * `~/.pi/agent/extensions/layman/index.ts` and is constrained to have zero
 * imports (see its file header) — importing this map from a workspace
 * package would break that constraint, and a shared package doesn't exist
 * for a two-line table. Keep both copies in sync by hand.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
};

function mapToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Decode pi's session directory name back to a cwd: `--Users-alice-foo--` ->
 * `/Users/alice/foo`. Lossy whenever a real path segment itself contains a
 * dash (`pi-local` vs a literal `pi/local`) — it is only ever used as a
 * fallback. The session file's own header `cwd` field, read in
 * `parsePiTranscript()`, is authoritative when present.
 */
export function decodeCwd(dirName: string): string {
  const trimmed = dirName.replace(/^--/, '').replace(/--$/, '');
  return '/' + trimmed.replace(/-/g, '/');
}

/**
 * Scan one `.pi/agent/sessions` directory for session files named
 * `<ISO-timestamp>_<uuid>.jsonl`. The session id is the uuid suffix — the same
 * id pi's live extension reports — which is what makes dedupe against an
 * already-recorded session work. `label` tags a glove-sandboxed root (its env
 * id) and is undefined for the native root.
 */
export function discoverPiSessionsUnder(base: string, label?: string): DiscoveredTranscript[] {
  const results: DiscoveredTranscript[] = [];
  if (!existsSync(base)) return results;

  let projectDirs: string[];
  try { projectDirs = readdirSync(base); } catch { return results; }

  for (const projectDir of projectDirs) {
    const projectPath = join(base, projectDir);
    let stat;
    try { stat = statSync(projectPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try { files = readdirSync(projectPath); } catch { continue; }

    for (const file of files) {
      const sessionId = sessionIdFromPiFilename(file);
      if (!sessionId) continue;

      results.push({
        path: join(projectPath, file),
        sessionId,
        projectDir,
        agentType: 'pi',
        cwd: decodeCwd(projectDir),
        label,
      });
    }
  }

  return results;
}

/**
 * Discover native pi sessions from `~/.pi/agent/sessions/` (Docker-mounted at
 * `/root/.pi/...` first, same order `discoverTranscriptFiles()` uses for
 * claude-code). Only the first base path that yields results is used.
 */
export function discoverPiSessions(): DiscoveredTranscript[] {
  const basePaths = ['/root/.pi/agent/sessions', join(homedir(), '.pi', 'agent', 'sessions')];

  for (const base of basePaths) {
    const results = discoverPiSessionsUnder(base);
    if (results.length > 0) return results;
  }

  return [];
}

/**
 * Discover pi sessions inside glove sandbox homes. `roots` are the pi watch
 * roots `GloveSource` reports (each `.../.pi/agent/sessions` path plus its env
 * id label); scanning them here is what makes **Import session history** cover
 * gloved pi runs that were never monitored live, tagged with their env id.
 * Returns nothing when glove is disabled (the caller passes no pi roots).
 */
export function discoverGlovePiSessions(roots: Array<{ path: string; label?: string }>): DiscoveredTranscript[] {
  return roots.flatMap((root) => discoverPiSessionsUnder(root.path, root.label));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface PiEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  version?: number;
  cwd?: string;
  /** `model_change`. */
  modelId?: string;
  /** `thinking_level_change`. */
  thinkingLevel?: string;
  /** `compaction`: the summarising call is billed like any other. */
  usage?: unknown;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    /** Assistant only. */
    usage?: unknown;
    stopReason?: string;
    model?: string;
  };
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

/**
 * One call's tokens, as pi-ai records them (`Usage`). The kinds are disjoint except
 * `reasoning`, which is a part of `output` (OpenAI's `completion_tokens` and
 * Anthropic's `output_tokens` both include it; pi-ai copies them as they are), and
 * `input` excludes both cache kinds, so `input + output + cacheRead + cacheWrite`
 * is the call's `totalTokens`.
 */
export interface PiTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export const zeroTokens = (): PiTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** A `usage` object as tokens, or null when it is not one. */
function piTokensOf(usage: unknown): PiTokens | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  return {
    input: count(u.input), output: count(u.output), cacheRead: count(u.cacheRead),
    cacheWrite: count(u.cacheWrite), reasoning: count(u.reasoning),
  };
}

/** Add `b` into `into`. */
export function addTokens(into: PiTokens, b: PiTokens): void {
  for (const k of Object.keys(into) as Array<keyof PiTokens>) into[k] += b[k];
}

/** What the call put in the model's context: pi's `calculateContextTokens()`. */
function contextTokensOf(usage: unknown, t: PiTokens): number {
  const total = count((usage as Record<string, unknown>).totalTokens);
  return total || t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** The billed usage an entry carries: an assistant message's, or a compaction's summarising call. */
function billedUsage(entry: PiEntry): unknown {
  if (entry.type === 'compaction') return entry.usage;
  if (entry.type === 'message' && entry.message?.role === 'assistant') return entry.message.usage;
  return undefined;
}

/**
 * Token metrics of one pi session file. Null when nothing in it reports usage (an
 * older pi, or a session that has not answered yet).
 */
export interface PiMetrics {
  /** Every billed call in the file, on every branch (an abandoned branch was still paid for). */
  totals: PiTokens;
  /** Sum of `usage.cost.total` over the same calls (0 for a local model). */
  costUsd: number;
  /** The last valid assistant call on the active branch, or null. */
  current: PiTokens | null;
  /**
   * Tokens in the model's context, by pi's own rule (`AgentSession.getContextUsage()`): the
   * last valid assistant call's total on the active branch (not aborted, not an error, not
   * zero). A `compaction` or `context_edit` after it makes it stale, so it is null until the
   * next call answers: unknown rather than a wrong %. pi adds an estimate of the messages
   * after that call; a transcript reader has no tokenizer, so this is the call's figure.
   */
  contextTokens: number | null;
  /** The latest `model_change` on the active branch, else the last assistant message's model. */
  modelId?: string;
  /** The latest `thinking_level_change` on the active branch. */
  thinkingLevel?: string;
}

/**
 * Each billed call's tokens with the entry's time (epoch ms), across all branches, for
 * summing over a time range. Only lines that mention `"usage"` are parsed, so a long
 * transcript of tool output costs a substring search per line.
 */
export function piUsageSamples(lines: string[]): Array<{ at: number; tokens: PiTokens }> {
  const out: Array<{ at: number; tokens: PiTokens }> = [];
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    const entry = tryParse(line);
    if (!entry) continue;
    const tokens = piTokensOf(billedUsage(entry));
    const at = tsOf(entry);
    if (tokens && at > 0) out.push({ at, tokens });
  }
  return out;
}

function piMetrics(order: PiEntry[], path: PiEntry[]): PiMetrics | null {
  const totals = zeroTokens();
  let costUsd = 0;
  let billed = false;
  for (const entry of order) {
    const usage = billedUsage(entry);
    const tokens = piTokensOf(usage);
    if (!tokens) continue;
    billed = true;
    addTokens(totals, tokens);
    costUsd += count(((usage as Record<string, unknown>).cost as Record<string, unknown> | undefined)?.total);
  }
  if (!billed) return null;

  let current: PiTokens | null = null;
  let contextTokens: number | null = null;
  let modelId: string | undefined;
  let lastModel: string | undefined;
  let thinkingLevel: string | undefined;
  for (const entry of path) {
    if (entry.type === 'model_change' && typeof entry.modelId === 'string') modelId = entry.modelId;
    else if (entry.type === 'thinking_level_change' && typeof entry.thinkingLevel === 'string') thinkingLevel = entry.thinkingLevel;
    else if (entry.type === 'compaction' || entry.type === 'context_edit') contextTokens = null;
    else if (entry.type === 'message' && entry.message?.role === 'assistant') {
      const msg = entry.message;
      if (typeof msg.model === 'string') lastModel = msg.model;
      const tokens = piTokensOf(msg.usage);
      if (!tokens || msg.stopReason === 'aborted' || msg.stopReason === 'error') continue;
      const ctx = contextTokensOf(msg.usage, tokens);
      if (ctx <= 0) continue;
      current = tokens;
      contextTokens = ctx;
    }
  }
  return { totals, costUsd, current, contextTokens, modelId: modelId ?? lastModel, thinkingLevel };
}

function tryParse(line: string): PiEntry | null {
  try {
    const obj: unknown = JSON.parse(line);
    return obj && typeof obj === 'object' ? (obj as PiEntry) : null;
  } catch {
    return null;
  }
}

function tsOf(entry: PiEntry): number {
  return entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
}

/** Flatten pi's content-part array (or plain string) to text Layman stores. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }
  return '';
}

/**
 * Parse one pi session JSONL file into Layman events.
 *
 * A session file is a *tree*, not a flat log — pi branches in place on
 * `/fork` or tree navigation rather than starting a new file. A flat read
 * would replay abandoned branches as though they happened, so this walks
 * from the latest-timestamp leaf back to the root via `parentId` and imports
 * only that path, mirroring what pi's own `buildContextEntries()` sends the
 * model. Which leaf, when several exist, is a choice (most recently active
 * branch) rather than a fact recoverable from the file.
 */
export function parsePiTranscript(
  lines: string[],
  sessionId: string
): { events: TimelineEvent[]; metadata: TranscriptMetadata; metrics: PiMetrics | null } {
  const metadata: TranscriptMetadata = { cwd: '', gitBranch: '', version: '', firstTimestamp: 0, lastTimestamp: 0 };
  const events: TimelineEvent[] = [];
  if (lines.length === 0) return { events, metadata, metrics: null };

  // pi auto-migrates the file on load, so anything not version 3 on disk is
  // one pi has not opened since the upgrade. Refuse it rather than guessing
  // at an older schema; the caller's existing "zero events => skipped" path
  // surfaces this without needing a separate signal.
  const header = tryParse(lines[0]);
  if (!header || header.type !== 'session' || header.version !== 3) {
    return { events, metadata, metrics: null };
  }
  metadata.version = String(header.version);
  if (typeof header.cwd === 'string') metadata.cwd = header.cwd;

  const entries = new Map<string, PiEntry>();
  const order: PiEntry[] = [];
  const isParent = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const entry = tryParse(lines[i]);
    if (!entry || typeof entry.id !== 'string') continue; // tolerate a malformed line
    entries.set(entry.id, entry);
    order.push(entry);
    if (typeof entry.parentId === 'string') isParent.add(entry.parentId);
  }
  if (order.length === 0) return { events, metadata, metrics: null };

  let leaf: PiEntry | null = null;
  for (const entry of order) {
    if (isParent.has(entry.id!)) continue;
    if (!leaf || tsOf(entry) > tsOf(leaf)) leaf = entry;
  }
  if (!leaf) return { events, metadata, metrics: null };

  const path: PiEntry[] = [];
  const visited = new Set<string>();
  let cursor: PiEntry | undefined = leaf;
  while (cursor) {
    if (visited.has(cursor.id!)) break; // guard against a corrupt cycle
    visited.add(cursor.id!);
    path.push(cursor);
    cursor = cursor.parentId ? entries.get(cursor.parentId) : undefined;
  }
  path.reverse();

  const pendingTools = new Map<string, {
    eventId: string;
    name: string;
    input: Record<string, unknown>;
    timestamp: number;
  }>();

  for (const entry of path) {
    // 'custom' entries are extension bookkeeping and don't participate in
    // LLM context; 'model_change' / 'thinking_level_change' carry no content.
    if (entry.type !== 'message' || !entry.message) continue;
    const msg = entry.message;
    const ts = tsOf(entry);
    if (metadata.firstTimestamp === 0) metadata.firstTimestamp = ts;
    metadata.lastTimestamp = ts;

    if (msg.role === 'user') {
      const text = textFromContent(msg.content);
      if (text) {
        events.push(buildEvent(`${sessionId}_${entry.id}`, 'user_prompt', sessionId, 'pi', ts, { prompt: text }));
      }

    } else if (msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content as Array<Record<string, unknown>> : [];
      let text = '';
      let thinking = '';

      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text as string;
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          thinking += block.thinking as string;
        } else if (block.type === 'toolCall') {
          const toolCallId = typeof block.id === 'string' ? block.id : null;
          const toolName = mapToolName(typeof block.name === 'string' ? block.name : 'unknown');
          const toolInput = (block.arguments && typeof block.arguments === 'object')
            ? block.arguments as Record<string, unknown>
            : {};
          if (toolCallId) {
            pendingTools.set(toolCallId, {
              eventId: `${sessionId}_${entry.id}_tc_${bi}`,
              name: toolName,
              input: toolInput,
              timestamp: ts,
            });
          }
        }
      }

      // A message that is nothing but tool calls has no prose to record —
      // matches the live extension's message_end handler, which skips it too.
      if (text || thinking) {
        events.push(buildEvent(
          `${sessionId}_${entry.id}`, 'agent_response', sessionId, 'pi', ts,
          { prompt: text, thinking: thinking || undefined }
        ));
      }

    } else if (msg.role === 'toolResult') {
      const toolCallId = msg.toolCallId;
      const pending = toolCallId ? pendingTools.get(toolCallId) : undefined;
      const toolName = pending?.name ?? mapToolName(msg.toolName ?? 'unknown');
      const toolInput = pending?.input ?? {};
      const toolOutput = textFromContent(msg.content);
      const riskLevel = classifyRisk(toolName, toolInput);
      const eventId = pending?.eventId ?? `${sessionId}_${entry.id}_tr`;

      events.push(buildEvent(
        eventId, 'tool_call_completed', sessionId, 'pi', pending?.timestamp ?? ts,
        {
          toolName, toolInput, toolOutput, completedAt: ts,
          ...(msg.isError ? { error: toolOutput } : {}),
        },
        riskLevel
      ));
      if (toolCallId) pendingTools.delete(toolCallId);
    }
  }

  // Anything still pending means the session ended mid-call.
  for (const pending of pendingTools.values()) {
    events.push(buildEvent(
      pending.eventId, 'tool_call_pending', sessionId, 'pi', pending.timestamp,
      { toolName: pending.name, toolInput: pending.input },
      classifyRisk(pending.name, pending.input)
    ));
  }

  // Tool-call pairing above can append a trailing tool_call_pending out of
  // chronological order relative to events already pushed; importSession()
  // and the pre-scan below both read events[0] / events[last] for the
  // session's time range, so the array must be timestamp-ordered.
  events.sort((a, b) => a.timestamp - b.timestamp);

  return { events, metadata, metrics: piMetrics(order, path) };
}

export const piTranscriptSource: TranscriptSource = {
  agentType: 'pi',
  discover: discoverPiSessions,
  parse: parsePiTranscript,
};

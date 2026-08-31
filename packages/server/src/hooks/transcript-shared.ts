/**
 * Types and helpers shared between recovery.ts (the dispatcher + claude-code
 * parser) and each per-harness transcript source (e.g. transcript-pi.ts).
 *
 * Split out to avoid a circular import: recovery.ts registers each source and
 * calls into it, while a source module needs these same shapes to produce
 * what recovery.ts expects back.
 */
import type { TimelineEvent } from '../events/types.js';

export interface TranscriptMetadata {
  cwd: string;
  gitBranch: string;
  version: string;
  firstTimestamp: number;
  lastTimestamp: number;
}

/** A single transcript file found on disk, with its session id and harness already resolved. */
export interface DiscoveredTranscript {
  path: string;
  sessionId: string;
  projectDir: string;
  agentType: string;
  /** Best-effort cwd recovered at discovery time (e.g. from a directory name). A parser-reported cwd, when present, takes precedence. */
  cwd?: string;
  /**
   * Sandbox label (glove env id) for a transcript discovered under a glove
   * environment home; undefined for native transcripts. Surfaced as the session
   * name so imported gloved sessions are tagged like passively-watched ones.
   */
  label?: string;
}

/**
 * One harness's transcript support: where its files live on disk, and how to
 * turn a file's lines into Layman events. Registering a new harness here is
 * the only change `importHistoricalSessions()` needs.
 */
export interface TranscriptSource {
  agentType: string;
  discover(): DiscoveredTranscript[];
  parse(lines: string[], sessionId: string): { events: TimelineEvent[]; metadata: TranscriptMetadata };
  /**
   * The transcript's *authoritative* session id, read from the file contents
   * rather than its filename. Optional; when omitted (or it returns null) the
   * filename-derived id from `discover()` is used.
   *
   * This exists because a harness can write a transcript whose filename differs
   * from the session it belongs to. Claude Code does this on resume/fork: it
   * creates `<new-uuid>.jsonl` but stamps every line with the *original*
   * `sessionId`. Keying by filename then mints a phantom session whose events
   * all collide (on their deterministic ids) with the original's, leaving a
   * 0-event row that re-"enriches" the same events on every scan. Resolving the
   * id from the contents attributes those lines to the real session instead.
   */
  resolveSessionId?(lines: string[]): string | null;
  /**
   * Parse only events after a cutoff timestamp, for cheap enrichment of an
   * already-recorded session. Optional: a source without this (no on-disk
   * format to filter incrementally, or not worth the complexity yet) still
   * gets enriched — importHistoricalSessions() falls back to a full re-parse
   * routed through the idempotent importSession() upsert.
   */
  parseAfter?(
    lines: string[],
    sessionId: string,
    afterTimestamp: number
  ): { events: TimelineEvent[]; metadata: TranscriptMetadata };
}

export function buildEvent(
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

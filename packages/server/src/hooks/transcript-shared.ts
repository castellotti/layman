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

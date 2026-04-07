export type DriftLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface DriftThresholds {
  green: number;   // % below this = green (default 15)
  yellow: number;  // % below this = yellow (default 30)
  orange: number;  // % below this = orange, above = red (default 50)
}

/** Public drift state broadcast to clients via WebSocket */
export interface DriftState {
  sessionId: string;
  sessionGoalDriftPct: number;
  sessionGoalDriftLevel: DriftLevel;
  rulesDriftPct: number;
  rulesDriftLevel: DriftLevel;
  lastCheckTimestamp: number;
  lastCheckModel: string;
}

/** Result from a single drift algorithm LLM call */
export interface DriftCheckResult {
  driftPercentage: number;
  summary: string;
  indicators?: string[];
  violations?: Array<{ rule: string; action: string; severity: string }>;
  phantomReferences?: string[];
  patternBreaks?: string[];
}

/** Internal per-session state tracked by DriftMonitor */
export interface DriftSessionState {
  sessionId: string;
  // Goal drift tracking
  initialPrompt: string | null;
  recentPrompts: string[];
  recentToolCalls: Array<{
    toolName: string;
    toolInput: Record<string, unknown>;
    toolOutput?: unknown;
  }>;
  toolCallsSinceLastCheck: number;
  lastCheckTimestamp: number;
  // Scores (EMA-smoothed)
  sessionGoalDriftPct: number;
  sessionGoalDriftLevel: DriftLevel;
  rulesDriftPct: number;
  rulesDriftLevel: DriftLevel;
  lastCheckModel: string;
  // CLAUDE.md content cache
  claudeMdContents: Map<string, string>;
  // Intervention state
  interventionPending: boolean;
  lastInterventionTimestamp: number;
  // Running check guard
  checkInProgress: boolean;
}

/** Result of checkPreToolUse — determines whether to block or remind */
export interface DriftPreToolUseResult {
  shouldBlock: boolean;
  shouldRemind: boolean;
  reason?: string;
  rulesSummary?: string;
}

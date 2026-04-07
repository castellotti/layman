export type DriftLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface DriftThresholds {
  green: number;   // % below this = green (default 15)
  yellow: number;  // % below this = yellow (default 30)
  orange: number;  // % below this = orange, above = red (default 50)
}

/** Items the user has dismissed as false positives (per-session, in-memory) */
export interface DismissedDriftItems {
  indicators: string[];
  patternBreaks: string[];
  phantomReferences: string[];
  violations: string[];
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
  // Latest check summaries (for UI tooltips)
  sessionGoalSummary?: string;
  sessionGoalIndicators?: string[];
  rulesSummary?: string;
  rulesViolations?: Array<{ rule: string; action: string; severity: string }>;
  dismissedItems?: DismissedDriftItems;
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
  // Latest check results (for building DriftState summaries)
  lastGoalResult: DriftCheckResult | null;
  lastRulesResult: DriftCheckResult | null;
  // Per-item false positive dismissals
  dismissedItems: DismissedDriftItems;
}

/** Result of checkPreToolUse — determines whether to block or remind */
export interface DriftPreToolUseResult {
  shouldBlock: boolean;
  shouldRemind: boolean;
  reason?: string;
  rulesSummary?: string;
}

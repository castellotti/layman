import type { ApprovalDecision } from '../hooks/types.js';
import type { AnalysisResult, LaymansResult } from '../analysis/types.js';
import type { DriftLevel } from '../drift/types.js';

export type EventType =
  | 'tool_call_pending'
  | 'tool_call_approved'
  | 'tool_call_denied'
  | 'tool_call_delegated'
  | 'tool_call_completed'
  | 'tool_call_failed'
  | 'permission_request'
  | 'user_prompt'
  | 'agent_stop'
  | 'session_start'
  | 'session_end'
  | 'notification'
  | 'subagent_start'
  | 'subagent_stop'
  | 'agent_response'
  | 'stop_failure'
  | 'pre_compact'
  | 'post_compact'
  | 'elicitation'
  | 'elicitation_result'
  | 'analysis_result'
  | 'permission_denied'
  | 'setup'
  | 'config_change'
  | 'instructions_loaded'
  | 'task_created'
  | 'task_completed'
  | 'teammate_idle'
  | 'worktree_create'
  | 'worktree_remove'
  | 'cwd_changed'
  | 'file_changed'
  | 'session_metrics'
  | 'drift_check'
  | 'drift_alert';

export interface PermissionSuggestion {
  type: string;
  tool_name?: string;
  command?: string;
  description?: string;
  [key: string]: unknown;
}

export interface EventData {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  error?: string;
  prompt?: string;
  agentType?: string;
  notificationType?: string;
  source?: string;
  gapMinutes?: number;
  approvalId?: string;
  decision?: ApprovalDecision;
  completedAt?: number;
  permissionRequestType?: 'tool_use' | 'execution_mode';
  permissionSuggestions?: PermissionSuggestion[];
  fileAccess?: FileAccess[];
  urlAccess?: UrlAccess[];
  compactTrigger?: 'manual' | 'auto';
  compactSummary?: string;
  compactCustomInstructions?: string | null;
  permissionMode?: string;
  model?: string;
  errorDetails?: string;
  reason?: string;
  configSource?: string;
  filePath?: string;
  memoryType?: string;
  loadReason?: string;
  taskId?: string;
  taskSubject?: string;
  taskDescription?: string;
  teammateName?: string;
  teamName?: string;
  worktreeName?: string;
  worktreePath?: string;
  oldCwd?: string;
  newCwd?: string;
  fileEvent?: string;
  setupTrigger?: string;
  modelId?: string;
  modelDisplayName?: string;
  costUsd?: number;
  durationMs?: number;
  apiDurationMs?: number;
  linesAdded?: number;
  linesRemoved?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindowSize?: number;
  currentInputTokens?: number;
  currentOutputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  contextUsedPct?: number;
  contextRemainingPct?: number;
  exceeds200kTokens?: boolean;
  rateLimit5hrPct?: number;
  rateLimit5hrResetsAt?: string;
  rateLimit7dayPct?: number;
  rateLimit7dayResetsAt?: string;
  sessionName?: string;
  claudeCodeVersion?: string;
  driftType?: 'session_goal' | 'rules';
  driftPct?: number;
  driftLevel?: DriftLevel;
  driftPreviousLevel?: DriftLevel;
  driftSummary?: string;
  driftIndicators?: string[];
  driftViolations?: Array<{ rule: string; action: string; severity: string }>;
  driftPhantomRefs?: string[];
  driftPatternBreaks?: string[];
}

export interface TimelineEvent {
  id: string;
  type: EventType;
  timestamp: number;
  sessionId: string;
  agentType: string;
  data: EventData;
  analysis?: AnalysisResult;
  laymans?: LaymansResult;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface FileAccess {
  path: string;
  filename: string;
  operation: 'read' | 'wrote' | 'edited' | 'deleted';
  eventId: string;
  toolName: string;
  timestamp: number;
}

export interface UrlAccess {
  url: string;
  hostname: string;
  eventId: string;
  toolName: string;
  timestamp: number;
  bytesIn?: number;
  bytesOut?: number;
}

export interface SessionAccessLog {
  files: FileAccess[];
  urls: UrlAccess[];
}

export interface EventSummary {
  type: string;
  summary: string;
}

// Shared types for the web frontend

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

export interface AnalysisResult {
  meaning: string;
  goal: string;
  safety: {
    level: 'safe' | 'caution' | 'danger';
    summary: string;
    details?: string[];
  };
  security: {
    level: 'safe' | 'caution' | 'danger';
    summary: string;
    details?: string[];
  };
  risk: {
    level: 'low' | 'medium' | 'high';
    summary: string;
  };
  model: string;
  latencyMs: number;
  tokens: { input: number; output: number };
}

export interface LaymansResult {
  explanation: string;
  model: string;
  latencyMs: number;
  tokens: { input: number; output: number };
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

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
  // Phase 1: Previously discarded fields
  compactTrigger?: 'manual' | 'auto';
  compactSummary?: string;
  compactCustomInstructions?: string | null;
  permissionMode?: string;
  model?: string;
  errorDetails?: string;
  // Phase 3: New hook event fields
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
  // Phase 4: StatusLine session metrics
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
  // Drift monitoring
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

export interface PendingApprovalDTO {
  id: string;
  eventName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
  analysis?: AnalysisResult;
  riskLevel?: 'low' | 'medium' | 'high';
  isDriftBlock?: boolean;
}

export interface SessionStatus {
  connected: boolean;
  sessionId?: string;
  cwd?: string;
  pendingCount: number;
  eventCount: number;
  permissionMode?: string;
  uptime: number;
}

export type AnalysisProvider = 'anthropic' | 'openai' | 'openai-compatible' | 'litellm';

export const PROVIDER_LABELS: Record<AnalysisProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI Compatible',
  litellm: 'LiteLLM',
};

export interface LaymanConfig {
  port: number;
  host: string;
  autoAnalyze: 'all' | 'medium' | 'high' | 'none';
  autoAnalyzeDepth: 'quick' | 'detailed';
  autoExplain: 'all' | 'medium' | 'high' | 'none';
  autoExplainDepth: 'quick' | 'detailed';
  analysis: {
    provider: AnalysisProvider;
    model: string;
    endpoint?: string;
    apiKey?: string;
    maxTokens: number;
    temperature: number;
  };
  autoAllow: {
    readOnly: boolean;
    safeEdits: boolean;
    trustedCommands: string[];
  };
  hookTimeout: number;
  theme: 'dark' | 'light' | 'system';
  open: boolean;
  autoApprove: 'all' | 'medium' | 'low' | 'none';
  laymansPrompt: string;
  sessionRecording: boolean;
  recordingRecovery: boolean;
  piiFilter: boolean;
  showFullCommand: boolean;
  switchToNewestSession: boolean;
  collapseHistory: boolean;
  autoScroll: boolean;
  idleThresholdMinutes: number;
  autoActivateClients: string[];
  driftMonitoring: DriftMonitoringConfig;
  setupWizardComplete: boolean;
}

// Drift monitoring types
export type DriftLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface DriftThresholds {
  green: number;
  yellow: number;
  orange: number;
}

export interface DriftMonitoringConfig {
  enabled: boolean;
  checkIntervalToolCalls: number;
  checkIntervalMinutes: number;
  sessionDriftThresholds: DriftThresholds;
  rulesDriftThresholds: DriftThresholds;
  blockOnRed: boolean;
  remindOnOrange: boolean;
}

export interface DismissedDriftItems {
  indicators: string[];
  patternBreaks: string[];
  phantomReferences: string[];
  violations: string[];
}

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

export interface BookmarkFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
}

export interface Bookmark {
  id: string;
  folderId: string | null;
  sessionId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
}

export interface RecordedSession {
  sessionId: string;
  cwd: string;
  agentType: string;
  startedAt: number;
  lastSeen: number;
  sessionModel?: string;
  sessionModelDisplayName?: string;
  sessionName?: string;
}

export interface QAEntry {
  id: number;
  eventId: string;
  sessionId: string;
  question: string;
  answer: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface OptionalClientStatus {
  id: string;
  name: string;
  detected: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
  hooksInstalled?: boolean;
  hooksUpToDate?: boolean;
  declined?: boolean;
}

export interface SetupStatus {
  hooksInstalled: boolean;
  hooksUpToDate: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
  statusLineInstalled: boolean;
  statusLineUpToDate: boolean;
  claudeCodeDeclined?: boolean;
  optionalClients: OptionalClientStatus[];
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

export interface SessionTimeMetrics {
  wallClockMs: number;
  agentActiveMs: number;
  userActiveMs: number;
  idleMs: number;
  idleThresholdMinutes: number;
}

export interface SessionMetrics {
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
  timestamp: number;
}

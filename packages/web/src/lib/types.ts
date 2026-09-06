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
  /**
   * Display-only. The server never sends this and it is never recorded: the
   * Logs list derives it from an `agent_response` that carries reasoning, so
   * thinking reads as its own row rather than as a block nested inside the
   * answer. Deriving it on the client rather than emitting a real event means
   * it applies retroactively to every already-recorded session, including
   * Claude Code's, whose reasoning is parsed out of the response text.
   */
  | 'agent_thinking'
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
  | 'drift_alert'
  | 'web_search';

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

export interface SubagentTranscriptEntry {
  /** 'assistant' for model text/tool calls, 'tool' for completed tool calls */
  role: 'assistant' | 'tool';
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  timestamp?: number;
}

export interface EventData {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  error?: string;
  prompt?: string;
  thinking?: string;
  agentType?: string;
  /** ID of the sub-agent that triggered this tool call event (retroactively tagged). */
  subagentId?: string;
  /** Ordered tool calls + text responses from the sub-agent's sidechain transcript. */
  subagentTranscript?: SubagentTranscriptEntry[];
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
  /** Harness reasoning effort. pi only — see the server's EventData.thinkingLevel. */
  thinkingLevel?: string;
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
  webSearchQueries?: string[];
  webSearchSources?: WebSearchSource[];
}

export interface WebSearchSource {
  url: string;
  hostname: string;
  title: string;
  content?: string;
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
  sessionId: string;
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

/**
 * Mirror of TtsConfigSchema in packages/server/src/config/schema.ts.
 *
 * `speed` and `playbackRate` are both here on purpose: speaches has no pitch
 * parameter, so `speed` changes tempo upstream with pitch preserved, while
 * `playbackRate` (with `preservePitch` off) pitch-shifts in the browser.
 */
export interface TtsConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  direct: boolean;
  model: string;
  voice: string;
  speed: number;
  playbackRate: number;
  preservePitch: boolean;
  autoSpeak: 'none' | 'final' | 'all';
  speakLaymans: boolean;
  codeBlocks: 'skip' | 'announce';
  maxChars: number;
}

/** Multi-host sync config. Mirrors SyncConfigSchema on the server. */
export interface SyncConfig {
  role: 'standalone' | 'central' | 'remote';
  /** Stable origin id, minted server-side; never edited by the UI. */
  hostId: string;
  hostName: string;
  centralUrl: string;
  token: string;
  intervalSeconds: number;
  mirror: boolean;
  mirrorIntervalSeconds: number;
  logRetentionDays: number;
}

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
  historyImport: boolean;
  piiFilter: boolean;
  showFullCommand: boolean;
  switchToNewestSession: boolean;
  collapseHistory: boolean;
  autoScroll: boolean;
  idleThresholdMinutes: number;
  autoActivateClients: string[];
  /**
   * Client agent types allowed to have their tool calls suspended for approval.
   * Only consulted for harnesses where blocking is opt-in (pi). Mirrors the
   * server schema — see CLAUDE.md "Type duplication".
   */
  approvalClients: string[];
  /** Live token streaming. Mirrors LiveTokensConfigSchema on the server. */
  liveTokens: { enabled: boolean; showThinking: boolean };
  /** Passive monitoring of glove-sandboxed harnesses. Mirrors GloveConfigSchema. */
  glove: { enabled: boolean; sessionsDir: string };
  /** Multi-host sync. Mirrors SyncConfigSchema on the server. */
  sync: SyncConfig;
  driftMonitoring: DriftMonitoringConfig;
  tts: TtsConfig;
  setupWizardComplete: boolean;
  openWebUiUrl: string;
  openWebUiApiKey: string;
  /** Base URL for generated links; empty falls back to window.location.origin. */
  publicUrl: string;
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

export interface HighlightFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  /** Origin host (multi-host sync); editable only on its origin. */
  hostId?: string;
}

export interface Highlight {
  id: string;
  folderId: string | null;
  sessionId: string;
  promptEventId: string;
  responseEventId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  hostId?: string;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  hostId?: string;
}

export interface Bookmark {
  id: string;
  folderId: string | null;
  sessionId: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  hostId?: string;
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
  source?: string;
  eventCount?: number;
  /** Origin host id (multi-host sync). Local host until enrolment. */
  hostId?: string;
  /** Display name of the origin host. */
  hostName?: string;
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
  /** Sessions recorded from this harness in the DB (preserved even if uninstalled). */
  recordedSessionCount?: number;
}

export interface SetupStatus {
  hooksInstalled: boolean;
  hooksUpToDate: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
  statusLineInstalled: boolean;
  statusLineUpToDate: boolean;
  claudeCodeDeclined?: boolean;
  /** Recorded-session count for Claude Code (not an optional client). */
  claudeCodeRecordedSessions?: number;
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
  /** Harness reasoning effort. pi only — see EventData.thinkingLevel. */
  thinkingLevel?: string;
  timestamp: number;
}

// ─── Live token streaming ─────────────────────────────────────────────────────
// Mirrors packages/server/src/stream/live.ts — see CLAUDE.md "Type duplication".

/**
 * Partial assistant output for a session, as it is generated. Lives in a
 * dedicated store rather than the event stream: at a local model's generation
 * speed these arrive thousands of times per turn.
 */
export interface LiveStream {
  sessionId: string;
  agentType: string;
  messageId: string;
  phase: 'thinking' | 'text' | 'idle';
  thinking: string;
  text: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** `tokens.output` is derived from the accumulated text, so render it as `~n`. */
  tokensEstimated?: boolean;
  model?: string;
  startedAt: number;
  updatedAt: number;
}

// ─── Turns ────────────────────────────────────────────────────────────────────
// Mirrors packages/server/src/turns/types.ts — see CLAUDE.md "Type duplication".

/** Minimal addressable reference to a turn. */
export interface TurnRef {
  sessionId: string;
  promptEventId: string;
  /** null when the turn produced no agent_response (still in flight, or aborted). */
  responseEventId: string | null;
}

/**
 * One user prompt plus everything the agent did in response to it, up to (but
 * not including) the next user prompt.
 */
export interface Turn extends TurnRef {
  index: number;
  promptText: string;
  responseText: string;
  thinkingText: string | null;
  startedAt: number;
  endedAt: number | null;
  eventIds: string[];
  toolCallCount: number;
  riskLevels: Record<string, number>;
  agentType: string;
}

/** What `GET /api/resolve?id=` returns — mirrors ResolvedId in turns/store.ts. */
export interface ResolvedId {
  kind: 'session' | 'event' | 'highlight' | 'bookmark' | 'folder' | 'highlight_folder';
  id: string;
  /** Present for events, bookmarks and highlights. */
  sessionId?: string;
  /** Present for highlights — the turn they name. */
  promptEventId?: string;
  /** Origin host for sessions, bookmarks and highlights (multi-host sync). */
  hostId?: string;
}

/** Mirrors PullStatus in server sync/protocol.ts. */
export interface PullStatus {
  enabled: boolean;
  state: 'idle' | 'snapshot' | 'incremental' | 'backoff' | 'error' | 'paused';
  pullAckedSeq: number | null;
  snapshotKind: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
}

/** Mirrors SyncStatus in server sync/protocol.ts. */
export interface SyncStatus {
  role: 'standalone' | 'central' | 'remote';
  hostId: string;
  hostName: string;
  state: 'idle' | 'syncing' | 'backfill' | 'backoff' | 'error' | 'paused';
  backlog: number;
  pushAckedSeq: number | null;
  backfillKind: string | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  /** Mirror pull status when role === 'remote' && mirror. */
  pull?: PullStatus;
}

/** Mirrors HostStats in server sync/protocol.ts. */
export interface HostStats {
  hostId: string;
  name: string;
  kind: string;
  platform: string | null;
  laymanVersion: string | null;
  firstSeen: number;
  lastSeen: number;
  sessionCount: number;
  eventCount: number;
  contentBytes: number;
  firstActivity: number | null;
  lastActivity: number | null;
}

/** Mirrors PeerDTO in server sync/protocol.ts. */
export interface PeerDTO {
  tokenHash: string;
  name: string;
  hostId: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastPushSeq: number | null;
  lastPullSeq: number | null;
  intervalSeconds: number | null;
  revokedAt: number | null;
  lastError: string | null;
}

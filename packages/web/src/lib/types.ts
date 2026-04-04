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
  | 'analysis_result';

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
  autoAnalyze: 'all' | 'risky' | 'none';
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
  autoApprove: boolean;
  laymansPrompt: string;
  sessionRecording: boolean;
  recordingRecovery: boolean;
  piiFilter: boolean;
  showFullCommand: boolean;
  switchToNewestSession: boolean;
  collapseHistory: boolean;
  autoScroll: boolean;
  idleThresholdMinutes: number;
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

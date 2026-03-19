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

export interface ApprovalDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
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
  approvalId?: string;
  decision?: ApprovalDecision;
  completedAt?: number;
}

export interface TimelineEvent {
  id: string;
  type: EventType;
  timestamp: number;
  sessionId: string;
  agentType: string;
  data: EventData;
  analysis?: AnalysisResult;
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

export interface LaymanConfig {
  port: number;
  host: string;
  autoAnalyze: 'all' | 'risky' | 'none';
  analysis: {
    provider: 'anthropic' | 'openai-compatible';
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
  settingsPath?: string;
  global: boolean;
}

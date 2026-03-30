import type { ApprovalDecision } from '../hooks/types.js';
import type { AnalysisResult, LaymansResult } from '../analysis/types.js';

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

export interface EventSummary {
  type: string;
  summary: string;
}

import type { ApprovalDecision } from '../hooks/types.js';
import type { AnalysisResult } from '../analysis/types.js';

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
}

export interface TimelineEvent {
  id: string;
  type: EventType;
  timestamp: number;
  sessionId: string;
  data: EventData;
  analysis?: AnalysisResult;
  riskLevel?: 'low' | 'medium' | 'high';
}

export interface EventSummary {
  type: string;
  summary: string;
}

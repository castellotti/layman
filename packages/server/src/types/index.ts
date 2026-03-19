// Re-exports of shared types
export type { TimelineEvent, EventType, EventData, EventSummary } from '../events/types.js';
export type { SessionInfo } from '../events/store.js';
export type { AnalysisResult, AnalysisRequest, AnalysisConfig, LaymansResult } from '../analysis/types.js';
export type {
  HookInputBase,
  PreToolUseInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  PermissionRequestInput,
  NotificationInput,
  SessionStartInput,
  SessionEndInput,
  StopInput,
  UserPromptSubmitInput,
  SubagentStartInput,
  SubagentStopInput,
  ApprovalDecision,
} from '../hooks/types.js';
export type { PendingApproval, PendingApprovalDTO } from '../hooks/pending.js';
export type { LaymanConfig } from '../config/schema.js';

// WebSocket protocol types
import type { TimelineEvent } from '../events/types.js';
import type { AnalysisResult } from '../analysis/types.js';
import type { PendingApprovalDTO } from '../hooks/pending.js';
import type { ApprovalDecision } from '../hooks/types.js';
import type { LaymanConfig } from '../config/schema.js';
import type { LaymansResult } from '../analysis/types.js';
import type { SessionInfo } from '../events/store.js';

export interface SessionStatus {
  connected: boolean;
  sessionId?: string;
  cwd?: string;
  pendingCount: number;
  eventCount: number;
  permissionMode?: string;
  uptime: number;
}

export type ServerMessage =
  | { type: 'event:new'; event: TimelineEvent }
  | { type: 'event:update'; eventId: string; updates: Partial<TimelineEvent> }
  | { type: 'approval:pending'; approval: PendingApprovalDTO }
  | { type: 'approval:resolved'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:start'; eventId: string }
  | { type: 'analysis:result'; eventId: string; result: AnalysisResult }
  | { type: 'analysis:error'; eventId: string; error: string }
  | { type: 'laymans:start'; eventId: string }
  | { type: 'laymans:result'; eventId: string; result: LaymansResult }
  | { type: 'laymans:error'; eventId: string; error: string }
  | { type: 'session:status'; status: SessionStatus }
  | { type: 'session:config'; config: LaymanConfig }
  | { type: 'sessions:list'; sessions: SessionInfo[] }
  | { type: 'connected'; serverVersion: string; eventCount: number };

export type ClientMessage =
  | { type: 'approval:decide'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'laymans:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'both:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'analysis:ask'; eventId: string; question: string }
  | { type: 'config:update'; config: Partial<LaymanConfig> };

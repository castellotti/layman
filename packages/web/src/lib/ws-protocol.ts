import type {
  TimelineEvent,
  AnalysisResult,
  PendingApprovalDTO,
  ApprovalDecision,
  LaymanConfig,
  SessionStatus,
} from './types.js';

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  lastSeen: number;
}

export type ServerMessage =
  | { type: 'event:new'; event: TimelineEvent }
  | { type: 'event:update'; eventId: string; updates: Partial<TimelineEvent> }
  | { type: 'approval:pending'; approval: PendingApprovalDTO }
  | { type: 'approval:resolved'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:start'; eventId: string }
  | { type: 'analysis:result'; eventId: string; result: AnalysisResult }
  | { type: 'analysis:error'; eventId: string; error: string }
  | { type: 'session:status'; status: SessionStatus }
  | { type: 'session:config'; config: LaymanConfig }
  | { type: 'sessions:list'; sessions: SessionInfo[] }
  | { type: 'connected'; serverVersion: string; eventCount: number };

export type ClientMessage =
  | { type: 'approval:decide'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'analysis:ask'; eventId: string; question: string }
  | { type: 'config:update'; config: Partial<LaymanConfig> };

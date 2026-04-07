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
export type { BookmarkFolder, Bookmark, RecordedSession, QAEntry } from '../db/types.js';
export type { SessionTimeMetrics } from '../db/time-metrics.js';
export type { DriftLevel, DriftState, DriftThresholds, DriftCheckResult, DriftPreToolUseResult } from '../drift/types.js';

// WebSocket protocol types
import type { TimelineEvent } from '../events/types.js';
import type { AnalysisResult } from '../analysis/types.js';
import type { PendingApprovalDTO } from '../hooks/pending.js';
import type { ApprovalDecision } from '../hooks/types.js';
import type { LaymanConfig } from '../config/schema.js';
import type { LaymansResult } from '../analysis/types.js';
import type { SessionInfo } from '../events/store.js';
import type { BookmarkFolder, Bookmark } from '../db/types.js';
import type { DriftState } from '../drift/types.js';

export interface SessionStatus {
  connected: boolean;
  sessionId?: string;
  cwd?: string;
  pendingCount: number;
  eventCount: number;
  permissionMode?: string;
  uptime: number;
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
  | { type: 'session:activated'; sessionId: string }
  | { type: 'session:deactivated'; sessionId: string }
  | { type: 'connected'; serverVersion: string; eventCount: number }
  | { type: 'bookmarks:state'; folders: BookmarkFolder[]; bookmarks: Bookmark[] }
  | { type: 'bookmarks:folder:created'; folder: BookmarkFolder }
  | { type: 'bookmarks:folder:updated'; folder: BookmarkFolder }
  | { type: 'bookmarks:folder:deleted'; folderId: string }
  | { type: 'bookmarks:created'; bookmark: Bookmark }
  | { type: 'bookmarks:updated'; bookmark: Bookmark }
  | { type: 'bookmarks:deleted'; bookmarkId: string }
  | { type: 'drift:update'; sessionId: string; state: DriftState };

export type ClientMessage =
  | { type: 'approval:decide'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'laymans:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'both:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'analysis:ask'; eventId: string; question: string }
  | { type: 'config:update'; config: Partial<LaymanConfig> }
  | { type: 'setup:install'; clients?: string[] }
  | { type: 'bookmarks:get' }
  | { type: 'drift:reset'; sessionId: string }
  | { type: 'drift:dismiss'; sessionId: string; approvalId: string }
  | { type: 'drift:dismiss-item'; sessionId: string; category: 'indicator' | 'patternBreak' | 'phantomReference' | 'violation'; value: string };

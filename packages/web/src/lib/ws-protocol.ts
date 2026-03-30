import type {
  TimelineEvent,
  AnalysisResult,
  LaymansResult,
  PendingApprovalDTO,
  ApprovalDecision,
  LaymanConfig,
  SessionStatus,
  BookmarkFolder,
  Bookmark,
} from './types.js';

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  lastSeen: number;
  agentType: string;
  active?: boolean;
  opencodeUrl?: string;
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
  | { type: 'bookmarks:deleted'; bookmarkId: string };

export type ClientMessage =
  | { type: 'approval:decide'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'laymans:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'both:request'; eventId: string; depth: 'quick' | 'detailed' }
  | { type: 'analysis:ask'; eventId: string; question: string }
  | { type: 'config:update'; config: Partial<LaymanConfig> }
  | { type: 'setup:install'; clients?: string[] }
  | { type: 'bookmarks:get' };

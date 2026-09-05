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
  HighlightFolder,
  Highlight,
  DriftState,
  LiveStream,
  SyncStatus,
  HostStats,
} from './types.js';

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  lastSeen: number;
  agentType: string;
  active?: boolean;
  opencodeUrl?: string;
  sessionName?: string;
  /** Origin host (multi-host sync). Absent/local for own sessions. */
  hostId?: string;
  hostName?: string;
  /** True for a session surfaced from a remote via central's presence registry. */
  remote?: boolean;
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
  | { type: 'highlights:state'; folders: HighlightFolder[]; highlights: Highlight[] }
  | { type: 'highlights:folder:created'; folder: HighlightFolder }
  | { type: 'highlights:folder:updated'; folder: HighlightFolder }
  | { type: 'highlights:folder:deleted'; folderId: string }
  | { type: 'highlights:created'; highlight: Highlight }
  | { type: 'highlights:updated'; highlight: Highlight }
  | { type: 'highlights:deleted'; highlightId: string }
  | { type: 'drift:update'; sessionId: string; state: DriftState }
  | { type: 'stream:update'; sessionId: string; stream: LiveStream }
  | { type: 'stream:end'; sessionId: string }
  | { type: 'sync:status'; status: SyncStatus }
  | { type: 'sync:hosts'; hosts: HostStats[] };

export type ClientMessage =
  | { type: 'approval:decide'; approvalId: string; decision: ApprovalDecision }
  | { type: 'analysis:request'; eventId: string; depth: 'quick' | 'detailed'; model?: string }
  | { type: 'laymans:request'; eventId: string; depth: 'quick' | 'detailed'; model?: string }
  | { type: 'both:request'; eventId: string; depth: 'quick' | 'detailed'; model?: string }
  | { type: 'analysis:ask'; eventId: string; question: string }
  | { type: 'config:update'; config: Partial<LaymanConfig> }
  | { type: 'setup:install'; clients?: string[] }
  | { type: 'bookmarks:get' }
  | { type: 'drift:reset'; sessionId: string }
  | { type: 'drift:dismiss'; sessionId: string; approvalId: string }
  | { type: 'drift:dismiss-item'; sessionId: string; category: 'indicator' | 'patternBreak' | 'phantomReference' | 'violation'; value: string };

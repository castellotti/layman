export interface BookmarkFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
  /** Origin host id (multi-host sync). Curation is editable only on its origin. */
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
  /** Origin host id (see multi-host sync). Local host until enrolment. */
  hostId?: string;
  /** Display name of the origin host, joined from `sync_hosts`. */
  hostName?: string;
}

export interface HighlightFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: number;
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

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
  sessionModel?: string;
  sessionModelDisplayName?: string;
  sessionName?: string;
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

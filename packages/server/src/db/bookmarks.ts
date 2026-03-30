import { randomUUID } from 'crypto';
import type { Database } from './database.js';
import type { BookmarkFolder, Bookmark, RecordedSession, QAEntry } from './types.js';
import type { TimelineEvent } from '../events/types.js';

interface RawFolder {
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

interface RawBookmark {
  id: string;
  folder_id: string | null;
  session_id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

interface RawSession {
  session_id: string;
  cwd: string;
  agent_type: string;
  started_at: number;
  last_seen: number;
}

interface RawEvent {
  id: string;
  session_id: string;
  type: string;
  timestamp: number;
  agent_type: string;
  data_json: string;
  analysis_json: string | null;
  laymans_json: string | null;
  risk_level: string | null;
}

interface RawQA {
  id: number;
  event_id: string;
  session_id: string;
  question: string;
  answer: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  created_at: number;
}

function toFolder(row: RawFolder): BookmarkFolder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function toBookmark(row: RawBookmark): Bookmark {
  return {
    id: row.id,
    folderId: row.folder_id,
    sessionId: row.session_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function toSession(row: RawSession): RecordedSession {
  return {
    sessionId: row.session_id,
    cwd: row.cwd,
    agentType: row.agent_type,
    startedAt: row.started_at,
    lastSeen: row.last_seen,
  };
}

function toEvent(row: RawEvent): TimelineEvent {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type as TimelineEvent['type'],
    timestamp: row.timestamp,
    agentType: row.agent_type,
    data: JSON.parse(row.data_json) as TimelineEvent['data'],
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) : undefined,
    laymans: row.laymans_json ? JSON.parse(row.laymans_json) : undefined,
    riskLevel: (row.risk_level as TimelineEvent['riskLevel']) ?? undefined,
  };
}

function toQA(row: RawQA): QAEntry {
  return {
    id: row.id,
    eventId: row.event_id,
    sessionId: row.session_id,
    question: row.question,
    answer: row.answer,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

export class BookmarkStore {
  constructor(private db: Database) {}

  // ── Folders ────────────────────────────────────────────────────────────────

  listFolders(): BookmarkFolder[] {
    const rows = this.db.prepare('SELECT * FROM bookmark_folders ORDER BY sort_order ASC').all() as RawFolder[];
    return rows.map(toFolder);
  }

  createFolder(name: string): BookmarkFolder {
    const id = randomUUID();
    const now = Date.now();
    const maxOrder = (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM bookmark_folders').get() as { m: number }).m;
    this.db.prepare('INSERT INTO bookmark_folders (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)').run(id, name, maxOrder + 1, now);
    return toFolder({ id, name, sort_order: maxOrder + 1, created_at: now });
  }

  renameFolder(id: string, name: string): BookmarkFolder | null {
    this.db.prepare('UPDATE bookmark_folders SET name = ? WHERE id = ?').run(name, id);
    const row = this.db.prepare('SELECT * FROM bookmark_folders WHERE id = ?').get(id) as RawFolder | undefined;
    return row ? toFolder(row) : null;
  }

  deleteFolder(id: string): void {
    // Bookmarks' folder_id will be set to NULL via ON DELETE SET NULL
    this.db.prepare('DELETE FROM bookmark_folders WHERE id = ?').run(id);
  }

  reorderFolders(ids: string[]): void {
    const update = this.db.prepare('UPDATE bookmark_folders SET sort_order = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    });
    tx();
  }

  // ── Bookmarks ──────────────────────────────────────────────────────────────

  listAllBookmarks(): Bookmark[] {
    const rows = this.db.prepare('SELECT * FROM bookmarks ORDER BY folder_id, sort_order ASC').all() as RawBookmark[];
    return rows.map(toBookmark);
  }

  createBookmark(sessionId: string, name: string, folderId?: string | null): Bookmark {
    const id = randomUUID();
    const now = Date.now();
    const effectiveFolderId = folderId ?? null;
    const maxOrder = (this.db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) as m FROM bookmarks WHERE folder_id IS ?'
    ).get(effectiveFolderId) as { m: number }).m;
    this.db.prepare(
      'INSERT INTO bookmarks (id, folder_id, session_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, effectiveFolderId, sessionId, name, maxOrder + 1, now);
    return toBookmark({ id, folder_id: effectiveFolderId, session_id: sessionId, name, sort_order: maxOrder + 1, created_at: now });
  }

  renameBookmark(id: string, name: string): Bookmark | null {
    this.db.prepare('UPDATE bookmarks SET name = ? WHERE id = ?').run(name, id);
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as RawBookmark | undefined;
    return row ? toBookmark(row) : null;
  }

  moveBookmark(id: string, folderId: string | null, sortOrder?: number): Bookmark | null {
    if (sortOrder !== undefined) {
      this.db.prepare('UPDATE bookmarks SET folder_id = ?, sort_order = ? WHERE id = ?').run(folderId, sortOrder, id);
    } else {
      const maxOrder = (this.db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) as m FROM bookmarks WHERE folder_id IS ?'
      ).get(folderId) as { m: number }).m;
      this.db.prepare('UPDATE bookmarks SET folder_id = ?, sort_order = ? WHERE id = ?').run(folderId, maxOrder + 1, id);
    }
    const row = this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id) as RawBookmark | undefined;
    return row ? toBookmark(row) : null;
  }

  deleteBookmark(id: string): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }

  reorderBookmarks(folderId: string | null, ids: string[]): void {
    const update = this.db.prepare('UPDATE bookmarks SET sort_order = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    });
    tx();
  }

  // ── Recorded Sessions ──────────────────────────────────────────────────────

  listRecordedSessions(): RecordedSession[] {
    const rows = this.db.prepare('SELECT * FROM recorded_sessions ORDER BY last_seen DESC').all() as RawSession[];
    return rows.map(toSession);
  }

  getRecordedSession(sessionId: string): RecordedSession | null {
    const row = this.db.prepare('SELECT * FROM recorded_sessions WHERE session_id = ?').get(sessionId) as RawSession | undefined;
    return row ? toSession(row) : null;
  }

  getEventsForSession(sessionId: string): TimelineEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM recorded_events WHERE session_id = ? ORDER BY timestamp ASC'
    ).all(sessionId) as RawEvent[];
    return rows.map(toEvent);
  }

  getEventById(eventId: string): TimelineEvent | null {
    const row = this.db.prepare(
      'SELECT * FROM recorded_events WHERE id = ?'
    ).get(eventId) as RawEvent | undefined;
    return row ? toEvent(row) : null;
  }

  getQAForSession(sessionId: string): QAEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM recorded_qa WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as RawQA[];
    return rows.map(toQA);
  }

  getQAForEvent(eventId: string): QAEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM recorded_qa WHERE event_id = ? ORDER BY created_at ASC'
    ).all(eventId) as RawQA[];
    return rows.map(toQA);
  }

  deleteSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM recorded_qa WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM recorded_events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM recorded_sessions WHERE session_id = ?').run(sessionId);
    });
    tx();
  }
}

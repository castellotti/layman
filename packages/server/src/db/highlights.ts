import { randomUUID } from 'crypto';
import type { Database } from './database.js';
import type { HighlightFolder, Highlight } from './types.js';

interface RawFolder {
  id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

interface RawHighlight {
  id: string;
  folder_id: string | null;
  session_id: string;
  prompt_event_id: string;
  response_event_id: string;
  name: string;
  sort_order: number;
  created_at: number;
}

function toFolder(row: RawFolder): HighlightFolder {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function toHighlight(row: RawHighlight): Highlight {
  return {
    id: row.id,
    folderId: row.folder_id,
    sessionId: row.session_id,
    promptEventId: row.prompt_event_id,
    responseEventId: row.response_event_id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export class HighlightStore {
  constructor(private db: Database) {}

  private nextFolderOrder(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM highlight_folders').get() as { m: number }).m + 1;
  }

  private nextHighlightOrder(folderId: string | null): number {
    return (this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM highlights WHERE folder_id IS ?').get(folderId) as { m: number }).m + 1;
  }

  // ── Folders ────────────────────────────────────────────────────────────────

  listFolders(): HighlightFolder[] {
    const rows = this.db.prepare('SELECT * FROM highlight_folders ORDER BY sort_order ASC').all() as RawFolder[];
    return rows.map(toFolder);
  }

  createFolder(name: string): HighlightFolder {
    const id = randomUUID();
    const now = Date.now();
    const sortOrder = this.nextFolderOrder();
    this.db.prepare('INSERT INTO highlight_folders (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)').run(id, name, sortOrder, now);
    return toFolder({ id, name, sort_order: sortOrder, created_at: now });
  }

  renameFolder(id: string, name: string): HighlightFolder | null {
    this.db.prepare('UPDATE highlight_folders SET name = ? WHERE id = ?').run(name, id);
    const row = this.db.prepare('SELECT * FROM highlight_folders WHERE id = ?').get(id) as RawFolder | undefined;
    return row ? toFolder(row) : null;
  }

  deleteFolder(id: string): void {
    this.db.prepare('DELETE FROM highlight_folders WHERE id = ?').run(id);
  }

  reorderFolders(ids: string[]): void {
    const update = this.db.prepare('UPDATE highlight_folders SET sort_order = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    });
    tx();
  }

  // ── Highlights ─────────────────────────────────────────────────────────────

  listAll(): { folders: HighlightFolder[]; highlights: Highlight[] } {
    return { folders: this.listFolders(), highlights: this.listAllHighlights() };
  }

  listAllHighlights(): Highlight[] {
    const rows = this.db.prepare('SELECT * FROM highlights ORDER BY folder_id, sort_order ASC').all() as RawHighlight[];
    return rows.map(toHighlight);
  }

  getHighlight(id: string): Highlight | null {
    const row = this.db.prepare('SELECT * FROM highlights WHERE id = ?').get(id) as RawHighlight | undefined;
    return row ? toHighlight(row) : null;
  }

  createHighlight(sessionId: string, promptEventId: string, responseEventId: string, name: string, folderId?: string | null): Highlight {
    const id = randomUUID();
    const now = Date.now();
    const effectiveFolderId = folderId ?? null;
    const sortOrder = this.nextHighlightOrder(effectiveFolderId);
    this.db.prepare(
      'INSERT INTO highlights (id, folder_id, session_id, prompt_event_id, response_event_id, name, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, effectiveFolderId, sessionId, promptEventId, responseEventId, name, sortOrder, now);
    return toHighlight({ id, folder_id: effectiveFolderId, session_id: sessionId, prompt_event_id: promptEventId, response_event_id: responseEventId, name, sort_order: sortOrder, created_at: now });
  }

  updateHighlight(id: string, fields: { name?: string; folderId?: string | null; sortOrder?: number }): Highlight | null {
    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    if (fields.name !== undefined) {
      setClauses.push('name = ?');
      params.push(fields.name);
    }
    if (fields.folderId !== undefined) {
      setClauses.push('folder_id = ?');
      params.push(fields.folderId);
    }
    const effectiveSortOrder = fields.sortOrder ?? (fields.folderId !== undefined
      ? this.nextHighlightOrder(fields.folderId)
      : undefined);
    if (effectiveSortOrder !== undefined) {
      setClauses.push('sort_order = ?');
      params.push(effectiveSortOrder);
    }
    if (setClauses.length === 0) return null;
    params.push(id);
    this.db.prepare(`UPDATE highlights SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    const row = this.db.prepare('SELECT * FROM highlights WHERE id = ?').get(id) as RawHighlight | undefined;
    return row ? toHighlight(row) : null;
  }

  deleteHighlight(id: string): void {
    this.db.prepare('DELETE FROM highlights WHERE id = ?').run(id);
  }

  reorderHighlights(folderId: string | null, ids: string[]): void {
    const update = this.db.prepare('UPDATE highlights SET sort_order = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      ids.forEach((id, idx) => update.run(idx, id));
    });
    tx();
  }
}

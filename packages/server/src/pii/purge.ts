import type { Database } from '../db/database.js';
import { countPiiMatches, redactString, redactValue, filterPii } from './filter.js';
import type { EventData } from '../events/types.js';

export interface PiiScanCategory {
  name: string;
  key: string;
  count: number;
}

export interface PiiScanResult {
  categories: PiiScanCategory[];
  total: number;
}

export interface PiiPurgeResult {
  redacted: number;
}

function hasPii(input: string): boolean {
  return countPiiMatches(input) > 0;
}

/**
 * Scan all SQLite tables for PII and return counts per data category.
 */
export function scanPii(db: Database): PiiScanResult {
  const categories: PiiScanCategory[] = [];

  // 1. Session history — recorded_sessions.cwd
  {
    const rows = db.prepare('SELECT cwd FROM recorded_sessions').all() as { cwd: string }[];
    let count = 0;
    for (const row of rows) {
      if (row.cwd && hasPii(row.cwd)) count++;
    }
    categories.push({ name: 'Session history', key: 'sessions', count });
  }

  // 2. User prompts — recorded_events.data_json where $.prompt is set
  {
    const rows = db.prepare(
      `SELECT json_extract(data_json, '$.prompt') as prompt FROM recorded_events WHERE json_extract(data_json, '$.prompt') IS NOT NULL`,
    ).all() as { prompt: string }[];
    let count = 0;
    for (const row of rows) {
      if (hasPii(row.prompt)) count++;
    }
    categories.push({ name: 'User prompts', key: 'prompts', count });
  }

  // 3. Tool inputs/outputs — recorded_events.data_json where $.toolInput or $.toolOutput is set
  {
    const rows = db.prepare(
      `SELECT data_json FROM recorded_events WHERE json_extract(data_json, '$.toolInput') IS NOT NULL OR json_extract(data_json, '$.toolOutput') IS NOT NULL`,
    ).all() as { data_json: string }[];
    let count = 0;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        const inputStr = data.toolInput ? JSON.stringify(data.toolInput) : '';
        const outputStr = data.toolOutput != null ? (typeof data.toolOutput === 'string' ? data.toolOutput : JSON.stringify(data.toolOutput)) : '';
        if ((inputStr && hasPii(inputStr)) || (outputStr && hasPii(outputStr))) count++;
      } catch {
        // skip malformed JSON
      }
    }
    categories.push({ name: 'Tool inputs/outputs', key: 'tools', count });
  }

  // 4. Analysis & explanations — analysis_json and laymans_json
  {
    const rows = db.prepare(
      'SELECT analysis_json, laymans_json FROM recorded_events WHERE analysis_json IS NOT NULL OR laymans_json IS NOT NULL',
    ).all() as { analysis_json: string | null; laymans_json: string | null }[];
    let count = 0;
    for (const row of rows) {
      if ((row.analysis_json && hasPii(row.analysis_json)) || (row.laymans_json && hasPii(row.laymans_json))) count++;
    }
    categories.push({ name: 'Analysis & explanations', key: 'analysis', count });
  }

  // 5. Chat transcripts — recorded_qa
  {
    const rows = db.prepare('SELECT question, answer FROM recorded_qa').all() as { question: string; answer: string }[];
    let count = 0;
    for (const row of rows) {
      if (hasPii(row.question) || hasPii(row.answer)) count++;
    }
    categories.push({ name: 'Chat transcripts', key: 'qa', count });
  }

  // 6. Access log — fileAccess[].path and urlAccess[].url inside data_json
  {
    const rows = db.prepare(
      `SELECT data_json FROM recorded_events WHERE json_extract(data_json, '$.fileAccess') IS NOT NULL OR json_extract(data_json, '$.urlAccess') IS NOT NULL`,
    ).all() as { data_json: string }[];
    let count = 0;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data_json) as Record<string, unknown>;
        const files = Array.isArray(data.fileAccess) ? data.fileAccess as { path?: string }[] : [];
        const urls = Array.isArray(data.urlAccess) ? data.urlAccess as { url?: string }[] : [];
        const hasFilePii = files.some(f => f.path && hasPii(f.path));
        const hasUrlPii = urls.some(u => u.url && hasPii(u.url));
        if (hasFilePii || hasUrlPii) count++;
      } catch {
        // skip malformed JSON
      }
    }
    categories.push({ name: 'Access log', key: 'access_log', count });
  }

  // 7. Bookmarks — bookmarks.name + bookmark_folders.name
  {
    const bookmarkRows = db.prepare('SELECT name FROM bookmarks').all() as { name: string }[];
    const folderRows = db.prepare('SELECT name FROM bookmark_folders').all() as { name: string }[];
    let count = 0;
    for (const row of [...bookmarkRows, ...folderRows]) {
      if (hasPii(row.name)) count++;
    }
    categories.push({ name: 'Bookmarks', key: 'bookmarks', count });
  }

  const total = categories.reduce((sum, c) => sum + c.count, 0);
  return { categories, total };
}

/**
 * Redact all PII in the database. Runs inside a single transaction.
 * Returns the count of individual fields that were modified.
 */
export function executePurge(db: Database): PiiPurgeResult {
  let redacted = 0;

  const updateSession = db.prepare('UPDATE recorded_sessions SET cwd = ? WHERE session_id = ?');
  const updateEvent = db.prepare('UPDATE recorded_events SET data_json = ?, analysis_json = ?, laymans_json = ? WHERE id = ?');
  const updateQA = db.prepare('UPDATE recorded_qa SET question = ?, answer = ? WHERE id = ?');
  const updateBookmark = db.prepare('UPDATE bookmarks SET name = ? WHERE id = ?');
  const updateFolder = db.prepare('UPDATE bookmark_folders SET name = ? WHERE id = ?');

  const tx = db.transaction(() => {
    // 1. Sessions
    {
      const rows = db.prepare('SELECT session_id, cwd FROM recorded_sessions').all() as { session_id: string; cwd: string }[];
      for (const row of rows) {
        if (!row.cwd) continue;
        const clean = redactString(row.cwd);
        if (clean !== row.cwd) {
          updateSession.run(clean, row.session_id);
          redacted++;
        }
      }
    }

    // 2. Events — data_json, analysis_json, laymans_json
    {
      const rows = db.prepare('SELECT id, data_json, analysis_json, laymans_json FROM recorded_events').all() as {
        id: string;
        data_json: string;
        analysis_json: string | null;
        laymans_json: string | null;
      }[];

      for (const row of rows) {
        let dataChanged = false;
        let analysisChanged = false;
        let laymansChanged = false;

        let newDataJson = row.data_json;
        let newAnalysisJson = row.analysis_json;
        let newLaymansJson = row.laymans_json;

        // Redact data_json
        try {
          const data = JSON.parse(row.data_json) as EventData;
          const filtered = filterPii(data);
          const filteredJson = JSON.stringify(filtered);
          if (filteredJson !== row.data_json) {
            newDataJson = filteredJson;
            dataChanged = true;
          }
        } catch {
          // skip malformed JSON
        }

        // Redact analysis_json
        if (row.analysis_json) {
          try {
            const parsed = JSON.parse(row.analysis_json) as unknown;
            const filtered = redactValue(parsed);
            const filteredJson = JSON.stringify(filtered);
            if (filteredJson !== row.analysis_json) {
              newAnalysisJson = filteredJson;
              analysisChanged = true;
            }
          } catch {
            // skip malformed JSON
          }
        }

        // Redact laymans_json
        if (row.laymans_json) {
          try {
            const parsed = JSON.parse(row.laymans_json) as unknown;
            const filtered = redactValue(parsed);
            const filteredJson = JSON.stringify(filtered);
            if (filteredJson !== row.laymans_json) {
              newLaymansJson = filteredJson;
              laymansChanged = true;
            }
          } catch {
            // skip malformed JSON
          }
        }

        if (dataChanged || analysisChanged || laymansChanged) {
          updateEvent.run(newDataJson, newAnalysisJson, newLaymansJson, row.id);
          if (dataChanged) redacted++;
          if (analysisChanged) redacted++;
          if (laymansChanged) redacted++;
        }
      }
    }

    // 3. Q&A
    {
      const rows = db.prepare('SELECT id, question, answer FROM recorded_qa').all() as { id: number; question: string; answer: string }[];
      for (const row of rows) {
        const cleanQ = redactString(row.question);
        const cleanA = redactString(row.answer);
        const qChanged = cleanQ !== row.question;
        const aChanged = cleanA !== row.answer;
        if (qChanged || aChanged) {
          updateQA.run(cleanQ, cleanA, row.id);
          if (qChanged) redacted++;
          if (aChanged) redacted++;
        }
      }
    }

    // 4. Bookmarks
    {
      const rows = db.prepare('SELECT id, name FROM bookmarks').all() as { id: string; name: string }[];
      for (const row of rows) {
        const clean = redactString(row.name);
        if (clean !== row.name) {
          updateBookmark.run(clean, row.id);
          redacted++;
        }
      }
    }

    // 5. Bookmark folders
    {
      const rows = db.prepare('SELECT id, name FROM bookmark_folders').all() as { id: string; name: string }[];
      for (const row of rows) {
        const clean = redactString(row.name);
        if (clean !== row.name) {
          updateFolder.run(clean, row.id);
          redacted++;
        }
      }
    }
  });

  tx();
  return { redacted };
}

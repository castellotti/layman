import type { Database } from './database.js';
import type { TimelineEvent } from '../events/types.js';
import type { AnalysisResult, LaymansResult } from '../analysis/types.js';

// --- Query Parser ---

interface ParsedTerm {
  text: string;
  exclude: boolean;
}

export function parseSearchQuery(raw: string): ParsedTerm[] {
  const tokens = raw.match(/(?:[+-])?"[^"]*"|\S+/g);
  if (!tokens) return [];

  return tokens.map((token) => {
    let exclude = false;
    let text = token;

    if (text.startsWith('-')) {
      exclude = true;
      text = text.slice(1);
    } else if (text.startsWith('+')) {
      text = text.slice(1);
    }

    // Strip surrounding quotes
    if (text.startsWith('"') && text.endsWith('"')) {
      text = text.slice(1, -1);
    }

    return { text: text.toLowerCase(), exclude };
  }).filter((t) => t.text.length > 0);
}

// --- Search Types ---

export type SearchField =
  | 'dataPrompt'
  | 'dataToolName'
  | 'dataToolInput'
  | 'analysisMeaning'
  | 'laymansExplanation'
  | 'allText';

export interface SearchRequest {
  query: string;
  fields?: SearchField[];
  sessionIds?: string[];
  eventTypes?: string[];
  limit?: number;
  offset?: number;
}

export interface SearchSessionSummary {
  sessionId: string;
  cwd: string;
  agentType: string;
  startedAt: number;
  lastSeen: number;
  matchCount: number;
}

export interface SearchResultEvent extends TimelineEvent {
  matchedFields: string[];
}

export interface SearchResult {
  sessions: SearchSessionSummary[];
  events: SearchResultEvent[];
  totalMatches: number;
}

// --- Field Expressions ---

const FIELD_EXPRESSIONS: Record<Exclude<SearchField, 'allText'>, string> = {
  dataPrompt: "json_extract(data_json, '$.prompt')",
  dataToolName: "json_extract(data_json, '$.toolName')",
  dataToolInput: "CAST(json_extract(data_json, '$.toolInput') AS TEXT)",
  analysisMeaning: 'analysis_json',
  laymansExplanation: "json_extract(laymans_json, '$.explanation')",
};

function getFieldExpressions(fields: SearchField[]): { name: string; expr: string }[] {
  if (fields.includes('allText') || fields.length === 0) {
    return [
      { name: 'data_json', expr: 'data_json' },
      { name: 'analysis_json', expr: 'analysis_json' },
      { name: 'laymans_json', expr: 'laymans_json' },
    ];
  }

  return fields.map((f) => ({
    name: f,
    expr: FIELD_EXPRESSIONS[f as Exclude<SearchField, 'allText'>],
  }));
}

// --- Search Executor ---

export function searchEvents(db: Database, request: SearchRequest): SearchResult {
  const terms = parseSearchQuery(request.query);
  if (terms.length === 0) {
    return { sessions: [], events: [], totalMatches: 0 };
  }

  const limit = Math.min(Math.max(request.limit ?? 200, 1), 500);
  const offset = Math.max(request.offset ?? 0, 0);
  const fields = request.fields ?? ['dataPrompt', 'dataToolName', 'dataToolInput'];
  const fieldExprs = getFieldExpressions(fields);

  // Build WHERE clauses
  const conditions: string[] = [];
  const params: unknown[] = [];

  for (const term of terms) {
    const likePattern = `%${term.text}%`;
    const orClauses = fieldExprs.map((f) => `${f.expr} LIKE ?`).join(' OR ');

    if (term.exclude) {
      conditions.push(`NOT (${orClauses})`);
    } else {
      conditions.push(`(${orClauses})`);
    }

    for (let i = 0; i < fieldExprs.length; i++) {
      params.push(likePattern);
    }
  }

  // Session scoping
  if (request.sessionIds && request.sessionIds.length > 0) {
    const placeholders = request.sessionIds.map(() => '?').join(', ');
    conditions.push(`session_id IN (${placeholders})`);
    params.push(...request.sessionIds);
  }

  // Event type filtering
  if (request.eventTypes && request.eventTypes.length > 0) {
    const placeholders = request.eventTypes.map(() => '?').join(', ');
    conditions.push(`type IN (${placeholders})`);
    params.push(...request.eventTypes);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total matches
  const countSql = `SELECT COUNT(*) as total FROM recorded_events ${whereClause}`;
  const countRow = db.prepare(countSql).get(...params) as { total: number } | undefined;
  const totalMatches = countRow?.total ?? 0;

  if (totalMatches === 0) {
    return { sessions: [], events: [], totalMatches: 0 };
  }

  // Get session summaries
  const sessionSql = `
    SELECT
      e.session_id as sessionId,
      COALESCE(s.cwd, '') as cwd,
      COALESCE(s.agent_type, 'claude-code') as agentType,
      COALESCE(s.started_at, 0) as startedAt,
      COALESCE(s.last_seen, 0) as lastSeen,
      COUNT(*) as matchCount
    FROM recorded_events e
    LEFT JOIN recorded_sessions s ON e.session_id = s.session_id
    ${whereClause}
    GROUP BY e.session_id
    ORDER BY MAX(e.timestamp) DESC
  `;
  const sessions = db.prepare(sessionSql).all(...params) as SearchSessionSummary[];

  // Get matching events
  const eventsSql = `
    SELECT id, session_id, type, timestamp, agent_type, data_json, analysis_json, laymans_json, risk_level
    FROM recorded_events
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `;
  const eventParams = [...params, limit, offset];
  const rows = db.prepare(eventsSql).all(...eventParams) as Array<{
    id: string;
    session_id: string;
    type: string;
    timestamp: number;
    agent_type: string;
    data_json: string;
    analysis_json: string | null;
    laymans_json: string | null;
    risk_level: string | null;
  }>;

  // Convert rows to SearchResultEvent
  const events: SearchResultEvent[] = rows.map((row) => {
    const data = JSON.parse(row.data_json);
    const analysis: AnalysisResult | undefined = row.analysis_json
      ? JSON.parse(row.analysis_json)
      : undefined;
    const laymans: LaymansResult | undefined = row.laymans_json
      ? JSON.parse(row.laymans_json)
      : undefined;

    // Determine which fields matched
    const matchedFields: string[] = [];
    const lowerTerms = terms.filter((t) => !t.exclude).map((t) => t.text);

    for (const term of lowerTerms) {
      if (data.prompt && String(data.prompt).toLowerCase().includes(term)) {
        if (!matchedFields.includes('dataPrompt')) matchedFields.push('dataPrompt');
      }
      if (data.toolName && String(data.toolName).toLowerCase().includes(term)) {
        if (!matchedFields.includes('dataToolName')) matchedFields.push('dataToolName');
      }
      if (data.toolInput && JSON.stringify(data.toolInput).toLowerCase().includes(term)) {
        if (!matchedFields.includes('dataToolInput')) matchedFields.push('dataToolInput');
      }
      if (row.analysis_json && row.analysis_json.toLowerCase().includes(term)) {
        if (!matchedFields.includes('analysisMeaning')) matchedFields.push('analysisMeaning');
      }
      if (laymans?.explanation && laymans.explanation.toLowerCase().includes(term)) {
        if (!matchedFields.includes('laymansExplanation')) matchedFields.push('laymansExplanation');
      }
    }

    return {
      id: row.id,
      type: row.type as TimelineEvent['type'],
      timestamp: row.timestamp,
      sessionId: row.session_id,
      agentType: row.agent_type,
      data,
      analysis,
      laymans,
      riskLevel: row.risk_level as TimelineEvent['riskLevel'],
      matchedFields,
    };
  });

  return { sessions, events, totalMatches };
}

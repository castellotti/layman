import type BetterSqlite3 from 'better-sqlite3';
import type { Database } from './database.js';
import type { TimelineEvent } from '../events/types.js';
import type { EventStore } from '../events/store.js';

export interface QARecord {
  question: string;
  answer: string;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number | null;
}

export class SessionRecorder {
  private upsertSession: BetterSqlite3.Statement<unknown[]>;
  private insertEvent: BetterSqlite3.Statement<unknown[]>;
  private updateEvent: BetterSqlite3.Statement<unknown[]>;
  private updateSessionCwd: BetterSqlite3.Statement<unknown[]>;
  private insertQA: BetterSqlite3.Statement<unknown[]>;

  constructor(
    private db: Database,
    private getRecordingEnabled: () => boolean,
  ) {
    this.upsertSession = db.prepare(`
      INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen)
      VALUES (?, '', ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen
    `);

    this.insertEvent = db.prepare(`
      INSERT OR IGNORE INTO recorded_events
        (id, session_id, type, timestamp, agent_type, data_json, analysis_json, laymans_json, risk_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateEvent = db.prepare(`
      UPDATE recorded_events
      SET type = ?, analysis_json = ?, laymans_json = ?, risk_level = ?, data_json = ?
      WHERE id = ?
    `);

    this.updateSessionCwd = db.prepare(`
      UPDATE recorded_sessions SET cwd = ?, agent_type = ?, last_seen = ? WHERE session_id = ?
    `);

    this.insertQA = db.prepare(`
      INSERT INTO recorded_qa
        (event_id, session_id, question, answer, model, tokens_in, tokens_out, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  attach(store: EventStore): void {
    store.on('event:new', (event: TimelineEvent) => {
      if (!this.getRecordingEnabled()) return;
      try {
        this.upsertSession.run(event.sessionId, event.agentType, event.timestamp, event.timestamp);
        this.insertEvent.run(
          event.id,
          event.sessionId,
          event.type,
          event.timestamp,
          event.agentType,
          JSON.stringify(event.data),
          event.analysis ? JSON.stringify(event.analysis) : null,
          event.laymans ? JSON.stringify(event.laymans) : null,
          event.riskLevel ?? null,
        );

        // Persist session metadata from session_metrics events
        if (event.type === 'session_metrics') {
          const updates: string[] = [];
          const values: (string | null)[] = [];
          if (event.data.modelId !== undefined) {
            updates.push('session_model = ?');
            values.push(event.data.modelId ?? null);
          }
          if (event.data.modelDisplayName !== undefined) {
            updates.push('session_model_display_name = ?');
            values.push(event.data.modelDisplayName ?? null);
          }
          if (event.data.sessionName !== undefined) {
            updates.push('session_name = ?');
            values.push(event.data.sessionName ?? null);
          }
          if (updates.length > 0) {
            values.push(event.sessionId);
            this.db.prepare(
              `UPDATE recorded_sessions SET ${updates.join(', ')} WHERE session_id = ?`
            ).run(...values);
          }
        }
      } catch {
        // Non-fatal: recording failure should not disrupt the live session
      }
    });

    store.on('event:update', (event: TimelineEvent) => {
      if (!this.getRecordingEnabled()) return;
      try {
        this.updateEvent.run(
          event.type,
          event.analysis ? JSON.stringify(event.analysis) : null,
          event.laymans ? JSON.stringify(event.laymans) : null,
          event.riskLevel ?? null,
          JSON.stringify(event.data),
          event.id,
        );
      } catch {
        // Non-fatal
      }
    });

    store.on('sessions:changed', (sessions: Array<{ sessionId: string; cwd: string; agentType: string; lastSeen: number }>) => {
      if (!this.getRecordingEnabled()) return;
      try {
        for (const s of sessions) {
          if (s.cwd) {
            this.updateSessionCwd.run(s.cwd, s.agentType, s.lastSeen, s.sessionId);
          }
        }
      } catch {
        // Non-fatal
      }
    });
  }

  saveEventsFromMemory(events: TimelineEvent[]): void {
    if (events.length === 0) return;
    const upsertSess = this.db.prepare(`
      INSERT INTO recorded_sessions (session_id, cwd, agent_type, started_at, last_seen)
      VALUES (?, '', ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)
    `);
    const insertEv = this.db.prepare(`
      INSERT OR IGNORE INTO recorded_events
        (id, session_id, type, timestamp, agent_type, data_json, analysis_json, laymans_json, risk_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this.db.transaction(() => {
      for (const event of events) {
        upsertSess.run(event.sessionId, event.agentType, event.timestamp, event.timestamp);
        insertEv.run(
          event.id,
          event.sessionId,
          event.type,
          event.timestamp,
          event.agentType,
          JSON.stringify(event.data),
          event.analysis ? JSON.stringify(event.analysis) : null,
          event.laymans ? JSON.stringify(event.laymans) : null,
          event.riskLevel ?? null,
        );
      }
    });
    tx();
  }

  recordQA(eventId: string, sessionId: string, qa: QARecord): void {
    if (!this.getRecordingEnabled()) return;
    try {
      this.insertQA.run(
        eventId,
        sessionId,
        qa.question,
        qa.answer,
        qa.model,
        qa.tokensIn,
        qa.tokensOut,
        qa.latencyMs,
        Date.now(),
      );
    } catch {
      // Non-fatal
    }
  }
}

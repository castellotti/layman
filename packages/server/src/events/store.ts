import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { TimelineEvent, EventType, EventData } from './types.js';
import type { AnalysisResult, LaymansResult } from '../analysis/types.js';

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  lastSeen: number;
  agentType: string;
}

export class EventStore extends EventEmitter {
  private events: TimelineEvent[] = [];
  private maxEvents = 10000;
  private sessions: Map<string, { cwd: string; lastSeen: number; agentType: string }> = new Map();

  add(
    type: EventType,
    sessionId: string,
    data: EventData,
    riskLevel?: 'low' | 'medium' | 'high',
    agentType: string = 'claude-code'
  ): TimelineEvent {
    const event: TimelineEvent = {
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      sessionId,
      agentType,
      data,
      riskLevel,
    };

    if (this.events.length >= this.maxEvents) {
      this.events.shift(); // Evict oldest
    }

    this.events.push(event);
    this.emit('event:new', event);
    return event;
  }

  addRaw(event: TimelineEvent): void {
    if (this.events.length >= this.maxEvents) {
      this.events.shift();
    }
    this.events.push(event);
    this.emit('event:new', event);
  }

  get(id: string): TimelineEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  getAll(): TimelineEvent[] {
    return [...this.events];
  }

  getPage(offset: number, limit: number): TimelineEvent[] {
    return this.events.slice(offset, offset + limit);
  }

  getByType(type: EventType): TimelineEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  attachAnalysis(eventId: string, analysis: AnalysisResult): TimelineEvent | undefined {
    const event = this.get(eventId);
    if (event) {
      event.analysis = analysis;
      this.emit('event:update', event);
    }
    return event;
  }

  attachLaymans(eventId: string, laymans: LaymansResult): TimelineEvent | undefined {
    const event = this.get(eventId);
    if (event) {
      event.laymans = laymans;
      this.emit('event:update', event);
    }
    return event;
  }

  updateType(eventId: string, type: EventType): void {
    const event = this.get(eventId);
    if (event) {
      event.type = type;
      this.emit('event:update', event);
    }
  }

  updateData(eventId: string, dataUpdates: Partial<EventData>): void {
    const event = this.get(eventId);
    if (event) {
      Object.assign(event.data, dataUpdates);
      this.emit('event:update', event);
    }
  }

  clear(): void {
    this.events = [];
    this.emit('store:cleared');
  }

  trackSession(sessionId: string, cwd: string, agentType: string = 'claude-code'): void {
    const existing = this.sessions.get(sessionId);
    const isNew = !existing;
    const cwdChanged = existing && existing.cwd !== cwd;
    this.sessions.set(sessionId, { cwd, lastSeen: Date.now(), agentType });
    if (isNew || cwdChanged) {
      this.emit('sessions:changed', this.getSessions());
    }
  }

  getSessions(): SessionInfo[] {
    // If map is empty but events exist, derive sessions from event history
    // (cwd will be '' until next hook fires and calls trackSession)
    if (this.sessions.size === 0 && this.events.length > 0) {
      const seen = new Map<string, number>();
      for (const event of this.events) {
        const existing = seen.get(event.sessionId);
        if (!existing || event.timestamp > existing) {
          seen.set(event.sessionId, event.timestamp);
        }
      }
      return Array.from(seen.entries())
        .map(([sessionId, lastSeen]) => ({ sessionId, cwd: '', lastSeen, agentType: 'claude-code' }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
    }
    return Array.from(this.sessions.entries())
      .map(([sessionId, info]) => ({ sessionId, ...info }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get size(): number {
    return this.events.length;
  }
}

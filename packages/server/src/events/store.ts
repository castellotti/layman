import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { TimelineEvent, EventType, EventData, FileAccess, UrlAccess, SessionAccessLog } from './types.js';
import type { AnalysisResult, LaymansResult } from '../analysis/types.js';

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  lastSeen: number;
  agentType: string;
  active?: boolean;
  opencodeUrl?: string;
  sessionName?: string;
}

export class EventStore extends EventEmitter {
  private events: TimelineEvent[] = [];
  private eventById = new Map<string, TimelineEvent>();
  private maxEvents = 10000;
  private sessions: Map<string, { cwd: string; lastSeen: number; agentType: string; opencodeUrl?: string; sessionName?: string }> = new Map();
  private accessLogs: Map<string, { files: FileAccess[]; urls: UrlAccess[] }> = new Map();
  private dataFilter?: (data: EventData) => EventData;

  setDataFilter(filter: (data: EventData) => EventData): void {
    this.dataFilter = filter;
  }

  add(
    type: EventType,
    sessionId: string,
    data: EventData,
    riskLevel?: 'low' | 'medium' | 'high',
    agentType: string = 'claude-code'
  ): TimelineEvent {
    const filteredData = this.dataFilter ? this.dataFilter(data) : data;
    const event: TimelineEvent = {
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      sessionId,
      agentType,
      data: filteredData,
      riskLevel,
    };

    if (this.events.length >= this.maxEvents) {
      const evicted = this.events.shift()!;
      this.eventById.delete(evicted.id);
    }

    this.events.push(event);
    this.eventById.set(event.id, event);
    this.emit('event:new', event);
    return event;
  }

  addRaw(event: TimelineEvent): void {
    if (this.events.length >= this.maxEvents) {
      const evicted = this.events.shift()!;
      this.eventById.delete(evicted.id);
    }
    this.events.push(event);
    this.eventById.set(event.id, event);
    this.emit('event:new', event);
  }

  get(id: string): TimelineEvent | undefined {
    return this.eventById.get(id);
  }

  getAll(): TimelineEvent[] {
    return [...this.events];
  }

  /** Returns the last n events without copying the full array. */
  getLast(n: number): TimelineEvent[] {
    return this.events.slice(-n);
  }

  /** Scans from the end and returns the first event matching the predicate, or undefined. */
  findLast(predicate: (e: TimelineEvent) => boolean): TimelineEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (predicate(this.events[i])) return this.events[i];
    }
    return undefined;
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
      const filtered = this.dataFilter ? this.dataFilter(dataUpdates as EventData) : dataUpdates;
      Object.assign(event.data, filtered);
      this.emit('event:update', event);
    }
  }

  clear(): void {
    this.events = [];
    this.eventById.clear();
    this.emit('store:cleared');
  }

  trackSession(sessionId: string, cwd: string, agentType: string = 'claude-code', opencodeUrl?: string, sessionName?: string): void {
    const existing = this.sessions.get(sessionId);
    const isNew = !existing;
    const cwdChanged = existing && existing.cwd !== cwd;
    // Preserve existing values if none are provided (they may have been set from a previous event)
    const resolvedUrl = opencodeUrl ?? existing?.opencodeUrl;
    const resolvedName = sessionName ?? existing?.sessionName;
    this.sessions.set(sessionId, { cwd, lastSeen: Date.now(), agentType, opencodeUrl: resolvedUrl, sessionName: resolvedName });
    if (isNew || cwdChanged || (opencodeUrl && opencodeUrl !== existing?.opencodeUrl) || (sessionName && sessionName !== existing?.sessionName)) {
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

  recordAccess(sessionId: string, files: FileAccess[], urls: UrlAccess[]): void {
    let log = this.accessLogs.get(sessionId);
    if (!log) {
      log = { files: [], urls: [] };
      this.accessLogs.set(sessionId, log);
    }
    log.files.push(...files);
    log.urls.push(...urls);
    this.emit('access:updated', sessionId);
  }

  getAccessLog(sessionId: string): SessionAccessLog {
    return this.accessLogs.get(sessionId) ?? { files: [], urls: [] };
  }

  get size(): number {
    return this.events.length;
  }
}

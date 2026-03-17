import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { TimelineEvent, EventType, EventData } from './types.js';
import type { AnalysisResult } from '../analysis/types.js';

export class EventStore extends EventEmitter {
  private events: TimelineEvent[] = [];
  private maxEvents = 10000;

  add(
    type: EventType,
    sessionId: string,
    data: EventData,
    riskLevel?: 'low' | 'medium' | 'high'
  ): TimelineEvent {
    const event: TimelineEvent = {
      id: randomUUID(),
      type,
      timestamp: Date.now(),
      sessionId,
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

  get size(): number {
    return this.events.length;
  }
}

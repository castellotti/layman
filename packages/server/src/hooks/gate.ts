import { EventEmitter } from 'events';

export class SessionGate extends EventEmitter {
  private activated = new Set<string>();

  activate(sessionId: string): boolean {
    if (this.activated.has(sessionId)) return false;
    this.activated.add(sessionId);
    this.emit('session:activated', sessionId);
    return true;
  }

  deactivate(sessionId: string): boolean {
    if (!this.activated.has(sessionId)) return false;
    this.activated.delete(sessionId);
    this.emit('session:deactivated', sessionId);
    return true;
  }

  isActive(sessionId: string): boolean {
    return this.activated.has(sessionId);
  }

  getActiveSessions(): string[] {
    return [...this.activated];
  }

  get size(): number {
    return this.activated.size;
  }
}

import { EventEmitter } from 'events';

export class SessionGate extends EventEmitter {
  private activated = new Set<string>();
  /** Sessions suspended while active; `resume()` re-activates exactly these. */
  private suspendedActive = new Set<string>();

  activate(sessionId: string): boolean {
    if (this.activated.has(sessionId)) return false;
    this.activated.add(sessionId);
    this.emit('session:activated', sessionId);
    return true;
  }

  deactivate(sessionId: string): boolean {
    // A plain deactivate is final — forget any pending suspension so a manual
    // hide is never undone by a later resume().
    this.suspendedActive.delete(sessionId);
    if (!this.activated.has(sessionId)) return false;
    this.activated.delete(sessionId);
    this.emit('session:deactivated', sessionId);
    return true;
  }

  /**
   * Deactivate a session but remember whether it was active, so `resume()` can
   * restore exactly that. The passive watchers call this when a session
   * tombstones on idle timeout: a glove/auto-activated session should reappear
   * when it resumes, but one the user manually deactivated (via `deactivate()`,
   * which forgets the suspension) must stay hidden.
   */
  suspend(sessionId: string): void {
    if (this.deactivate(sessionId)) this.suspendedActive.add(sessionId);
  }

  /** Re-activate a session suspended while active; no-op otherwise. */
  resume(sessionId: string): boolean {
    if (!this.suspendedActive.delete(sessionId)) return false;
    return this.activate(sessionId);
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

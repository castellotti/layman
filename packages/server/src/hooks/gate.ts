import { EventEmitter } from 'events';

interface PendingSession {
  cwd: string;
  agentType: string;
}

export class SessionGate extends EventEmitter {
  private activated = new Set<string>();
  /** Sessions seen pre-gate — used for cwd-based activation (e.g. Codex sub-agent curl) */
  private pending = new Map<string, PendingSession>();

  /** Record a session before it is activated, keyed by sessionId. */
  registerPending(sessionId: string, cwd: string, agentType: string): void {
    if (!this.pending.has(sessionId)) {
      this.pending.set(sessionId, { cwd, agentType });
    }
  }

  /**
   * Activate all pending sessions whose cwd matches. Returns activated session IDs.
   * Used by the Codex /api/codex/activate endpoint so a skill sub-agent can unblock
   * the parent session without knowing its session_id.
   */
  activateByCwd(cwd: string, agentType?: string): string[] {
    const activated: string[] = [];
    for (const [sessionId, info] of this.pending.entries()) {
      if (info.cwd === cwd && (agentType === undefined || info.agentType === agentType)) {
        if (this.activate(sessionId)) {
          activated.push(sessionId);
        }
      }
    }
    return activated;
  }

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

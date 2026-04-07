import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { PreToolUseInput, PermissionRequestInput, ApprovalDecision } from './types.js';
import type { AnalysisResult } from '../analysis/types.js';

export interface PendingApproval {
  id: string;
  eventName: 'PreToolUse' | 'PermissionRequest';
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionId: string;
  cwd: string;
  timestamp: number;
  analysis?: AnalysisResult;
  isDriftBlock?: boolean;
  resolve: (decision: ApprovalDecision) => void;
  promise: Promise<ApprovalDecision>;
}

export interface PendingApprovalDTO {
  id: string;
  eventName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
  analysis?: AnalysisResult;
  riskLevel?: 'low' | 'medium' | 'high';
  isDriftBlock?: boolean;
}

export class PendingApprovalManager extends EventEmitter {
  private pending = new Map<string, PendingApproval>();
  private hookTimeout: number;

  constructor(hookTimeout = 300) {
    super();
    this.hookTimeout = hookTimeout;
  }

  async createAndWait(
    input: PreToolUseInput | PermissionRequestInput,
    timeoutOverride?: number,
    options?: { isDriftBlock?: boolean }
  ): Promise<ApprovalDecision> {
    const id = randomUUID();
    let resolve!: (d: ApprovalDecision) => void;
    const promise = new Promise<ApprovalDecision>((r) => {
      resolve = r;
    });

    const approval: PendingApproval = {
      id,
      eventName: input.hook_event_name as 'PreToolUse' | 'PermissionRequest',
      toolName: input.tool_name,
      toolInput: input.tool_input,
      sessionId: input.session_id,
      cwd: input.cwd,
      timestamp: Date.now(),
      isDriftBlock: options?.isDriftBlock,
      resolve,
      promise,
    };

    this.pending.set(id, approval);
    this.emit('pending:new', approval);
    this.emit('pending:analyze', approval);

    const effectiveTimeout = timeoutOverride ?? this.hookTimeout;
    const timeout = setTimeout(() => {
      if (this.pending.has(id)) {
        this.resolveApproval(id, { decision: 'ask' });
      }
    }, effectiveTimeout * 1000);

    const decision = await promise;
    clearTimeout(timeout);
    this.pending.delete(id);
    this.emit('pending:resolved', id, decision);
    return decision;
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const approval = this.pending.get(id);
    if (!approval) return false;
    approval.resolve(decision);
    return true;
  }

  attachAnalysis(id: string, analysis: AnalysisResult): void {
    const approval = this.pending.get(id);
    if (approval) {
      approval.analysis = analysis;
      this.emit('pending:updated', approval);
    }
  }

  getPending(): PendingApproval[] {
    return Array.from(this.pending.values());
  }

  getPendingDTO(): PendingApprovalDTO[] {
    return this.getPending().map((a) => ({
      id: a.id,
      eventName: a.eventName,
      toolName: a.toolName,
      toolInput: a.toolInput,
      timestamp: a.timestamp,
      analysis: a.analysis,
      isDriftBlock: a.isDriftBlock,
    }));
  }

  releaseDriftBlocks(): string[] {
    const released: string[] = [];
    for (const [id, approval] of this.pending) {
      if (approval.isDriftBlock) {
        this.resolveApproval(id, { decision: 'allow', reason: 'Drift blocking disabled via config' });
        released.push(id);
      }
    }
    return released;
  }

  get size(): number {
    return this.pending.size;
  }

  setHookTimeout(seconds: number): void {
    this.hookTimeout = seconds;
  }
}

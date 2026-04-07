import { readFile } from 'node:fs/promises';
import { EventStore } from '../events/store.js';
import { AnalysisEngine } from '../analysis/engine.js';
import { PendingApprovalManager } from '../hooks/pending.js';
import type { LaymanConfig } from '../config/schema.js';
import type { ServerMessage } from '../types/index.js';
import type {
  DriftLevel,
  DriftState,
  DriftSessionState,
  DriftCheckResult,
  DriftPreToolUseResult,
} from './types.js';
import {
  GOAL_DRIFT_SYSTEM_PROMPT,
  RULES_DRIFT_SYSTEM_PROMPT,
  buildGoalDriftUserMessage,
  buildRulesDriftUserMessage,
  parseDriftResponse,
} from './prompts.js';

const MAX_RECENT_PROMPTS = 10;
const MAX_RECENT_TOOL_CALLS = 20;
const EMA_ALPHA = 0.3;

function createSessionState(sessionId: string): DriftSessionState {
  return {
    sessionId,
    initialPrompt: null,
    recentPrompts: [],
    recentToolCalls: [],
    toolCallsSinceLastCheck: 0,
    lastCheckTimestamp: Date.now(),
    sessionGoalDriftPct: 0,
    sessionGoalDriftLevel: 'green',
    rulesDriftPct: 0,
    rulesDriftLevel: 'green',
    lastCheckModel: '',
    claudeMdContents: new Map(),
    interventionPending: false,
    lastInterventionTimestamp: 0,
    checkInProgress: false,
  };
}

function classifyLevel(pct: number, thresholds: { green: number; yellow: number; orange: number }): DriftLevel {
  if (pct < thresholds.green) return 'green';
  if (pct < thresholds.yellow) return 'yellow';
  if (pct < thresholds.orange) return 'orange';
  return 'red';
}

/** Remap host path to container-mounted path (same logic as handler.ts) */
function remapPath(hostPath: string): string {
  const homeMatch = hostPath.match(/^\/Users\/[^/]+\/(.+)$/);
  if (homeMatch) return `/root/${homeMatch[1]}`;
  return hostPath;
}

async function readFileContent(filePath: string): Promise<string | null> {
  // Try container path first, then original
  const containerPath = remapPath(filePath);
  try {
    return await readFile(containerPath, 'utf-8');
  } catch {
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}

export class DriftMonitor {
  private sessions = new Map<string, DriftSessionState>();
  private eventStore: EventStore;
  private analysisEngine: AnalysisEngine;
  private pendingManager: PendingApprovalManager;
  private getConfig: () => LaymanConfig;
  private broadcast: (message: ServerMessage) => void;

  constructor(
    eventStore: EventStore,
    analysisEngine: AnalysisEngine,
    pendingManager: PendingApprovalManager,
    getConfig: () => LaymanConfig,
    broadcast: (message: ServerMessage) => void,
  ) {
    this.eventStore = eventStore;
    this.analysisEngine = analysisEngine;
    this.pendingManager = pendingManager;
    this.getConfig = getConfig;
    this.broadcast = broadcast;
  }

  private getOrCreateSession(sessionId: string): DriftSessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = createSessionState(sessionId);
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Called when a user prompt is submitted */
  onUserPrompt(sessionId: string, prompt: string): void {
    const state = this.getOrCreateSession(sessionId);
    if (!state.initialPrompt) {
      state.initialPrompt = prompt;
    }
    state.recentPrompts.push(prompt);
    if (state.recentPrompts.length > MAX_RECENT_PROMPTS) {
      state.recentPrompts.shift();
    }
  }

  /** Called when a tool call completes (PostToolUse) */
  onToolCallCompleted(
    sessionId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    toolOutput?: unknown,
  ): void {
    const state = this.getOrCreateSession(sessionId);
    state.recentToolCalls.push({ toolName, toolInput, toolOutput });
    if (state.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
      state.recentToolCalls.shift();
    }
    state.toolCallsSinceLastCheck++;

    const config = this.getConfig();
    if (this.shouldRunCheck(state, config)) {
      void this.runDriftCheck(sessionId);
    }
  }

  /** Called when a CLAUDE.md file is loaded */
  async onInstructionsLoaded(sessionId: string, filePath: string): Promise<void> {
    // Only cache CLAUDE.md files (not other instruction files)
    const lowerPath = filePath.toLowerCase();
    if (!lowerPath.includes('claude')) return;

    const content = await readFileContent(filePath);
    if (content) {
      const state = this.getOrCreateSession(sessionId);
      state.claudeMdContents.set(filePath, content);
    }
  }

  /** Check if a drift analysis should run */
  private shouldRunCheck(state: DriftSessionState, config: LaymanConfig): boolean {
    if (state.checkInProgress) return false;
    const dm = config.driftMonitoring;
    const toolCallThresholdMet = state.toolCallsSinceLastCheck >= dm.checkIntervalToolCalls;
    const timeThresholdMet = Date.now() - state.lastCheckTimestamp >= dm.checkIntervalMinutes * 60_000;
    return toolCallThresholdMet || timeThresholdMet;
  }

  /** Run both drift algorithms and update state */
  async runDriftCheck(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || state.checkInProgress) return;

    state.checkInProgress = true;
    state.toolCallsSinceLastCheck = 0;
    state.lastCheckTimestamp = Date.now();

    const config = this.getConfig();

    try {
      const [goalResult, rulesResult] = await Promise.all([
        this.runGoalDriftCheck(state),
        this.runRulesDriftCheck(state),
      ]);

      // Apply EMA smoothing
      const prevGoalLevel = state.sessionGoalDriftLevel;
      const prevRulesLevel = state.rulesDriftLevel;

      state.sessionGoalDriftPct = state.sessionGoalDriftPct * (1 - EMA_ALPHA) + goalResult.pct * EMA_ALPHA;
      state.rulesDriftPct = state.rulesDriftPct * (1 - EMA_ALPHA) + rulesResult.pct * EMA_ALPHA;
      state.sessionGoalDriftLevel = classifyLevel(state.sessionGoalDriftPct, config.driftMonitoring.sessionDriftThresholds);
      state.rulesDriftLevel = classifyLevel(state.rulesDriftPct, config.driftMonitoring.rulesDriftThresholds);
      state.lastCheckModel = goalResult.model || rulesResult.model || '';

      // Emit drift_check events
      this.eventStore.add('drift_check', sessionId, {
        driftType: 'session_goal',
        driftPct: Math.round(state.sessionGoalDriftPct * 10) / 10,
        driftLevel: state.sessionGoalDriftLevel,
        driftSummary: goalResult.result?.summary,
        driftIndicators: goalResult.result?.indicators,
        driftPhantomRefs: goalResult.result?.phantomReferences,
        driftPatternBreaks: goalResult.result?.patternBreaks,
      }, undefined, 'system');

      this.eventStore.add('drift_check', sessionId, {
        driftType: 'rules',
        driftPct: Math.round(state.rulesDriftPct * 10) / 10,
        driftLevel: state.rulesDriftLevel,
        driftSummary: rulesResult.result?.summary,
        driftViolations: rulesResult.result?.violations,
      }, undefined, 'system');

      // Emit drift_alert if level changed (crossed threshold)
      if (prevGoalLevel !== state.sessionGoalDriftLevel) {
        const riskLevel = state.sessionGoalDriftLevel === 'red' ? 'high'
          : state.sessionGoalDriftLevel === 'orange' ? 'medium' : undefined;
        this.eventStore.add('drift_alert', sessionId, {
          driftType: 'session_goal',
          driftPct: Math.round(state.sessionGoalDriftPct * 10) / 10,
          driftLevel: state.sessionGoalDriftLevel,
          driftPreviousLevel: prevGoalLevel,
          driftSummary: goalResult.result?.summary,
          driftIndicators: goalResult.result?.indicators,
          driftPhantomRefs: goalResult.result?.phantomReferences,
          driftPatternBreaks: goalResult.result?.patternBreaks,
        }, riskLevel, 'system');
      }

      if (prevRulesLevel !== state.rulesDriftLevel) {
        const riskLevel = state.rulesDriftLevel === 'red' ? 'high'
          : state.rulesDriftLevel === 'orange' ? 'medium' : undefined;
        this.eventStore.add('drift_alert', sessionId, {
          driftType: 'rules',
          driftPct: Math.round(state.rulesDriftPct * 10) / 10,
          driftLevel: state.rulesDriftLevel,
          driftPreviousLevel: prevRulesLevel,
          driftSummary: rulesResult.result?.summary,
          driftViolations: rulesResult.result?.violations,
        }, riskLevel, 'system');
      }

      // Broadcast updated drift state
      this.broadcast({
        type: 'drift:update',
        sessionId,
        state: this.buildDriftState(state),
      });
    } catch (err) {
      console.error(`[drift] Check failed for session ${sessionId.slice(0, 8)}:`, err);
    } finally {
      state.checkInProgress = false;
    }
  }

  /** Check drift levels before allowing a PreToolUse event through */
  checkPreToolUse(sessionId: string): DriftPreToolUseResult {
    const state = this.sessions.get(sessionId);
    if (!state) return { shouldBlock: false, shouldRemind: false };

    const config = this.getConfig();
    const dm = config.driftMonitoring;
    const worstLevel = this.worstLevel(state.sessionGoalDriftLevel, state.rulesDriftLevel);

    // Red level: block
    if (worstLevel === 'red' && dm.blockOnRed) {
      const violations = this.buildViolationSummary(state);
      return {
        shouldBlock: true,
        shouldRemind: false,
        reason: `Drift monitoring: ${violations}`,
        rulesSummary: this.buildRulesSummary(state),
      };
    }

    // Orange level: remind
    if ((worstLevel === 'orange' || worstLevel === 'red') && dm.remindOnOrange) {
      return {
        shouldBlock: false,
        shouldRemind: true,
        reason: this.buildViolationSummary(state),
        rulesSummary: this.buildRulesSummary(state),
      };
    }

    return { shouldBlock: false, shouldRemind: false };
  }

  /** Get current drift state for a session (for WS initial sync) */
  getState(sessionId: string): DriftState | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return this.buildDriftState(state);
  }

  /** Reset drift scores to 0 (user acknowledged drift) */
  resetScores(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    state.sessionGoalDriftPct = 0;
    state.sessionGoalDriftLevel = 'green';
    state.rulesDriftPct = 0;
    state.rulesDriftLevel = 'green';
    state.interventionPending = false;

    this.broadcast({
      type: 'drift:update',
      sessionId,
      state: this.buildDriftState(state),
    });
  }

  /** Clear all state for a session */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // ---- Internal helpers ----

  private async runGoalDriftCheck(
    state: DriftSessionState,
  ): Promise<{ pct: number; model: string; result: DriftCheckResult | null }> {
    if (!state.initialPrompt && state.recentToolCalls.length === 0) {
      return { pct: 0, model: '', result: null };
    }

    try {
      const userMessage = buildGoalDriftUserMessage(state);
      const response = await this.analysisEngine.assessDrift(GOAL_DRIFT_SYSTEM_PROMPT, userMessage);
      const result = parseDriftResponse(response.text);
      return { pct: result.driftPercentage, model: response.model, result };
    } catch {
      return { pct: state.sessionGoalDriftPct, model: '', result: null };
    }
  }

  private async runRulesDriftCheck(
    state: DriftSessionState,
  ): Promise<{ pct: number; model: string; result: DriftCheckResult | null }> {
    if (state.claudeMdContents.size === 0) {
      return { pct: 0, model: '', result: null };
    }

    try {
      const userMessage = buildRulesDriftUserMessage(state);
      const response = await this.analysisEngine.assessDrift(RULES_DRIFT_SYSTEM_PROMPT, userMessage);
      const result = parseDriftResponse(response.text);
      return { pct: result.driftPercentage, model: response.model, result };
    } catch {
      return { pct: state.rulesDriftPct, model: '', result: null };
    }
  }

  private buildDriftState(state: DriftSessionState): DriftState {
    return {
      sessionId: state.sessionId,
      sessionGoalDriftPct: Math.round(state.sessionGoalDriftPct * 10) / 10,
      sessionGoalDriftLevel: state.sessionGoalDriftLevel,
      rulesDriftPct: Math.round(state.rulesDriftPct * 10) / 10,
      rulesDriftLevel: state.rulesDriftLevel,
      lastCheckTimestamp: state.lastCheckTimestamp,
      lastCheckModel: state.lastCheckModel,
    };
  }

  private buildViolationSummary(state: DriftSessionState): string {
    const parts: string[] = [];
    if (state.sessionGoalDriftLevel === 'red' || state.sessionGoalDriftLevel === 'orange') {
      parts.push(`Session goal drift: ${Math.round(state.sessionGoalDriftPct)}%`);
    }
    if (state.rulesDriftLevel === 'red' || state.rulesDriftLevel === 'orange') {
      parts.push(`Rules drift: ${Math.round(state.rulesDriftPct)}%`);
    }
    return parts.join('; ') || 'Drift thresholds exceeded';
  }

  private buildRulesSummary(state: DriftSessionState): string {
    const rules = Array.from(state.claudeMdContents.entries())
      .map(([path, content]) => `[${path}]: ${content.slice(0, 500)}`)
      .join('\n');
    return rules || 'No CLAUDE.md rules loaded';
  }

  private worstLevel(a: DriftLevel, b: DriftLevel): DriftLevel {
    const order: Record<DriftLevel, number> = { green: 0, yellow: 1, orange: 2, red: 3 };
    return order[a] >= order[b] ? a : b;
  }
}

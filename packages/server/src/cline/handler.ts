/**
 * Cline hook handler — accepts Cline's native hook JSON format and translates
 * it into Layman's internal event pipeline.
 *
 * Cline hooks are shell scripts that receive JSON on stdin and return JSON on stdout.
 * The bash hook scripts installed by Layman simply pipe stdin to this endpoint via curl.
 *
 * Key differences from Claude Code hooks:
 * - Sessions require explicit activation via /layman workflow (same gate as Claude Code)
 * - PreToolUse has a 25-second blocking timeout (Cline's hardcoded limit is 30s)
 * - Response format is { cancel: boolean } instead of { hookSpecificOutput: { permissionDecision } }
 * - No transcript_path — agent responses are not captured via transcripts
 */

import type { FastifyInstance } from 'fastify';
import { PendingApprovalManager } from '../hooks/pending.js';
import { SessionGate } from '../hooks/gate.js';
import { EventStore } from '../events/store.js';
import { classifyRisk } from '../events/classifier.js';
import { AnalysisEngine } from '../analysis/engine.js';
import type { LaymanConfig } from '../config/schema.js';
import type { ApprovalDecision } from '../hooks/types.js';
import type { ClineHookInput, ClineHookOutput } from './translator.js';
import {
  translatePreToolUse,
  translatePostToolUse,
  translateTaskStart,
  translateTaskResume,
  translateTaskEnd,
  translateUserPromptSubmit,
  translatePreCompact,
} from './translator.js';

const AGENT_TYPE = 'cline';
const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'ListDirectory', 'LSP']);

/** Cline's hardcoded hook timeout is 30s; we use 25s to leave margin for response transit */
const CLINE_BLOCKING_TIMEOUT_S = 25;

/** Detect /layman activation command in an execute_command call */
const ACTIVATION_PATTERN = /echo\s+["']?layman:activate["']?/;

/**
 * Tracks which workspace directories have been activated for monitoring.
 * Keyed by cwd (workspace root). Persists for the lifetime of the Layman process.
 *
 * Using cwd instead of taskId means activation survives Plan/Act mode switches and
 * task cancellations — both of which can change the taskId but keep the same workspace.
 * Once the user runs /layman in a workspace, all subsequent tasks there are monitored.
 */
const activatedCwds = new Set<string>();

export function registerClineHookHandler(
  fastify: FastifyInstance,
  pendingManager: PendingApprovalManager,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  getConfig: () => LaymanConfig,
  gate: SessionGate
): void {
  fastify.post<{ Params: { hookName: string }; Body: ClineHookInput }>(
    '/hooks/cline/:hookName',
    async (request, reply) => {
      const { hookName } = request.params;
      const body = request.body;

      try {
        const sessionId = body.taskId;
        const cwd = body.workspaceRoots?.[0] ?? '';

        // Gate check: detect /layman activation before gating so we can activate.
        // On activation, record the cwd so future tasks in this workspace are auto-activated.
        if (sessionId && hookName === 'PreToolUse') {
          const toolName = body.preToolUse?.toolName;
          const command = body.preToolUse?.parameters?.command ?? '';
          if (toolName === 'execute_command' && ACTIVATION_PATTERN.test(command)) {
            if (cwd) activatedCwds.add(cwd);
            gate.activate(sessionId);
            if (cwd) eventStore.trackSession(sessionId, cwd, AGENT_TYPE);
            return reply.send({});
          }
        }

        // Auto-activate if the workspace was previously activated (e.g. after a mode switch
        // or task restart that changed the taskId but kept the same workspace).
        if (sessionId && cwd && !gate.isActive(sessionId) && activatedCwds.has(cwd)) {
          gate.activate(sessionId);
        }

        // Gate check: non-activated sessions get instant pass-through
        if (sessionId && !gate.isActive(sessionId)) {
          if (hookName === 'PreToolUse') return reply.send({});
          return reply.status(200).send({});
        }

        if (sessionId && cwd) {
          eventStore.trackSession(sessionId, cwd, AGENT_TYPE);
        }

        switch (hookName) {
          case 'PreToolUse': {
            const output = await handleClinePreToolUse(body, pendingManager, eventStore, analysisEngine, getConfig);
            return reply.send(output);
          }
          case 'PostToolUse': {
            handleClinePostToolUse(body, eventStore);
            return reply.status(200).send({});
          }
          case 'TaskStart': {
            handleClineTaskStart(body, eventStore);
            return reply.status(200).send({});
          }
          case 'TaskResume': {
            handleClineTaskResume(body, eventStore);
            return reply.status(200).send({});
          }
          case 'TaskComplete': {
            // TaskComplete fires when the AI finishes a turn (like Claude Code's Stop).
            // The task/conversation continues — only emit agent_stop, don't end the session.
            eventStore.add('agent_stop', body.taskId, {}, undefined, AGENT_TYPE);
            return reply.status(200).send({});
          }
          case 'TaskCancel': {
            handleClineTaskEnd(body, eventStore, gate);
            return reply.status(200).send({});
          }
          case 'UserPromptSubmit': {
            handleClineUserPromptSubmit(body, eventStore);
            return reply.status(200).send({});
          }
          case 'PreCompact': {
            handleClinePreCompact(body, eventStore);
            return reply.status(200).send({});
          }
          case 'Notification': {
            handleClineNotification(body, eventStore);
            return reply.status(200).send({});
          }
          default:
            return reply.status(400).send({ error: `Unknown Cline hook: ${hookName}` });
        }
      } catch (err) {
        request.log.error(err, `Error handling Cline hook ${hookName}`);
        // Return empty response to avoid blocking Cline
        return reply.send({});
      }
    }
  );
}

async function handleClinePreToolUse(
  body: ClineHookInput,
  pendingManager: PendingApprovalManager,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  getConfig: () => LaymanConfig
): Promise<ClineHookOutput> {
  const input = translatePreToolUse(body);
  const config = getConfig();
  const riskLevel = classifyRisk(input.tool_name, input.tool_input);

  // Check auto-allow rules
  const shouldAutoAllow =
    config.autoApprove ||
    (config.autoAllow.readOnly && AUTO_ALLOW_TOOLS.has(input.tool_name)) ||
    isAutoAllowedByPattern(input.tool_name, input.tool_input, config.autoAllow.trustedCommands);

  if (shouldAutoAllow) {
    eventStore.add('tool_call_approved', input.session_id, {
      toolName: input.tool_name,
      toolInput: input.tool_input,
    }, riskLevel, AGENT_TYPE);
    return {};
  }

  // Add pending event to timeline
  const timelineEvent = eventStore.add('tool_call_pending', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
  }, riskLevel, AGENT_TYPE);

  // Start analysis concurrently if configured
  const shouldAnalyze =
    config.autoAnalyze === 'all' ||
    (config.autoAnalyze === 'risky' && riskLevel !== 'low');

  if (shouldAnalyze) {
    void triggerAnalysis(input, timelineEvent.id, eventStore, analysisEngine, pendingManager, config);
  }

  // Block until user decides (25s timeout — auto-allow on expiry)
  const decision: ApprovalDecision = await pendingManager.createAndWait(input, CLINE_BLOCKING_TIMEOUT_S);

  // Update event in store
  const finalType =
    decision.decision === 'allow'
      ? 'tool_call_approved'
      : decision.decision === 'deny'
        ? 'tool_call_denied'
        : 'tool_call_delegated';

  eventStore.updateType(timelineEvent.id, finalType);
  eventStore.updateData(timelineEvent.id, { decision, approvalId: undefined, completedAt: Date.now() });

  // Translate to Cline format
  if (decision.decision === 'deny') {
    return { cancel: true, errorMessage: decision.reason ?? 'Blocked by Layman' };
  }
  // 'allow' or 'ask' (timeout) → proceed
  return {};
}

function handleClinePostToolUse(body: ClineHookInput, eventStore: EventStore): void {
  const input = translatePostToolUse(body);

  // attempt_completion carries the assistant's final response text in its `result` parameter.
  // Emit it as an agent_response so the Layman UI shows the AI's reply.
  if (body.postToolUse?.toolName === 'attempt_completion') {
    const responseText = body.postToolUse.parameters?.result;
    if (responseText) {
      eventStore.add('agent_response', input.session_id, { prompt: responseText }, undefined, AGENT_TYPE);
    }
    return;
  }

  // Find the matching pending event to update
  const events = eventStore.getAll();
  const pendingEvent = [...events].reverse().find(
    (e) =>
      (e.type === 'tool_call_pending' || e.type === 'tool_call_approved') &&
      e.data.toolName === input.tool_name &&
      e.sessionId === input.session_id
  );

  const completedAt = Date.now();
  if (pendingEvent && pendingEvent.type !== 'tool_call_completed') {
    eventStore.updateType(pendingEvent.id, 'tool_call_completed');
    eventStore.updateData(pendingEvent.id, { toolOutput: input.tool_output, completedAt });
  } else {
    eventStore.add('tool_call_completed', input.session_id, {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolOutput: input.tool_output,
      completedAt,
    }, undefined, AGENT_TYPE);
  }
}

function handleClineTaskStart(body: ClineHookInput, eventStore: EventStore): void {
  const input = translateTaskStart(body);
  const initialTask = body.taskStart?.taskMetadata?.initialTask;
  eventStore.add('session_start', input.session_id, {
    source: input.source,
    ...(initialTask ? { prompt: initialTask } : {}),
  }, undefined, AGENT_TYPE);
}

function handleClineTaskResume(body: ClineHookInput, eventStore: EventStore): void {
  const input = translateTaskResume(body);
  eventStore.add('session_start', input.session_id, {
    source: input.source,
  }, undefined, AGENT_TYPE);
}

function handleClineTaskEnd(body: ClineHookInput, eventStore: EventStore, gate: SessionGate): void {
  const input = translateTaskEnd(body);
  eventStore.add('session_end', input.session_id, {}, undefined, AGENT_TYPE);
  gate.deactivate(input.session_id);
}

function handleClineUserPromptSubmit(body: ClineHookInput, eventStore: EventStore): void {
  const input = translateUserPromptSubmit(body);
  eventStore.add('user_prompt', input.session_id, {
    prompt: input.prompt,
  }, undefined, AGENT_TYPE);
}

function handleClinePreCompact(body: ClineHookInput, eventStore: EventStore): void {
  const input = translatePreCompact(body);
  eventStore.add('pre_compact', input.session_id, {}, undefined, AGENT_TYPE);
}

function handleClineNotification(body: ClineHookInput, eventStore: EventStore): void {
  const notification = body.notification;
  eventStore.add('notification', body.taskId, {
    notificationType: notification?.event ?? 'unknown',
  }, undefined, AGENT_TYPE);
}

async function triggerAnalysis(
  input: { tool_name: string; tool_input: Record<string, unknown>; cwd: string },
  eventId: string,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  pendingManager: PendingApprovalManager,
  config: LaymanConfig
): Promise<void> {
  try {
    const recentEvents = eventStore.getAll().slice(-5).map((e) => ({
      type: e.type,
      summary: e.data.toolName
        ? `${e.data.toolName}: ${JSON.stringify(e.data.toolInput).slice(0, 100)}`
        : e.type,
    }));

    const result = await analysisEngine.analyze({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      cwd: input.cwd,
      depth: 'quick',
      recentEvents,
    });

    eventStore.attachAnalysis(eventId, result);

    const pending = pendingManager.getPending();
    const matchingPending = pending.find(
      (p) => p.toolName === input.tool_name && Math.abs(p.timestamp - Date.now()) < 60000
    );
    if (matchingPending) {
      pendingManager.attachAnalysis(matchingPending.id, result);
    }

    // Also trigger layman's explanation
    void analysisEngine.laymans(
      {
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        depth: 'quick',
      },
      config.laymansPrompt
    ).then((laymansResult) => {
      eventStore.attachLaymans(eventId, laymansResult);
    }).catch(() => { /* ignore */ });
  } catch {
    // Analysis failure doesn't block approval
  }
}

function isAutoAllowedByPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;
  if (toolName !== 'Bash') return false;

  const command = (toolInput as { command?: string }).command ?? '';
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(command);
    } catch {
      return false;
    }
  });
}

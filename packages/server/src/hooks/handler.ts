import type { FastifyInstance } from 'fastify';
import { PendingApprovalManager } from './pending.js';
import { EventStore } from '../events/store.js';
import { classifyRisk } from '../events/classifier.js';
import { AnalysisEngine } from '../analysis/engine.js';
import type {
  PreToolUseInput,
  PostToolUseInput,
  PostToolUseFailureInput,
  PermissionRequestInput,
  NotificationInput,
  SessionStartInput,
  SessionEndInput,
  StopInput,
  UserPromptSubmitInput,
  SubagentStartInput,
  SubagentStopInput,
  AgentResponseInput,
  PreToolUseResponse,
  PermissionResponse,
  ApprovalDecision,
} from './types.js';
import type { LaymanConfig } from '../config/schema.js';

const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch']);

export function registerHookHandler(
  fastify: FastifyInstance,
  pendingManager: PendingApprovalManager,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  getConfig: () => LaymanConfig
): void {
  fastify.post<{ Params: { eventName: string }; Body: Record<string, unknown> }>(
    '/hooks/:eventName',
    async (request, reply) => {
      const { eventName } = request.params;
      const body = request.body;

      try {
        // Track session activity from any hook event
        const sessionId = (body as { session_id?: string }).session_id;
        const cwd = (body as { cwd?: string }).cwd;
        // Resolve agent type — only accept known agent values to avoid confusion
        // with SubagentStart's agent_type field (which is the subagent name, not the source agent)
        const rawAgentType = (body as { agent_type?: string }).agent_type;
        const agentType =
          rawAgentType === 'opencode' ? 'opencode' : 'claude-code';
        if (sessionId && cwd) {
          eventStore.trackSession(sessionId, cwd, agentType);
        }

        switch (eventName) {
          case 'PreToolUse': {
            const input = body as unknown as PreToolUseInput;
            const response = await handlePreToolUse(input, pendingManager, eventStore, analysisEngine, getConfig, agentType);
            return reply.send(response);
          }
          case 'PostToolUse': {
            await handlePostToolUse(body as unknown as PostToolUseInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'PostToolUseFailure': {
            await handlePostToolUseFailure(body as unknown as PostToolUseFailureInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'PermissionRequest': {
            const input = body as unknown as PermissionRequestInput;
            const response = await handlePermissionRequest(input, pendingManager, eventStore, analysisEngine, getConfig, agentType);
            return reply.send(response);
          }
          case 'Notification': {
            await handleNotification(body as unknown as NotificationInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'SessionStart': {
            await handleSessionStart(body as unknown as SessionStartInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'SessionEnd': {
            await handleSessionEnd(body as unknown as SessionEndInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'Stop': {
            await handleStop(body as unknown as StopInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'UserPromptSubmit': {
            await handleUserPromptSubmit(body as unknown as UserPromptSubmitInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'SubagentStart': {
            await handleSubagentStart(body as unknown as SubagentStartInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'SubagentStop': {
            await handleSubagentStop(body as unknown as SubagentStopInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'AgentResponse': {
            await handleAgentResponse(body as unknown as AgentResponseInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          default:
            return reply.status(400).send({ error: `Unknown hook event: ${eventName}` });
        }
      } catch (err) {
        request.log.error(err, `Error handling hook ${eventName}`);
        // Return allow to prevent Claude Code from being blocked on errors
        if (eventName === 'PreToolUse') {
          const response: PreToolUseResponse = {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' },
          };
          return reply.send(response);
        }
        return reply.status(200).send({});
      }
    }
  );
}

async function handlePreToolUse(
  input: PreToolUseInput,
  pendingManager: PendingApprovalManager,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  getConfig: () => LaymanConfig,
  agentType: string = 'claude-code'
): Promise<PreToolUseResponse> {
  const config = getConfig();
  const riskLevel = classifyRisk(input.tool_name, input.tool_input);

  // Check auto-allow rules
  const shouldAutoAllow =
    config.autoApprove ||
    (config.autoAllow.readOnly && AUTO_ALLOW_TOOLS.has(input.tool_name)) ||
    isAutoAllowedByPattern(input.tool_name, input.tool_input, config.autoAllow.trustedCommands);

  if (shouldAutoAllow) {
    // Record event but don't block
    eventStore.add('tool_call_approved', input.session_id, {
      toolName: input.tool_name,
      toolInput: input.tool_input,
    }, riskLevel, agentType);

    return {};
  }

  // Add pending event to timeline
  const timelineEvent = eventStore.add('tool_call_pending', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
  }, riskLevel, agentType);

  // Start analysis concurrently if configured
  const shouldAnalyze =
    config.autoAnalyze === 'all' ||
    (config.autoAnalyze === 'risky' && riskLevel !== 'low');

  if (shouldAnalyze) {
    void triggerAnalysis(input, timelineEvent.id, eventStore, analysisEngine, pendingManager, config);
  }

  // Block until user decides
  const decision: ApprovalDecision = await pendingManager.createAndWait(input);

  // Update event in store
  const finalType =
    decision.decision === 'allow'
      ? 'tool_call_approved'
      : decision.decision === 'deny'
        ? 'tool_call_denied'
        : 'tool_call_delegated';

  eventStore.updateType(timelineEvent.id, finalType);
  eventStore.updateData(timelineEvent.id, { decision, approvalId: undefined, completedAt: Date.now() });

  const response: PreToolUseResponse = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
      updatedInput: decision.updatedInput,
    },
  };

  return response;
}

async function triggerAnalysis(
  input: PreToolUseInput,
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

    // Also attach to any pending approval for this event
    const pending = pendingManager.getPending();
    const matchingPending = pending.find(
      (p) => p.toolName === input.tool_name && Math.abs(p.timestamp - Date.now()) < 60000
    );
    if (matchingPending) {
      pendingManager.attachAnalysis(matchingPending.id, result);
    }

    void config; // used for config check above
  } catch {
    // Analysis failure doesn't block approval
  }
}

async function handlePostToolUse(
  input: PostToolUseInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  // Find the pending event to update it
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
    }, undefined, agentType);
  }
}

async function handlePostToolUseFailure(
  input: PostToolUseFailureInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('tool_call_failed', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
    error: input.tool_error,
  }, undefined, agentType);
}

async function handlePermissionRequest(
  input: PermissionRequestInput,
  pendingManager: PendingApprovalManager,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  getConfig: () => LaymanConfig,
  agentType: string = 'claude-code'
): Promise<PermissionResponse> {
  const config = getConfig();
  const riskLevel = classifyRisk(input.tool_name, input.tool_input);

  const timelineEvent = eventStore.add('permission_request', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
  }, riskLevel, agentType);

  const shouldAnalyze =
    config.autoAnalyze === 'all' ||
    (config.autoAnalyze === 'risky' && riskLevel !== 'low');

  if (shouldAnalyze) {
    void triggerAnalysisForPermission(input, timelineEvent.id, eventStore, analysisEngine);
  }

  const decision = await pendingManager.createAndWait(input);

  eventStore.updateData(timelineEvent.id, { decision });

  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  };
}

async function triggerAnalysisForPermission(
  input: PermissionRequestInput,
  eventId: string,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine
): Promise<void> {
  try {
    const result = await analysisEngine.analyze({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      cwd: input.cwd,
      depth: 'quick',
    });
    eventStore.attachAnalysis(eventId, result);
  } catch {
    // Analysis failure doesn't block
  }
}

async function handleNotification(
  input: NotificationInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('notification', input.session_id, {
    notificationType: input.notification_type,
  }, undefined, agentType);
}

async function handleSessionStart(
  input: SessionStartInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('session_start', input.session_id, {
    source: input.source,
  }, undefined, agentType);
}

async function handleSessionEnd(
  input: SessionEndInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('session_end', input.session_id, {}, undefined, agentType);
}

async function handleStop(
  input: StopInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('agent_stop', input.session_id, {}, undefined, agentType);
}

async function handleUserPromptSubmit(
  input: UserPromptSubmitInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('user_prompt', input.session_id, {
    prompt: input.prompt,
  }, undefined, agentType);
}

async function handleSubagentStart(
  input: SubagentStartInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('subagent_start', input.session_id, {
    agentType: input.agent_type,
  }, undefined, agentType);
}

async function handleSubagentStop(
  input: SubagentStopInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('subagent_stop', input.session_id, {
    agentType: input.agent_type,
  }, undefined, agentType);
}

async function handleAgentResponse(
  input: AgentResponseInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('agent_response', input.session_id, {
    prompt: input.response,
  }, undefined, agentType);
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

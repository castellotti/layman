import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { PendingApprovalManager } from './pending.js';
import { SessionGate } from './gate.js';
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
  StopFailureInput,
  PreCompactInput,
  PostCompactInput,
  ElicitationInput,
  ElicitationResultInput,
  PreToolUseResponse,
  PermissionResponse,
  ApprovalDecision,
} from './types.js';
import type { LaymanConfig } from '../config/schema.js';

const AUTO_ALLOW_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch']);

// Track the last-emitted assistant message UUID per transcript path.
// null = transcript seen but no messages emitted yet (emit from start).
// Keyed by transcript_path since each session/subagent has a unique path.
const transcriptWatermarks = new Map<string, string | null>();

/** Detect activation command in a Bash call (echo marker or legacy curl) */
const ACTIVATION_PATTERN = /echo\s+["']?layman:activate["']?|curl\b.*\/api\/activate/;

export function registerHookHandler(
  fastify: FastifyInstance,
  pendingManager: PendingApprovalManager,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  getConfig: () => LaymanConfig,
  gate: SessionGate
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
        const opencodeUrl = (body as { opencode_url?: string }).opencode_url;

        // Gate check: detect activation command before gating so we can activate
        if (sessionId && eventName === 'PreToolUse') {
          const toolName = (body as { tool_name?: string }).tool_name;
          const toolInput = (body as { tool_input?: Record<string, unknown> }).tool_input;
          if (toolName === 'Bash' && toolInput) {
            const command = (toolInput as { command?: string }).command ?? '';
            if (ACTIVATION_PATTERN.test(command)) {
              gate.activate(sessionId);
              if (cwd) eventStore.trackSession(sessionId, cwd, agentType, opencodeUrl);
              return reply.send({});
            }
          }
        }

        // Gate check: non-activated sessions get instant pass-through
        if (sessionId && !gate.isActive(sessionId)) {
          // Blocking hooks must return {} to not stall Claude Code
          if (eventName === 'PreToolUse' || eventName === 'PermissionRequest') {
            return reply.send({});
          }
          // Async hooks are dropped silently
          return reply.status(200).send({});
        }

        if (sessionId && cwd) {
          eventStore.trackSession(sessionId, cwd, agentType, opencodeUrl);
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
            await handleSessionEnd(body as unknown as SessionEndInput, eventStore, gate, agentType);
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
          case 'StopFailure': {
            await handleStopFailure(body as unknown as StopFailureInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'PreCompact': {
            await handlePreCompact(body as unknown as PreCompactInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'PostCompact': {
            await handlePostCompact(body as unknown as PostCompactInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'Elicitation': {
            await handleElicitation(body as unknown as ElicitationInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'ElicitationResult': {
            await handleElicitationResult(body as unknown as ElicitationResultInput, eventStore, agentType);
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

  // Emit any assistant "thinking" text that preceded this tool call
  await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);

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
    void triggerLaymans(input, timelineEvent.id, eventStore, analysisEngine, config);
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

async function triggerLaymans(
  input: PreToolUseInput,
  eventId: string,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  config: LaymanConfig
): Promise<void> {
  try {
    const result = await analysisEngine.laymans(
      {
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        depth: 'quick',
      },
      config.laymansPrompt
    );
    eventStore.attachLaymans(eventId, result);
  } catch {
    // Layman's failure doesn't block approval
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
  // Snapshot the current last assistant UUID so resumed sessions don't re-emit history
  await initTranscriptWatermark(input.transcript_path);
}

async function handleSessionEnd(
  input: SessionEndInput,
  eventStore: EventStore,
  gate: SessionGate,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('session_end', input.session_id, {}, undefined, agentType);
  gate.deactivate(input.session_id);
  transcriptWatermarks.delete(input.transcript_path);
}

async function handleStop(
  input: StopInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('agent_stop', input.session_id, {}, undefined, agentType);
  // Emit the final assistant response (and any intermediate messages not yet emitted).
  // The transcript file may not be flushed yet when Stop fires, so retry after a short
  // delay if the first read finds nothing new.
  const emitted = await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);
  if (!emitted) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);
  }
}

/** Remap host ~/.claude path to container-mounted /root/.claude path */
function remapTranscriptPath(hostPath: string): string {
  const match = hostPath.match(/\.claude\/(.+)$/);
  if (!match) return hostPath;
  return `/root/.claude/${match[1]}`;
}

/** Read transcript content, trying Docker-remapped path first then original */
async function readTranscriptContent(transcriptPath: string): Promise<string | null> {
  const containerPath = remapTranscriptPath(transcriptPath);
  try {
    return await readFile(containerPath, 'utf-8');
  } catch {
    try {
      return await readFile(transcriptPath, 'utf-8');
    } catch {
      return null;
    }
  }
}

/** Snapshot the current last assistant UUID so future calls only emit new messages */
async function initTranscriptWatermark(transcriptPath: string): Promise<void> {
  if (transcriptWatermarks.has(transcriptPath)) return;
  const content = await readTranscriptContent(transcriptPath);
  if (!content) {
    transcriptWatermarks.set(transcriptPath, null);
    return;
  }
  const lines = content.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>;
      if (obj.type === 'assistant' && typeof obj.uuid === 'string') {
        transcriptWatermarks.set(transcriptPath, obj.uuid);
        return;
      }
    } catch { /* skip */ }
  }
  transcriptWatermarks.set(transcriptPath, null);
}

/** Emit all assistant text messages in the transcript that haven't been emitted yet.
 *  Returns true if at least one agent_response event was emitted. */
async function emitNewAssistantMessages(
  transcriptPath: string,
  sessionId: string,
  eventStore: EventStore,
  agentType: string
): Promise<boolean> {
  // If we haven't seen this transcript before, init watermark first (avoids emitting history)
  if (!transcriptWatermarks.has(transcriptPath)) {
    await initTranscriptWatermark(transcriptPath);
    return false; // nothing new to emit on first sight
  }

  const content = await readTranscriptContent(transcriptPath);
  if (!content) return false;

  const watermark = transcriptWatermarks.get(transcriptPath);
  const lines = content.trim().split('\n').filter(Boolean);

  let pastWatermark = watermark === null; // null = emit from beginning
  let newWatermark: string | null = null;
  let emitted = false;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type !== 'assistant') continue;

      const uuid = typeof obj.uuid === 'string' ? obj.uuid : null;

      if (!pastWatermark) {
        if (uuid === watermark) pastWatermark = true;
        continue;
      }

      const msg = obj.message as Record<string, unknown> | undefined;
      const blocks = msg?.content;
      if (!Array.isArray(blocks)) continue;

      const texts = (blocks as Record<string, unknown>[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => (b.text as string).trim())
        .filter(Boolean);

      if (texts.length > 0) {
        eventStore.add('agent_response', sessionId, { prompt: texts.join('\n\n') }, undefined, agentType);
        emitted = true;
      }

      if (uuid) newWatermark = uuid;
    } catch { /* skip malformed lines */ }
  }

  if (newWatermark) {
    transcriptWatermarks.set(transcriptPath, newWatermark);
  }

  return emitted;
}

async function handleUserPromptSubmit(
  input: UserPromptSubmitInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  // Catch-up: emit any assistant messages from the previous turn that weren't captured
  // by Stop (e.g. if the transcript wasn't flushed in time). This ensures responses
  // appear in the timeline before the next user prompt.
  await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);

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

async function handleStopFailure(
  input: StopFailureInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('stop_failure', input.session_id, {
    error: input.error,
  }, undefined, agentType);
}

async function handlePreCompact(
  input: PreCompactInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('pre_compact', input.session_id, {}, undefined, agentType);
}

async function handlePostCompact(
  input: PostCompactInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('post_compact', input.session_id, {}, undefined, agentType);
}

async function handleElicitation(
  input: ElicitationInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('elicitation', input.session_id, {
    prompt: input.message,
  }, undefined, agentType);
}

async function handleElicitationResult(
  input: ElicitationResultInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('elicitation_result', input.session_id, {
    prompt: input.canceled ? '(canceled)' : JSON.stringify(input.result),
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

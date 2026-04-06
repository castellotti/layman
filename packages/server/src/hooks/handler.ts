import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { recoverPreActivationHistory } from './recovery.js';
import { PendingApprovalManager } from './pending.js';
import { SessionGate } from './gate.js';
import { EventStore } from '../events/store.js';
import { classifyRisk } from '../events/classifier.js';
import { extractAccess } from '../events/access-extractor.js';
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
  PermissionDeniedInput,
  SetupInput,
  ConfigChangeInput,
  InstructionsLoadedInput,
  TaskCreatedInput,
  TaskCompletedInput,
  TeammateIdleInput,
  WorktreeCreateInput,
  WorktreeRemoveInput,
  CwdChangedInput,
  FileChangedInput,
  StatusLineInput,
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

// Sessions where the next Stop response should be suppressed.
// Set when /layman is called on an already-active session so the
// "Layman is now monitoring..." reply doesn't overwrite meaningful
// work history in the dashboard LatestOutput display.
const suppressNextResponse = new Set<string>();

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
          rawAgentType === 'opencode' ? 'opencode'
          : rawAgentType === 'codex' ? 'codex'
          : 'claude-code';
        const opencodeUrl = (body as { opencode_url?: string }).opencode_url;

        // Gate check: detect activation command before gating so we can activate
        if (sessionId && eventName === 'PreToolUse') {
          const toolName = (body as { tool_name?: string }).tool_name;
          const toolInput = (body as { tool_input?: Record<string, unknown> }).tool_input;
          // 'Bash' = Claude Code/Cline; 'shell' = Codex
          if ((toolName === 'Bash' || toolName === 'shell') && toolInput) {
            const command = (toolInput as { command?: string }).command ?? '';
            if (ACTIVATION_PATTERN.test(command)) {
              const isNewActivation = gate.activate(sessionId);
              if (cwd) eventStore.trackSession(sessionId, cwd, agentType, opencodeUrl);

              // Recover events from before /layman was run.
              // Safe to await: Claude Code is blocked on this PreToolUse response,
              // so no hook events can race in until we return.
              // Only runs on the first activation — gate.activate() returns false
              // for subsequent calls, preventing duplicate injection in-memory.
              if (isNewActivation) {
                const transcriptPath = (body as { transcript_path?: string }).transcript_path;
                if (transcriptPath) {
                  try {
                    const count = await recoverPreActivationHistory(
                      transcriptPath, sessionId, agentType, eventStore
                    );
                    if (count > 0) {
                      console.log(`[recovery] Recovered ${count} pre-activation events for session ${sessionId.slice(0, 8)}`);
                    }
                  } catch {
                    // Non-fatal — activation proceeds even if recovery fails
                  }
                }
              } else {
                // Re-activation on an already-active session. The upcoming Stop hook
                // would emit the "Layman is now monitoring..." response, which would
                // replace meaningful work history in the dashboard LatestOutput. Suppress it.
                suppressNextResponse.add(sessionId);
              }

              return reply.send({});
            }
          }
        }

        // Codex activation: detect @layman in UserPromptSubmit before the gate drops it.
        // When the user types @layman, activate the session immediately so all subsequent
        // hook events (the skill's tool calls, Stop response, etc.) are captured.
        // This fires before the gate check below, so it works even on the very first event.
        if (sessionId && eventName === 'UserPromptSubmit' && agentType === 'codex') {
          const prompt = ((body as { prompt?: string }).prompt ?? '').trim();
          if (/^\$layman\b/i.test(prompt)) {
            const isNewActivation = gate.activate(sessionId);
            if (cwd) eventStore.trackSession(sessionId, cwd, agentType);
            if (isNewActivation) {
              console.log(`[codex] Session ${sessionId.slice(0, 8)} activated via $layman`);
            }
            // Fall through — record the user_prompt event so @layman appears in the timeline
          }
        }

        // Auto-activate: if configured per-client, activate session on any event without /layman
        if (sessionId && !gate.isActive(sessionId)) {
          const config = getConfig();
          if (config.autoActivateClients.includes(agentType)) {
            const isNewActivation = gate.activate(sessionId);
            if (cwd) eventStore.trackSession(sessionId, cwd, agentType, opencodeUrl);
            if (isNewActivation) {
              console.log(`[auto-activate] Session ${sessionId.slice(0, 8)} activated for ${agentType}`);
              // Recover pre-activation history
              const transcriptPath = (body as { transcript_path?: string }).transcript_path;
              if (transcriptPath) {
                try {
                  const count = await recoverPreActivationHistory(
                    transcriptPath, sessionId, agentType, eventStore
                  );
                  if (count > 0) {
                    console.log(`[recovery] Recovered ${count} pre-activation events for session ${sessionId.slice(0, 8)}`);
                  }
                } catch { /* non-fatal */ }
              }
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
          // Phase 3: New hook events
          case 'PermissionDenied': {
            await handlePermissionDenied(body as unknown as PermissionDeniedInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'Setup': {
            await handleSetup(body as unknown as SetupInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'ConfigChange': {
            await handleConfigChange(body as unknown as ConfigChangeInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'InstructionsLoaded': {
            await handleInstructionsLoaded(body as unknown as InstructionsLoadedInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'TaskCreated': {
            await handleTaskCreated(body as unknown as TaskCreatedInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'TaskCompleted': {
            await handleTaskCompleted(body as unknown as TaskCompletedInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'TeammateIdle': {
            await handleTeammateIdle(body as unknown as TeammateIdleInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'WorktreeCreate': {
            await handleWorktreeCreate(body as unknown as WorktreeCreateInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'WorktreeRemove': {
            await handleWorktreeRemove(body as unknown as WorktreeRemoveInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'CwdChanged': {
            await handleCwdChanged(body as unknown as CwdChangedInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          case 'FileChanged': {
            await handleFileChanged(body as unknown as FileChangedInput, eventStore, agentType);
            return reply.status(200).send({});
          }
          // Phase 4: StatusLine
          case 'StatusLine': {
            await handleStatusLine(body as unknown as StatusLineInput, eventStore, agentType);
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
    config.autoApprove === 'all' ||
    (config.autoApprove === 'medium' && (riskLevel === 'low' || riskLevel === 'medium')) ||
    (config.autoApprove === 'low' && riskLevel === 'low') ||
    (config.autoAllow.readOnly && AUTO_ALLOW_TOOLS.has(input.tool_name)) ||
    isAutoAllowedByPattern(input.tool_name, input.tool_input, config.autoAllow.trustedCommands);

  const shouldAnalyze =
    config.autoAnalyze === 'all' ||
    (config.autoAnalyze === 'medium' && riskLevel !== 'low') ||
    (config.autoAnalyze === 'high' && riskLevel === 'high');

  const shouldExplain =
    config.autoExplain === 'all' ||
    (config.autoExplain === 'medium' && riskLevel !== 'low') ||
    (config.autoExplain === 'high' && riskLevel === 'high');

  if (shouldAutoAllow) {
    // Record event but don't block
    const approvedEvent = eventStore.add('tool_call_approved', input.session_id, {
      toolName: input.tool_name,
      toolInput: input.tool_input,
    }, riskLevel, agentType);

    // Trigger analysis/explain for auto-approved events too
    if (shouldAnalyze && shouldExplain) {
      void triggerAnalysis(input, approvedEvent.id, eventStore, analysisEngine, pendingManager, config)
        .then(() => triggerLaymans(input, approvedEvent.id, eventStore, analysisEngine, config, config.autoExplainDepth));
    } else {
      if (shouldAnalyze) {
        void triggerAnalysis(input, approvedEvent.id, eventStore, analysisEngine, pendingManager, config);
      }
      if (shouldExplain) {
        void triggerLaymans(input, approvedEvent.id, eventStore, analysisEngine, config, config.autoExplainDepth);
      }
    }

    return {};
  }

  // Add pending event to timeline
  const timelineEvent = eventStore.add('tool_call_pending', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
  }, riskLevel, agentType);

  if (shouldAnalyze && shouldExplain) {
    // Run explain after analysis so it can benefit from the analysis result
    void triggerAnalysis(input, timelineEvent.id, eventStore, analysisEngine, pendingManager, config)
      .then(() => triggerLaymans(input, timelineEvent.id, eventStore, analysisEngine, config, config.autoExplainDepth));
  } else {
    if (shouldAnalyze) {
      void triggerAnalysis(input, timelineEvent.id, eventStore, analysisEngine, pendingManager, config);
    }
    if (shouldExplain) {
      void triggerLaymans(input, timelineEvent.id, eventStore, analysisEngine, config, config.autoExplainDepth);
    }
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
      depth: config.autoAnalyzeDepth,
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
  } catch {
    // Analysis failure doesn't block approval
  }
}

async function triggerLaymans(
  input: PreToolUseInput,
  eventId: string,
  eventStore: EventStore,
  analysisEngine: AnalysisEngine,
  config: LaymanConfig,
  depth: 'quick' | 'detailed' = 'quick'
): Promise<void> {
  try {
    const result = await analysisEngine.laymans(
      {
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        depth,
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
  const access = extractAccess(input.tool_name, input.tool_input, input.tool_output, '', completedAt);

  if (pendingEvent && pendingEvent.type !== 'tool_call_completed') {
    eventStore.updateType(pendingEvent.id, 'tool_call_completed');
    eventStore.updateData(pendingEvent.id, {
      toolOutput: input.tool_output,
      completedAt,
      fileAccess: access.files.length > 0 ? access.files.map(f => ({ ...f, eventId: pendingEvent.id })) : undefined,
      urlAccess: access.urls.length > 0 ? access.urls.map(u => ({ ...u, eventId: pendingEvent.id })) : undefined,
    });
    if (access.files.length > 0 || access.urls.length > 0) {
      eventStore.recordAccess(
        input.session_id,
        access.files.map(f => ({ ...f, eventId: pendingEvent.id })),
        access.urls.map(u => ({ ...u, eventId: pendingEvent.id }))
      );
    }
  } else {
    const filesWithId = access.files.length > 0 ? access.files : undefined;
    const urlsWithId = access.urls.length > 0 ? access.urls : undefined;
    const event = eventStore.add('tool_call_completed', input.session_id, {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolOutput: input.tool_output,
      completedAt,
      fileAccess: filesWithId,
      urlAccess: urlsWithId,
    }, undefined, agentType);
    // Patch eventIds now that we have the real event id
    if (filesWithId) filesWithId.forEach(f => f.eventId = event.id);
    if (urlsWithId) urlsWithId.forEach(u => u.eventId = event.id);
    if (filesWithId || urlsWithId) {
      eventStore.recordAccess(input.session_id, filesWithId ?? [], urlsWithId ?? []);
    }
  }
}

async function handlePostToolUseFailure(
  input: PostToolUseFailureInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  const now = Date.now();
  const access = extractAccess(input.tool_name, input.tool_input, undefined, '', now);
  const filesWithId = access.files.length > 0 ? access.files : undefined;
  const urlsWithId = access.urls.length > 0 ? access.urls : undefined;

  const event = eventStore.add('tool_call_failed', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
    error: input.tool_error,
    fileAccess: filesWithId,
    urlAccess: urlsWithId,
  }, undefined, agentType);

  if (filesWithId) filesWithId.forEach(f => f.eventId = event.id);
  if (urlsWithId) urlsWithId.forEach(u => u.eventId = event.id);
  if (filesWithId || urlsWithId) {
    eventStore.recordAccess(input.session_id, filesWithId ?? [], urlsWithId ?? []);
  }
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
    permissionRequestType: input.permission_request_type,
    permissionSuggestions: input.permission_suggestions,
  }, riskLevel, agentType);

  const shouldAnalyze =
    config.autoAnalyze === 'all' ||
    (config.autoAnalyze === 'medium' && riskLevel !== 'low') ||
    (config.autoAnalyze === 'high' && riskLevel === 'high');

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
    prompt: input.message || input.title,
  }, undefined, agentType);
}

async function handleSessionStart(
  input: SessionStartInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('session_start', input.session_id, {
    source: input.source,
    model: input.model,
    permissionMode: input.permission_mode,
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

  // Codex provides the agent's final response text directly in last_assistant_message.
  // Use it directly instead of parsing a transcript file.
  if (input.last_assistant_message) {
    eventStore.add('agent_response', input.session_id, { prompt: input.last_assistant_message }, undefined, agentType);
    return;
  }

  // If /layman was called on an already-active session, suppress emitting the
  // "Layman is now monitoring..." response so it doesn't displace real work history
  // in the dashboard LatestOutput. Advance the watermark so the next Stop works normally.
  if (suppressNextResponse.has(input.session_id)) {
    suppressNextResponse.delete(input.session_id);
    transcriptWatermarks.delete(input.transcript_path);
    await initTranscriptWatermark(input.transcript_path);
    return;
  }

  // Emit the final assistant response (and any intermediate messages not yet emitted).
  // The transcript file may not be flushed yet when Stop fires, so retry after a short
  // delay if the first read finds nothing new.
  const emitted = await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);
  if (!emitted) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);
  }
}

/** Remap host ~/.claude or ~/.codex path to container-mounted /root/... path */
function remapTranscriptPath(hostPath: string): string {
  const claudeMatch = hostPath.match(/\.claude\/(.+)$/);
  if (claudeMatch) return `/root/.claude/${claudeMatch[1]}`;
  const codexMatch = hostPath.match(/\.codex\/(.+)$/);
  if (codexMatch) return `/root/.codex/${codexMatch[1]}`;
  return hostPath;
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
  // Suppress emission while a /layman re-activation is in flight.
  // handleStop (or handleUserPromptSubmit as a fallback) will advance the
  // watermark past the layman response once the turn completes.
  if (suppressNextResponse.has(sessionId)) {
    return false;
  }

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
  // Safety valve: if a /layman re-activation's Stop hook never fired, the suppression
  // flag may still be set when the next user prompt arrives. Consume it here and advance
  // the watermark so the layman response is skipped and future turns work normally.
  if (suppressNextResponse.has(input.session_id)) {
    suppressNextResponse.delete(input.session_id);
    transcriptWatermarks.delete(input.transcript_path);
    await initTranscriptWatermark(input.transcript_path);
  } else {
    // Catch-up: emit any assistant messages from the previous turn that weren't captured
    // by Stop (e.g. if the transcript wasn't flushed in time). This ensures responses
    // appear in the timeline before the next user prompt.
    await emitNewAssistantMessages(input.transcript_path, input.session_id, eventStore, agentType);
  }

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
  // When /layman re-activates, the subagent's "Layman is now monitoring..." message
  // should not be stored — it would displace real work history from the dashboard.
  const prompt = suppressNextResponse.has(input.session_id)
    ? undefined
    : (input.last_assistant_message ?? undefined);
  eventStore.add('subagent_stop', input.session_id, {
    agentType: input.agent_type,
    prompt,
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
    errorDetails: input.error_details,
    prompt: input.last_assistant_message ?? undefined,
  }, undefined, agentType);
}

async function handlePreCompact(
  input: PreCompactInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('pre_compact', input.session_id, {
    compactTrigger: input.trigger,
    compactCustomInstructions: input.custom_instructions,
  }, undefined, agentType);
}

async function handlePostCompact(
  input: PostCompactInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('post_compact', input.session_id, {
    compactTrigger: input.trigger,
    compactSummary: input.compact_summary,
  }, undefined, agentType);
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

// Phase 3: New hook event handlers

async function handlePermissionDenied(
  input: PermissionDeniedInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('permission_denied', input.session_id, {
    toolName: input.tool_name,
    toolInput: input.tool_input,
    reason: input.reason,
  }, undefined, agentType);
}

async function handleSetup(
  input: SetupInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('setup', input.session_id, {
    setupTrigger: input.trigger,
  }, undefined, agentType);
}

async function handleConfigChange(
  input: ConfigChangeInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('config_change', input.session_id, {
    configSource: input.source,
    filePath: input.file_path,
  }, undefined, agentType);
}

async function handleInstructionsLoaded(
  input: InstructionsLoadedInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('instructions_loaded', input.session_id, {
    filePath: input.file_path,
    memoryType: input.memory_type,
    loadReason: input.load_reason,
  }, undefined, agentType);
}

async function handleTaskCreated(
  input: TaskCreatedInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('task_created', input.session_id, {
    taskId: input.task_id,
    taskSubject: input.task_subject,
    taskDescription: input.task_description,
  }, undefined, agentType);
}

async function handleTaskCompleted(
  input: TaskCompletedInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('task_completed', input.session_id, {
    taskId: input.task_id,
    taskSubject: input.task_subject,
  }, undefined, agentType);
}

async function handleTeammateIdle(
  input: TeammateIdleInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('teammate_idle', input.session_id, {
    teammateName: input.teammate_name,
    teamName: input.team_name,
  }, undefined, agentType);
}

async function handleWorktreeCreate(
  input: WorktreeCreateInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('worktree_create', input.session_id, {
    worktreeName: input.name,
  }, undefined, agentType);
}

async function handleWorktreeRemove(
  input: WorktreeRemoveInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('worktree_remove', input.session_id, {
    worktreePath: input.worktree_path,
  }, undefined, agentType);
}

async function handleCwdChanged(
  input: CwdChangedInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('cwd_changed', input.session_id, {
    oldCwd: input.old_cwd,
    newCwd: input.new_cwd,
  }, undefined, agentType);
}

async function handleFileChanged(
  input: FileChangedInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('file_changed', input.session_id, {
    filePath: input.file_path,
    fileEvent: input.event,
  }, undefined, agentType);
}

// Phase 4: StatusLine handler

async function handleStatusLine(
  input: StatusLineInput,
  eventStore: EventStore,
  agentType: string = 'claude-code'
): Promise<void> {
  eventStore.add('session_metrics', input.session_id, {
    modelId: input.model?.id,
    modelDisplayName: input.model?.display_name,
    costUsd: input.cost?.total_cost_usd,
    durationMs: input.cost?.total_duration_ms,
    apiDurationMs: input.cost?.total_api_duration_ms,
    linesAdded: input.cost?.total_lines_added,
    linesRemoved: input.cost?.total_lines_removed,
    totalInputTokens: input.context_window?.total_input_tokens,
    totalOutputTokens: input.context_window?.total_output_tokens,
    contextWindowSize: input.context_window?.context_window_size,
    currentInputTokens: input.context_window?.current_usage?.input_tokens,
    currentOutputTokens: input.context_window?.current_usage?.output_tokens,
    cacheReadTokens: input.context_window?.current_usage?.cache_read_input_tokens,
    cacheCreationTokens: input.context_window?.current_usage?.cache_creation_input_tokens,
    contextUsedPct: input.context_window?.used_percentage,
    contextRemainingPct: input.context_window?.remaining_percentage,
    exceeds200kTokens: input.exceeds_200k_tokens,
    rateLimit5hrPct: input.rate_limits?.five_hour?.used_percentage,
    rateLimit5hrResetsAt: input.rate_limits?.five_hour?.resets_at,
    rateLimit7dayPct: input.rate_limits?.seven_day?.used_percentage,
    rateLimit7dayResetsAt: input.rate_limits?.seven_day?.resets_at,
    sessionName: input.session_name,
    claudeCodeVersion: input.version,
  }, undefined, agentType);
}

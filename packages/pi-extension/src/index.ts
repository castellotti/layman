/**
 * Layman extension for pi (https://pi.dev).
 *
 * This file is installed **verbatim** to `~/.pi/agent/extensions/layman/index.ts`,
 * where pi auto-discovers it and loads it through jiti — no build step, no
 * `node_modules` beside it. Two consequences shape everything below:
 *
 *  1. **No imports.** Not even `import type`. A type import from
 *     `@earendil-works/pi-coding-agent` is erased by jiti and would work at
 *     runtime, but it would also make `pnpm -r typecheck` depend on a package
 *     this repo does not (and should not) install. The pi API surface we use is
 *     therefore restated structurally below, transcribed from
 *     `packages/coding-agent/src/core/extensions/types.ts` in pi 0.84.2.
 *     Structural typing means pi's real objects satisfy these declarations; if
 *     pi changes a shape, the mismatch shows up in manual testing rather than
 *     at compile time, which is the price of not vendoring the dependency.
 *
 *  2. **Single file.** The installer's content-hash machinery
 *     (`installOptionalClientCommands` / `getStatus`) tracks exactly one file
 *     per client, which is what gives install / update-available / uninstall
 *     detection for free. Splitting this into modules would need a parallel
 *     directory-copy path like `installCodexHooks()`.
 *
 * The guiding constraint: **a dead Layman server must never break pi.** Every
 * network call is fire-and-forget with a timeout, and no handler may throw.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The installer rewrites `__LAYMAN_URL__` to the configured hook URL as it
 * copies this file. The literal placeholder survives only when the file is read
 * straight from the repo, so anything that is not a URL means "not templated".
 */
const INSTALLED_URL = '__LAYMAN_URL__';
const LAYMAN_URL =
  process.env.LAYMAN_URL ||
  (INSTALLED_URL.startsWith('http') ? INSTALLED_URL : 'http://localhost:8880');

/** Fire-and-forget posts get a short timeout; nothing waits on them. */
const POST_TIMEOUT_MS = 5000;

/**
 * Shutdown is the one place a post is awaited, so its timeout is much shorter.
 *
 * `post()` returning immediately is what keeps a slow Layman from stalling pi —
 * but at shutdown the process exits before an un-awaited fetch is ever flushed,
 * which loses the SessionEnd event entirely. Awaiting it costs a round trip
 * (~2 ms locally); this ceiling bounds what a *hung* server can add to pi's
 * exit. A delayed exit is a worse failure than a missing end event, so it is
 * kept well under a second.
 */
const SHUTDOWN_TIMEOUT_MS = 800;

/**
 * Ceiling on how long a tool call may wait for an approval decision.
 *
 * The installer templates Layman's configured `hookTimeout` in here, plus a
 * margin — the server resolves its own pending approval on that timeout and
 * answers, so this is only a backstop for a server that has stopped answering
 * at all. A *dead* server does not reach this: the connection is refused
 * immediately and the call proceeds unblocked.
 */
const INSTALLED_TIMEOUT_MS = '__LAYMAN_TIMEOUT_MS__';
const APPROVAL_TIMEOUT_MS = Number(INSTALLED_TIMEOUT_MS) || 310_000;

// ---------------------------------------------------------------------------
// pi API surface (structural; see the file header for why this is not imported)
// ---------------------------------------------------------------------------

interface TextContent {
  type: 'text';
  text: string;
}

interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  redacted?: boolean;
}

interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface AssistantMessage {
  role: 'assistant';
  content: AssistantContent[];
  provider: string;
  model: string;
  usage: Usage;
  stopReason: string;
  errorMessage?: string;
}

/** Any message pi surfaces; only the assistant variant carries content we read. */
type AgentMessage = AssistantMessage | { role: 'user' | 'toolResult' | string };

interface SessionStartEvent {
  type: 'session_start';
  reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  previousSessionFile?: string;
}

interface SessionShutdownEvent {
  type: 'session_shutdown';
  reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork';
  targetSessionFile?: string;
}

interface SessionInfoChangedEvent {
  type: 'session_info_changed';
  name: string | undefined;
}

type CompactReason = 'manual' | 'threshold' | 'overflow';

interface SessionBeforeCompactEvent {
  type: 'session_before_compact';
  reason: CompactReason;
  willRetry: boolean;
}

interface SessionCompactEvent {
  type: 'session_compact';
  reason: CompactReason;
  fromExtension: boolean;
  willRetry: boolean;
}

interface InputEvent {
  type: 'input';
  text: string;
  source: 'interactive' | 'rpc' | 'extension';
  streamingBehavior?: 'steer' | 'followUp';
}

type InputEventResult =
  | { action: 'continue' }
  | { action: 'transform'; text: string }
  | { action: 'handled' };

interface ToolCallEvent {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

interface ToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: Array<TextContent | { type: 'image' }>;
  isError: boolean;
  usage?: Usage;
}

interface MessageStartEvent {
  type: 'message_start';
  message: AgentMessage;
}

interface MessageEndEvent {
  type: 'message_end';
  message: AgentMessage;
}

/**
 * pi's streaming event. Thinking and text are distinct variants with distinct
 * content indices — the cleanest reasoning separation of any harness Layman
 * supports, and the reason no tag parsing is needed anywhere in this file.
 *
 * pi's own `AssistantMessageEvent` type also has `start`, `done` and `error`
 * variants. They are deliberately absent here: the agent core turns them into
 * the `message_start` / `message_end` extension events and does not forward
 * them to `message_update`. Listing them would invite handling events that
 * never arrive — which is exactly the bug this comment exists to prevent.
 */
type AssistantMessageEvent =
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_start'; contentIndex: number }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number };

interface MessageUpdateEvent {
  type: 'message_update';
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}

interface AgentSettledEvent {
  type: 'agent_settled';
}

interface TurnEndEvent {
  type: 'turn_end';
  turnIndex: number;
  message: AgentMessage;
}

interface Model {
  id: string;
  name: string;
  contextWindow: number;
}

interface ModelSelectEvent {
  type: 'model_select';
  model: Model;
  previousModel: Model | undefined;
  source: 'set' | 'cycle' | 'restore';
}

interface ThinkingLevelSelectEvent {
  type: 'thinking_level_select';
  level: string;
  previousLevel: string;
}

interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

interface ReadonlySessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
}

interface ExtensionUIContext {
  notify(message: string, level?: 'info' | 'warn' | 'error'): void;
}

interface ExtensionContext {
  ui: ExtensionUIContext;
  cwd: string;
  sessionManager: ReadonlySessionManager;
  model: Model | undefined;
  thinkingLevel?: string;
  isIdle(): boolean;
  getContextUsage(): ContextUsage | undefined;
  /** The current agent abort signal, or undefined when not streaming. */
  signal: AbortSignal | undefined;
}

interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
}

type Handler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

/** A prompt queued in Layman, waiting to be injected into this session. */
interface PendingPrompt {
  id: string;
  sessionId: string;
  prompt: string;
}

interface ExtensionAPI {
  on(event: 'session_start', handler: Handler<SessionStartEvent>): void;
  on(event: 'session_shutdown', handler: Handler<SessionShutdownEvent>): void;
  on(event: 'session_info_changed', handler: Handler<SessionInfoChangedEvent>): void;
  on(event: 'session_before_compact', handler: Handler<SessionBeforeCompactEvent>): void;
  on(event: 'session_compact', handler: Handler<SessionCompactEvent>): void;
  on(event: 'input', handler: Handler<InputEvent, InputEventResult>): void;
  on(event: 'tool_call', handler: Handler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: 'tool_result', handler: Handler<ToolResultEvent>): void;
  on(event: 'message_start', handler: Handler<MessageStartEvent>): void;
  on(event: 'message_end', handler: Handler<MessageEndEvent>): void;
  on(event: 'message_update', handler: Handler<MessageUpdateEvent>): void;
  on(event: 'agent_settled', handler: Handler<AgentSettledEvent>): void;
  on(event: 'turn_end', handler: Handler<TurnEndEvent>): void;
  on(event: 'model_select', handler: Handler<ModelSelectEvent>): void;
  on(event: 'thinking_level_select', handler: Handler<ThinkingLevelSelectEvent>): void;

  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
  ): void;

  /** Inject a user message. Always triggers a turn. */
  sendUserMessage(
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp'; expandPromptTemplates?: boolean },
  ): void;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * POST a hook payload to Layman without ever propagating a failure into pi.
 *
 * Deliberately not awaited by callers: a hook handler that blocks on the
 * network would stall the TUI whenever Layman is slow or gone.
 */
async function sendPost(
  eventName: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  try {
    await fetch(`${LAYMAN_URL}/hooks/${eventName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Layman is not running, or is slow. pi carries on regardless.
  }
}

function post(eventName: string, body: Record<string, unknown>): void {
  void sendPost(eventName, body, POST_TIMEOUT_MS);
}

/** The subset of Layman's PreToolUse response the extension acts on. */
interface PreToolUseResponse {
  hookSpecificOutput?: {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
  };
}

/**
 * POST and wait for Layman's answer, returning null if there isn't one.
 *
 * Used only for `tool_call`, the one event whose response changes what pi does.
 * Every failure mode — server down, server slow, user pressed Esc — resolves to
 * null, which the caller reads as "proceed". A monitoring tool that can wedge
 * the agent it monitors is worse than no monitoring, so "unsure" always means
 * "allow" here.
 */
async function postAwait(
  eventName: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  agentSignal: AbortSignal | undefined,
): Promise<PreToolUseResponse | null> {
  // Esc in the TUI aborts the agent signal; joining it to the timeout means a
  // pending approval can be cancelled from pi rather than only from Layman.
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (agentSignal) signals.push(agentSignal);

  try {
    const res = await fetch(`${LAYMAN_URL}/hooks/${eventName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // AbortSignal.any is Node 20+; pi requires a newer runtime than that.
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    if (!res.ok) return null;
    return (await res.json()) as PreToolUseResponse;
  } catch {
    return null;
  }
}

/**
 * The fields `packages/server/src/hooks/handler.ts` reads off every payload.
 * `agent_type: 'pi'` is what routes these events to the pi arm of the
 * agent-type allow-list — without it they would be recorded as claude-code.
 *
 * `transcript_path` is deliberately empty even though pi has a session file.
 * Layman only knows how to parse claude-code's transcript format, and it uses
 * that path for two things — pre-activation history recovery and the fallback
 * response read in `handleStop` — both of which would silently find nothing in
 * pi's tree-structured JSONL. Sending `''` states that outright instead of
 * relying on a failed read. OpenCode's plugin does the same. Importing pi's
 * session format is a separate feature.
 */
function basePayload(ctx: ExtensionContext, eventName: string): Record<string, unknown> {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    hook_event_name: eventName,
    transcript_path: '',
    permission_mode: 'default',
    agent_type: 'pi',
  };
}

/**
 * pi names its tools in lowercase; Layman's risk classifier and its read-only
 * auto-allow list are keyed on claude-code's PascalCase names. Anything not
 * listed (a tool registered by another extension) passes through unchanged and
 * is simply classified on its own merits.
 *
 * `find` maps to `Glob` rather than to a literal `Find`: pi's find searches for
 * files by pattern, which is what Layman treats as `Glob`, and that membership
 * is what makes it auto-allowable as read-only.
 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
};

function mapToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

/** Flatten pi's content-part array to the plain text Layman stores. */
function textOf(content: Array<TextContent | { type: string }>): string {
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

/**
 * Split an assistant message into what it said and what it thought.
 *
 * pi is the only harness Layman supports that separates these at the protocol
 * level — every other one inlines reasoning into the response text and needs
 * the `<thinking>`-tag heuristics in `events/agent-content.ts`. Populating
 * `data.thinking` directly means `getEffectiveAgentContent()` takes its
 * pre-split branch and never runs those heuristics on pi output.
 */
function splitAssistantContent(message: AssistantMessage): { text: string; thinking: string } {
  let text = '';
  let thinking = '';
  for (const part of message.content) {
    if (part.type === 'text') text += part.text;
    else if (part.type === 'thinking' && !part.redacted) thinking += part.thinking;
  }
  return { text, thinking };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * pi has no StatusLine equivalent, so session metrics are synthesised into the
 * shape `handleStatusLine` already understands rather than given a parallel
 * handler.
 *
 * That shape is claude-code's, where the token and cost totals are *cumulative
 * for the session*. pi reports `usage` per assistant message, so the running
 * totals have to be kept here. They are session-scoped state, reset whenever a
 * session starts — `/new`, `/resume` and `/fork` all fire `session_start`, and
 * carrying the previous session's totals across one would silently inflate
 * every number in the bar.
 */
interface SessionTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function zeroTotals(): SessionTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/**
 * Flush the pending stream buffer after this long, or once this many characters
 * have accumulated, whichever comes first.
 *
 * A local model on fast hardware emits far quicker than either the network or a
 * browser repaint is worth spending on, so deltas are coalesced here at the
 * source. The server coalesces again before broadcasting; batching at both ends
 * keeps one fast producer from saturating every connected dashboard.
 */
const STREAM_FLUSH_MS = 100;
const STREAM_FLUSH_CHARS = 256;

/** How often to check Layman for a prompt submitted from the dashboard. */
const PROMPT_POLL_MS = 2000;

export default function laymanExtension(pi: ExtensionAPI): void {
  let totals = zeroTotals();
  /** Latest per-turn usage, for the "current" fields in the metrics payload. */
  let lastUsage: Usage | undefined;

  // --- Live streaming state (session-scoped; timers start on demand) ---------
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingText = '';
  let pendingThinking = '';
  let streamMessageId = '';
  let streamSeq = 0;

  function clearStreamTimer(): void {
    if (streamTimer === undefined) return;
    clearTimeout(streamTimer);
    streamTimer = undefined;
  }

  function flushStream(ctx: ExtensionContext, done = false): void {
    clearStreamTimer();
    // A `done` flush still has to go out with nothing pending — it is what ends
    // the live row on the dashboard.
    if (!done && !pendingText && !pendingThinking) return;

    const body: Record<string, unknown> = {
      ...basePayload(ctx, 'StreamDelta'),
      message_id: streamMessageId,
      seq: streamSeq++,
    };
    if (pendingText) body.text_delta = pendingText;
    if (pendingThinking) body.thinking_delta = pendingThinking;
    if (ctx.model) body.model = ctx.model.name;
    if (done) body.done = true;

    pendingText = '';
    pendingThinking = '';
    post('StreamDelta', body);
  }

  function scheduleFlush(ctx: ExtensionContext): void {
    if (pendingText.length + pendingThinking.length >= STREAM_FLUSH_CHARS) {
      flushStream(ctx);
      return;
    }
    if (streamTimer !== undefined) return;
    streamTimer = setTimeout(() => flushStream(ctx), STREAM_FLUSH_MS);
    // Housekeeping must never be the reason pi's process stays alive.
    streamTimer.unref?.();
  }

  /** Begin buffering for a new assistant message, discarding any stale partial. */
  function beginStream(messageId: string): void {
    clearStreamTimer();
    pendingText = '';
    pendingThinking = '';
    streamMessageId = messageId;
    streamSeq = 0;
  }

  // --- Prompt relay ----------------------------------------------------------

  let promptTimer: ReturnType<typeof setInterval> | undefined;
  /** Guards against two overlapping polls injecting the same prompt twice. */
  let promptInFlight = false;

  function clearPromptTimer(): void {
    if (promptTimer === undefined) return;
    clearInterval(promptTimer);
    promptTimer = undefined;
  }

  async function pollForPrompt(ctx: ExtensionContext): Promise<void> {
    if (promptInFlight) return;
    // Injecting mid-turn would steer the agent rather than ask it something,
    // which is not what submitting a prompt from a dashboard means. The prompt
    // stays queued and lands on the next poll after the turn ends.
    if (!ctx.isIdle()) return;

    promptInFlight = true;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const res = await fetch(
        `${LAYMAN_URL}/api/prompts/pending?sessionIds=${encodeURIComponent(sessionId)}`,
        { signal: AbortSignal.timeout(POST_TIMEOUT_MS) },
      );
      if (!res.ok) return;

      const queued = (await res.json()) as PendingPrompt | null;
      if (!queued?.id || !queued.prompt) return;

      // Dequeue *before* injecting: a crash between the two loses one prompt,
      // whereas the other order re-injects it on every poll forever.
      await fetch(`${LAYMAN_URL}/api/prompts/pending/${queued.id}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      }).catch(() => {});

      pi.sendUserMessage(queued.prompt);
    } catch {
      // Layman is unreachable. Nothing to inject; try again next tick.
    } finally {
      promptInFlight = false;
    }
  }

  function statusLinePayload(ctx: ExtensionContext): Record<string, unknown> {
    const usage = ctx.getContextUsage();
    const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
    const usedPct = usage?.percent ?? undefined;

    return {
      ...basePayload(ctx, 'StatusLine'),
      session_name: ctx.sessionManager.getSessionName(),
      model: ctx.model ? { id: ctx.model.id, display_name: ctx.model.name } : undefined,
      thinking_level: ctx.thinkingLevel,
      cost: { total_cost_usd: totals.cost },
      context_window: {
        total_input_tokens: totals.input,
        total_output_tokens: totals.output,
        context_window_size: contextWindow,
        current_usage: lastUsage
          ? {
              input_tokens: lastUsage.input,
              output_tokens: lastUsage.output,
              cache_read_input_tokens: lastUsage.cacheRead,
              cache_creation_input_tokens: lastUsage.cacheWrite,
            }
          : null,
        used_percentage: usedPct,
        remaining_percentage: usedPct === undefined ? undefined : 100 - usedPct,
      },
    };
  }

  function postStatusLine(ctx: ExtensionContext): void {
    post('StatusLine', statusLinePayload(ctx));
  }
  // Nothing here starts a timer, a socket, or a watcher: pi runs extension
  // factories in invocations that never start a session (`pi --list-models`,
  // for one), and a background resource started here would leak in those.
  // Session-scoped resources start in `session_start` and are torn down in
  // `session_shutdown`.

  pi.on('session_start', (event, ctx) => {
    totals = zeroTotals();
    lastUsage = undefined;

    // Background resources start here, never in the factory: pi runs extension
    // factories in invocations that never open a session (`pi --list-models`
    // among them), and a timer started there would leak in every one of those.
    clearPromptTimer();
    promptTimer = setInterval(() => void pollForPrompt(ctx), PROMPT_POLL_MS);
    promptTimer.unref?.();

    post('SessionStart', {
      ...basePayload(ctx, 'SessionStart'),
      source: event.reason,
    });
  });

  pi.on('session_shutdown', async (event, ctx) => {
    // Idempotent teardown of everything session_start (or a delta) may have
    // started. A shutdown mid-generation would otherwise leave both a live
    // timer and a stream the dashboard thinks is still running.
    clearStreamTimer();
    clearPromptTimer();
    flushStream(ctx, true);

    // Awaited, unlike every other post: pi is about to exit, and an
    // un-awaited fetch never leaves the process. See SHUTDOWN_TIMEOUT_MS.
    await sendPost(
      'SessionEnd',
      { ...basePayload(ctx, 'SessionEnd'), reason: event.reason },
      SHUTDOWN_TIMEOUT_MS,
    );
  });

  pi.on('session_info_changed', (event, ctx) => {
    if (!event.name) return;
    post('StatusLine', { ...basePayload(ctx, 'StatusLine'), session_name: event.name });
  });

  // --- Session metrics -------------------------------------------------------

  pi.on('turn_end', (event, ctx) => {
    if (isAssistantMessage(event.message)) {
      const usage = event.message.usage;
      lastUsage = usage;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.cost += usage.cost.total;
    }
    postStatusLine(ctx);
  });

  // Model and reasoning level are part of the metrics payload, so a change to
  // either has to re-emit it — otherwise the bar keeps showing the old model
  // until the next turn ends.
  pi.on('model_select', (_event, ctx) => postStatusLine(ctx));
  pi.on('thinking_level_select', (_event, ctx) => postStatusLine(ctx));

  // --- Prompts ---------------------------------------------------------------

  pi.on('input', (event, ctx) => {
    // Every source is recorded, not just "interactive". A prompt submitted from
    // the Layman dashboard arrives here as source "extension", and dropping
    // those would make dashboard-submitted prompts invisible in the very
    // timeline that submitted them. `/layman` does not reach this handler at
    // all — pi dispatches extension commands before the input event.
    post('UserPromptSubmit', { ...basePayload(ctx, 'UserPromptSubmit'), prompt: event.text });
    return { action: 'continue' as const };
  });

  // --- Tools -----------------------------------------------------------------

  pi.on('tool_call', async (event, ctx) => {
    // This is the only handler that awaits Layman, because it is the only one
    // whose answer changes what pi does. Whether Layman is *allowed* to suspend
    // the call is the server's decision, not ours: it knows the current
    // `approvalClients` setting and returns immediately when pi is not in it.
    // Keeping the decision server-side means toggling the setting takes effect
    // on the next tool call without restarting pi.
    const response = await postAwait(
      'PreToolUse',
      {
        ...basePayload(ctx, 'PreToolUse'),
        tool_name: mapToolName(event.toolName),
        tool_input: event.input,
        tool_call_id: event.toolCallId,
      },
      APPROVAL_TIMEOUT_MS,
      ctx.signal,
    );

    const decision = response?.hookSpecificOutput;
    if (decision?.permissionDecision === 'deny') {
      return {
        block: true,
        reason: decision.permissionDecisionReason ?? 'Denied in Layman.',
      };
    }
    // Anything else — allow, ask, no response at all — proceeds. "ask" cannot
    // be honoured here: pi has no permission prompt of its own to defer to.
  });

  pi.on('tool_result', (event, ctx) => {
    const eventName = event.isError ? 'PostToolUseFailure' : 'PostToolUse';
    const text = textOf(event.content);
    post(eventName, {
      ...basePayload(ctx, eventName),
      tool_name: mapToolName(event.toolName),
      tool_input: event.input,
      tool_call_id: event.toolCallId,
      ...(event.isError ? { tool_error: text } : { tool_output: text }),
    });
  });

  // --- Assistant output ------------------------------------------------------

  // --- Live token streaming --------------------------------------------------

  let messageCounter = 0;

  /**
   * A stream is bracketed by `message_start` / `message_end`, **not** by the
   * `start` / `done` variants of `assistantMessageEvent`.
   *
   * Those two variants exist in pi's stream protocol type, but the agent core
   * consumes them to produce the `message_start` and `message_end` extension
   * events and does not forward them: subscribing to `message_update` on
   * pi 0.84.2 yields only `{thinking,text,toolcall}_{start,delta,end}`. Relying
   * on `done` meant the live row was never closed and the accumulated buffer was
   * never reset between the several assistant messages in one turn — it looked
   * like it worked, because deltas still accumulated, and only the missing
   * `stream:end` gave it away.
   */
  pi.on('message_start', (event) => {
    if (!isAssistantMessage(event.message)) return;
    // pi exposes no stable id for an in-flight message, and the server only
    // needs to know when one message gives way to the next.
    beginStream(`pi-${Date.now()}-${++messageCounter}`);
  });

  pi.on('message_update', (event, ctx) => {
    const update = event.assistantMessageEvent;

    if (update.type === 'thinking_delta') {
      pendingThinking += update.delta;
      scheduleFlush(ctx);
      return;
    }
    if (update.type === 'text_delta') {
      pendingText += update.delta;
      scheduleFlush(ctx);
      return;
    }
    // `*_start` only marks a phase the deltas already imply, `*_end` repeats
    // content already streamed, and `toolcall_*` is covered by `tool_call`.
  });

  pi.on('message_end', (event, ctx) => {
    if (!isAssistantMessage(event.message)) return;

    // Close the live row first. The committed agent_response below is what
    // replaces it, so ending the stream after would briefly show both.
    flushStream(ctx, true);

    const { text, thinking } = splitAssistantContent(event.message);
    // A message that is nothing but tool calls has no prose to record.
    if (!text && !thinking) return;

    post('AgentResponse', {
      ...basePayload(ctx, 'AgentResponse'),
      response: text,
      thinking,
    });
  });

  pi.on('agent_settled', (_event, ctx) => {
    // `agent_settled`, not `agent_end`: pi may still auto-retry, auto-compact,
    // or drain a queued follow-up after `agent_end`, and treating that as the
    // end of the turn would emit a premature Stop and mis-pair the transcript.
    post('Stop', basePayload(ctx, 'Stop'));
  });

  // --- Compaction ------------------------------------------------------------

  // pi distinguishes three compaction triggers; Layman's model has two, and
  // both of pi's automatic triggers ("threshold" and "overflow") are "auto".
  pi.on('session_before_compact', (event, ctx) => {
    post('PreCompact', {
      ...basePayload(ctx, 'PreCompact'),
      trigger: event.reason === 'manual' ? 'manual' : 'auto',
    });
  });

  pi.on('session_compact', (event, ctx) => {
    post('PostCompact', {
      ...basePayload(ctx, 'PostCompact'),
      trigger: event.reason === 'manual' ? 'manual' : 'auto',
    });
  });

  pi.registerCommand('layman', {
    description: 'Activate Layman monitoring for this session',
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();

      // Unlike the other harnesses, pi has a real activation path: extension
      // commands are dispatched before the `input` event, so /layman never
      // reaches the LLM and we can call the gate directly instead of smuggling
      // an `echo layman:activate` through a bash tool call.
      let reachable = false;
      try {
        const res = await fetch(`${LAYMAN_URL}/api/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        reachable = res.ok;
      } catch {
        reachable = false;
      }

      if (!reachable) {
        ctx.ui.notify(
          `Layman is not reachable at ${LAYMAN_URL}. Start it and run /layman again.`,
          'warn',
        );
        return;
      }

      // The SessionStart fired at pi startup was dropped by the gate, which was
      // still closed. Re-send it so the session appears in the dashboard with
      // its cwd immediately rather than on the next tool call.
      post('SessionStart', { ...basePayload(ctx, 'SessionStart'), source: 'startup' });

      ctx.ui.notify(`Layman is now monitoring this session — ${LAYMAN_URL}`, 'info');
    },
  });
}

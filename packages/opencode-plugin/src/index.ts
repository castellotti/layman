import { translateToolBefore, translateToolAfter } from './translator.js';
import { postToLayman } from './poster.js';
import { spawn } from 'child_process';

const LAYMAN_URL = process.env.LAYMAN_URL ?? 'http://localhost:8880';
const POLL_INTERVAL_MS = 2000;

// Probe candidate ports to find a running OpenCode HTTP server URL.
// Only relevant when OpenCode was started with an explicit --port flag.
async function detectOpenCodeUrl(): Promise<string | null> {
  const candidates = ['http://localhost:4096', 'http://127.0.0.1:4096'];
  for (const url of candidates) {
    try {
      const res = await fetch(`${url}/session`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) return url;
    } catch {
      // not reachable
    }
  }
  return null;
}

// Submit a prompt to an existing session via `opencode run --session <id>`.
// This works even when the TUI is running without an external HTTP server.
// Uses async spawn so the plugin worker isn't blocked waiting for the AI response.
function submitViaRun(sessionId: string, cwd: string, prompt: string): void {
  try {
    const child = spawn(
      'opencode',
      ['run', '--session', sessionId, '--dir', cwd, prompt],
      { stdio: 'ignore', detached: true }
    );
    child.unref();
  } catch {
    // ignore spawn errors
  }
}

// OpenCode Plugin — sends events to the Layman monitoring dashboard.
// Load via opencode.json:
//   { "plugin": ["~/path/to/opencode-layman-plugin"] }
export default async function LaymanPlugin(ctx: { directory: string }) {
  const { directory } = ctx;

  // Detect the OpenCode server URL once at startup (only set when started with --port).
  const openCodeUrl = await detectOpenCodeUrl();

  // Track session IDs and their cwds seen so far (for prompt relay).
  const knownSessions = new Map<string, string>(); // sessionId → cwd
  // Track sessions currently being processed (to avoid concurrent runs for same session).
  const inProgress = new Set<string>();

  // Track the latest text for each assistant message (keyed by messageID).
  const messageText = new Map<string, { sessionID: string; text: string }>();

  /**
   * Streaming bookkeeping, keyed `sessionID:messageID[:partID]`.
   *
   * `partText` holds the last value seen for each streaming part. OpenCode's
   * `part.text` is the **whole accumulated text so far**, not a delta — a fresh
   * `message.part.updated` carries everything already sent plus the new tokens
   * — and Layman's stream channel takes deltas, so the suffix has to be
   * computed against the previous value. It is keyed per *part*, not per
   * message, because one message holds several text and reasoning parts that
   * grow independently.
   *
   * Both are keyed by session first so a whole turn can be swept with a prefix
   * match, which is what removes the need for a separate message→session index.
   */
  const partText = new Map<string, string>();

  /** Monotonic sequence per message, so Layman can drop replays and reorderings. */
  const streamSeq = new Map<string, number>();

  function nextSeq(sessionID: string, messageID: string): number {
    const key = `${sessionID}:${messageID}`;
    const seq = (streamSeq.get(key) ?? -1) + 1;
    streamSeq.set(key, seq);
    return seq;
  }

  /** Drop every key under a prefix. Deleting while iterating a Map is defined. */
  function forgetPrefix(prefix: string): void {
    streamSeq.delete(prefix);
    for (const key of partText.keys()) {
      if (key.startsWith(`${prefix}:`)) partText.delete(key);
    }
  }

  /** Forget a finished message's streaming bookkeeping. */
  function endStream(sessionID: string, messageID: string): void {
    void postToLayman(LAYMAN_URL, 'StreamDelta', {
      session_id: sessionID,
      cwd: directory,
      hook_event_name: 'StreamDelta',
      transcript_path: '',
      permission_mode: 'default',
      agent_type: 'opencode',
      message_id: messageID,
      seq: nextSeq(sessionID, messageID),
      done: true,
    });
    forgetPrefix(`${sessionID}:${messageID}`);
  }

  /**
   * Drop the streaming bookkeeping for every message of a finished turn.
   *
   * `endStream()` only runs on a terminal `step-finish`, so a message that is
   * aborted, errors, or whose last step is a tool call never reaches one — and
   * `partText` holds each part's *whole* accumulated text, not a delta, inside
   * a worker that lives as long as the OpenCode session. `session.idle` means
   * the turn is over and no part can grow again, so whatever is still here is
   * garbage. `messageText` is deliberately left alone: it is the payload the
   * terminal `step-finish` posts as the agent response, and idle is not
   * ordered against it.
   */
  function forgetSessionStreams(sessionID: string): void {
    for (const key of streamSeq.keys()) {
      if (key.startsWith(`${sessionID}:`)) streamSeq.delete(key);
    }
    for (const key of partText.keys()) {
      if (key.startsWith(`${sessionID}:`)) partText.delete(key);
    }
  }

  // Start polling Layman for pending prompts.
  // The plugin runs inside the OpenCode Bun Worker, so `setInterval` works here.
  setInterval(() => {
    if (knownSessions.size === 0) return;
    const sessionIds = [...knownSessions.keys()].join(',');

    void (async () => {
      try {
        const res = await fetch(
          `${LAYMAN_URL}/api/prompts/pending?sessionIds=${encodeURIComponent(sessionIds)}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (!res.ok) return;
        const data = await res.json() as { id?: string; sessionId?: string; prompt?: string } | null;
        if (!data?.id || !data.sessionId || !data.prompt) return;

        const { id, sessionId, prompt } = data;
        const cwd = knownSessions.get(sessionId);
        if (!cwd) return;

        // Acknowledge dequeue immediately so we don't process it twice.
        await fetch(`${LAYMAN_URL}/api/prompts/pending/${id}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});

        if (inProgress.has(sessionId)) return;
        inProgress.add(sessionId);

        try {
          let ok = false;

          // If OpenCode has an HTTP server, use it directly (faster, no subprocess).
          if (openCodeUrl) {
            const httpRes = await fetch(
              `${openCodeUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(cwd)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
                signal: AbortSignal.timeout(5000),
              }
            ).catch(() => null);
            ok = httpRes?.ok ?? false;
          }

          // Fallback: spawn `opencode run --session <id>` as a subprocess.
          if (!ok) {
            submitViaRun(sessionId, cwd, prompt);
          }
        } finally {
          inProgress.delete(sessionId);
        }
      } catch {
        // Network errors are expected if Layman isn't running
      }
    })();
  }, POLL_INTERVAL_MS);

  return {
    'chat.message': async (
      input: { sessionID: string; agent?: string; messageID?: string },
      output: { message: unknown; parts: Array<{ type: string; text?: string }> }
    ) => {
      const text = output.parts
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text)
        .join('');
      if (!text) return;

      knownSessions.set(input.sessionID, directory);

      void postToLayman(LAYMAN_URL, 'UserPromptSubmit', {
        session_id: input.sessionID,
        cwd: directory,
        hook_event_name: 'UserPromptSubmit',
        transcript_path: '',
        permission_mode: 'default',
        agent_type: 'opencode',
        prompt: text,
        opencode_url: openCodeUrl ?? undefined,
      });
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown }
    ) => {
      knownSessions.set(input.sessionID, directory);
      const payload = translateToolBefore(input, output, directory);
      void postToLayman(LAYMAN_URL, 'PreToolUse', payload);
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown }
    ) => {
      knownSessions.set(input.sessionID, directory);
      const payload = translateToolAfter(input, output, directory);
      void postToLayman(LAYMAN_URL, 'PostToolUse', payload);
    },

    event: async ({ event }: { event: { type: string; properties: Record<string, unknown> } }) => {
      const { type, properties } = event;

      if (type === 'message.part.updated') {
        const part = properties.part as {
          id?: string;
          type: string;
          sessionID?: string;
          messageID?: string;
          text?: string;
          reason?: string;
        } | undefined;
        if (!part?.sessionID || !part?.messageID) return;

        if (part.sessionID) knownSessions.set(part.sessionID, directory);

        if (part.type === 'text' && part.text) {
          messageText.set(part.messageID, { sessionID: part.sessionID, text: part.text });
        }

        // Live streaming. `reasoning` is OpenCode's separate part type for
        // model reasoning — verified against @opencode-ai/sdk, where
        // ReasoningPart is `{ type: "reasoning"; text: string; … }`, the same
        // shape as TextPart. Both accumulate, so we send the suffix.
        if ((part.type === 'text' || part.type === 'reasoning') && part.text !== undefined) {
          const key = `${part.sessionID}:${part.messageID}:${part.id ?? part.type}`;
          const previous = partText.get(key) ?? '';
          const delta = part.text.startsWith(previous)
            ? part.text.slice(previous.length)
            // A part that did not grow from what we last saw was rewritten
            // rather than extended; resend it whole rather than emit a
            // nonsensical suffix.
            : part.text;
          partText.set(key, part.text);

          if (delta) {
            void postToLayman(LAYMAN_URL, 'StreamDelta', {
              session_id: part.sessionID,
              cwd: directory,
              hook_event_name: 'StreamDelta',
              transcript_path: '',
              permission_mode: 'default',
              agent_type: 'opencode',
              message_id: part.messageID,
              seq: nextSeq(part.sessionID, part.messageID),
              ...(part.type === 'reasoning' ? { thinking_delta: delta } : { text_delta: delta }),
            });
          }
        }

        if (part.type === 'step-finish' && part.reason !== 'tool-calls' && part.reason !== 'tool_use') {
          endStream(part.sessionID, part.messageID);
          const accumulated = messageText.get(part.messageID);
          if (accumulated?.text) {
            void postToLayman(LAYMAN_URL, 'AgentResponse', {
              session_id: accumulated.sessionID,
              cwd: directory,
              hook_event_name: 'AgentResponse',
              transcript_path: '',
              permission_mode: 'default',
              agent_type: 'opencode',
              response: accumulated.text,
            });
            messageText.delete(part.messageID);
          }
        }
        return;
      }

      if (type === 'session.created') {
        const info = properties.info as { id?: string } | undefined;
        const sessionId = info?.id;
        if (!sessionId) return;
        knownSessions.set(sessionId, directory);
        void postToLayman(LAYMAN_URL, 'SessionStart', {
          session_id: sessionId,
          cwd: directory,
          hook_event_name: 'SessionStart',
          transcript_path: '',
          permission_mode: 'default',
          agent_type: 'opencode',
          source: 'startup',
          opencode_url: openCodeUrl ?? undefined,
        });
      }

      if (type === 'session.deleted') {
        const info = properties.info as { id?: string } | undefined;
        const sessionId = info?.id;
        if (!sessionId) return;
        knownSessions.delete(sessionId);
        forgetSessionStreams(sessionId);
        void postToLayman(LAYMAN_URL, 'SessionEnd', {
          session_id: sessionId,
          cwd: directory,
          hook_event_name: 'SessionEnd',
          transcript_path: '',
          permission_mode: 'default',
          agent_type: 'opencode',
        });
      }

      if (type === 'session.idle') {
        const sessionId = properties.sessionID as string | undefined;
        if (!sessionId) return;
        forgetSessionStreams(sessionId);
        void postToLayman(LAYMAN_URL, 'Stop', {
          session_id: sessionId,
          cwd: directory,
          hook_event_name: 'Stop',
          transcript_path: '',
          permission_mode: 'default',
          agent_type: 'opencode',
        });
      }
    },
  };
}

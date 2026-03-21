import { translateToolBefore, translateToolAfter } from './translator.js';
import { postToLayman } from './poster.js';
import { spawnSync } from 'child_process';

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
function submitViaRun(sessionId: string, cwd: string, prompt: string): boolean {
  try {
    const result = spawnSync(
      'opencode',
      ['run', '--session', sessionId, '--dir', cwd, prompt],
      { timeout: 300_000, stdio: 'ignore' }
    );
    return result.status === 0;
  } catch {
    return false;
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

  // Start polling Layman for pending prompts.
  // The plugin runs inside the OpenCode Bun Worker, so `setInterval` works here.
  const pollTimer = setInterval(() => {
    if (knownSessions.size === 0) return;
    const sessionIds = [...knownSessions.keys()].join(',');

    void (async () => {
      try {
        const res = await fetch(
          `${LAYMAN_URL}/api/opencode/pending-prompt?sessionIds=${encodeURIComponent(sessionIds)}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (!res.ok) return;
        const data = await res.json() as { id?: string; sessionId?: string; prompt?: string } | null;
        if (!data?.id || !data.sessionId || !data.prompt) return;

        const { id, sessionId, prompt } = data;
        const cwd = knownSessions.get(sessionId);
        if (!cwd) return;

        // Acknowledge dequeue immediately so we don't process it twice.
        await fetch(`${LAYMAN_URL}/api/opencode/pending-prompt/${id}`, {
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

  // Don't hold the Node.js event loop open just for polling.
  if (pollTimer.unref) pollTimer.unref();

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

        if (part.type === 'step-finish' && part.reason !== 'tool-calls' && part.reason !== 'tool_use') {
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

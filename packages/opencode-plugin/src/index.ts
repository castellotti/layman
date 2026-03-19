import { translateToolBefore, translateToolAfter } from './translator.js';
import { postToLayman } from './poster.js';

const LAYMAN_URL = process.env.LAYMAN_URL ?? 'http://localhost:8090';

// OpenCode Plugin — sends events to the Layman monitoring dashboard.
// Load via opencode.json:
//   { "plugin": ["~/path/to/opencode-layman-plugin"] }
export default async function LaymanPlugin(ctx: { directory: string }) {
  const { directory } = ctx;

  // Track the latest text for each assistant message (keyed by messageID)
  const messageText = new Map<string, { sessionID: string; text: string }>();

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
      void postToLayman(LAYMAN_URL, 'UserPromptSubmit', {
        session_id: input.sessionID,
        cwd: directory,
        hook_event_name: 'UserPromptSubmit',
        transcript_path: '',
        permission_mode: 'default',
        agent_type: 'opencode',
        prompt: text,
      });
    },

    'tool.execute.before': async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: unknown }
    ) => {
      const payload = translateToolBefore(input, output, directory);
      void postToLayman(LAYMAN_URL, 'PreToolUse', payload);
    },

    'tool.execute.after': async (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown }
    ) => {
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
        void postToLayman(LAYMAN_URL, 'SessionStart', {
          session_id: sessionId,
          cwd: directory,
          hook_event_name: 'SessionStart',
          transcript_path: '',
          permission_mode: 'default',
          agent_type: 'opencode',
          source: 'startup',
        });
      }

      if (type === 'session.deleted') {
        const info = properties.info as { id?: string } | undefined;
        const sessionId = info?.id;
        if (!sessionId) return;
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

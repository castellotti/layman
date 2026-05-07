/**
 * Open WebUI hook handler — accepts events from the Layman filter function
 * installed into Open WebUI and translates them into Layman's event pipeline.
 *
 * Open WebUI calls the filter's inlet hook before sending to the model (user prompt)
 * and the outlet hook after receiving a response (agent response). Both POST JSON
 * to this endpoint with an `event` discriminator field.
 *
 * Sessions are identified by chat_id. There is no activation gate — all events
 * from Open WebUI are recorded automatically (equivalent to auto-activate).
 */

import type { FastifyInstance } from 'fastify';
import { EventStore } from '../events/store.js';
import { SessionGate } from '../hooks/gate.js';
import type { Database } from '../db/database.js';
import type { OpenWebUIHookInput } from './translator.js';
import { translateUserPromptSubmit, translateSessionStart } from './translator.js';

const AGENT_TYPE = 'open-webui';

export function registerOpenWebUIHookHandler(
  fastify: FastifyInstance,
  eventStore: EventStore,
  gate: SessionGate,
  db: Database,
): void {
  // Seed from DB so a server restart doesn't re-emit session_start for existing chats
  let knownSessions = new Set<string>();
  try {
    const rows = db.prepare(
      'SELECT session_id FROM recorded_sessions WHERE agent_type = ?'
    ).all(AGENT_TYPE) as Array<{ session_id: string }>;
    knownSessions = new Set(rows.map((r) => r.session_id));
  } catch { /* non-fatal: empty set means existing sessions re-emit session_start once */ }

  fastify.post<{ Body: OpenWebUIHookInput }>(
    '/hooks/openwebui',
    async (request, reply) => {
      const body = request.body;

      try {
        const chatId = body.chat_id;
        if (!chatId) return reply.status(400).send({ error: 'chat_id required' });

        eventStore.trackSession(chatId, '', AGENT_TYPE);

        // Emit session_start and activate the first time we see a chat_id
        if (!knownSessions.has(chatId)) {
          knownSessions.add(chatId);
          gate.activate(chatId);
          const startInput = translateSessionStart(body);
          eventStore.add('session_start', startInput.session_id, { source: startInput.source }, undefined, AGENT_TYPE);
        }

        switch (body.event) {
          case 'UserPromptSubmit': {
            const input = translateUserPromptSubmit(body);
            eventStore.add('user_prompt', input.session_id, { prompt: input.prompt }, undefined, AGENT_TYPE);
            break;
          }
          case 'AgentResponse': {
            if (body.response || body.thinking) {
              eventStore.add('agent_response', chatId, {
                prompt: body.response,
                thinking: body.thinking,
              }, undefined, AGENT_TYPE);
            }
            break;
          }
          case 'WebSearch': {
            const sources = (body.sources ?? []).map((s) => ({
              url: s.url,
              hostname: s.hostname,
              title: s.title,
              ...(s.content != null ? { content: s.content } : {}),
            }));
            eventStore.add('web_search', chatId, {
              webSearchQueries: body.queries?.length ? body.queries : undefined,
              webSearchSources: sources.length ? sources : undefined,
            }, undefined, AGENT_TYPE);
            break;
          }
          default:
            return reply.status(400).send({ error: `Unknown Open WebUI event: ${(body as { event: string }).event}` });
        }

        return reply.status(200).send({});
      } catch (err) {
        request.log.error(err, 'Error handling Open WebUI hook');
        return reply.status(200).send({});
      }
    }
  );
}

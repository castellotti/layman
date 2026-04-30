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
import type { OpenWebUIHookInput } from './translator.js';
import { translateUserPromptSubmit, translateSessionStart } from './translator.js';

const AGENT_TYPE = 'open-webui';

/** chat_ids we've already emitted session_start for, to avoid duplicates. */
const knownSessions = new Set<string>();

export function registerOpenWebUIHookHandler(
  fastify: FastifyInstance,
  eventStore: EventStore,
  gate: SessionGate,
): void {
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
            if (body.response) {
              eventStore.add('agent_response', chatId, { prompt: body.response }, undefined, AGENT_TYPE);
            }
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

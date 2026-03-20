import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { PendingApprovalManager } from './hooks/pending.js';
import { EventStore } from './events/store.js';
import { registerHookHandler } from './hooks/handler.js';
import { AnalysisEngine } from './analysis/engine.js';
import { resolveEndpoint } from './analysis/providers/openai-compat.js';
import { updateConfig, saveConfig } from './config/config.js';
import type { LaymanConfig } from './config/schema.js';
import type { ServerMessage, ClientMessage, SessionStatus } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LaymanServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number;
}

export function createServer(config: LaymanConfig): LaymanServer {
  const fastify = Fastify({
    logger: {
      level: 'warn',
    },
  });

  const eventStore = new EventStore();
  const pendingManager = new PendingApprovalManager(config.hookTimeout);
  const analysisEngine = new AnalysisEngine(config.analysis);
  const startTime = Date.now();

  let activeConfig = config;
  const getConfig = (): LaymanConfig => activeConfig;

  // Track connected WebSocket clients (@fastify/websocket v10: handler arg is the socket directly)
  const wsClients = new Set<{ readyState: number; send: (data: string) => void }>();

  function broadcast(message: ServerMessage): void {
    const json = JSON.stringify(message);
    for (const client of wsClients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(json);
      }
    }
  }

  // Forward store events to WebSocket
  eventStore.on('event:new', (event) => {
    broadcast({ type: 'event:new', event });
  });

  eventStore.on('sessions:changed', (sessions) => {
    broadcast({ type: 'sessions:list', sessions });
  });

  eventStore.on('event:update', (event) => {
    broadcast({ type: 'event:update', eventId: event.id, updates: event });
  });

  // Forward pending manager events to WebSocket
  pendingManager.on('pending:new', (approval) => {
    broadcast({
      type: 'approval:pending',
      approval: {
        id: approval.id,
        eventName: approval.eventName,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
        timestamp: approval.timestamp,
        analysis: approval.analysis,
      },
    });
  });

  pendingManager.on('pending:updated', (approval) => {
    // Re-send the approval with updated analysis
    broadcast({
      type: 'approval:pending',
      approval: {
        id: approval.id,
        eventName: approval.eventName,
        toolName: approval.toolName,
        toolInput: approval.toolInput,
        timestamp: approval.timestamp,
        analysis: approval.analysis,
      },
    });
  });

  pendingManager.on('pending:resolved', (approvalId, decision) => {
    broadcast({ type: 'approval:resolved', approvalId, decision });
  });

  async function registerPlugins(): Promise<void> {
    await fastify.register(cors, {
      origin: true,
      credentials: true,
    });

    await fastify.register(websocket);

    // Serve static web UI
    const webDistPath = join(__dirname, '..', '..', '..', 'web-dist');
    const fallbackPath = join(__dirname, '..', 'web-dist');

    const staticPath = existsSync(webDistPath)
      ? webDistPath
      : existsSync(fallbackPath)
        ? fallbackPath
        : null;

    if (staticPath) {
      await fastify.register(staticPlugin, {
        root: staticPath,
        prefix: '/',
        decorateReply: true,
      });
    }
  }

  function registerRoutes(): void {
    // Health check
    fastify.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }));

    // Status
    fastify.get('/api/status', async (): Promise<SessionStatus> => {
      return {
        connected: true,
        pendingCount: pendingManager.size,
        eventCount: eventStore.size,
        uptime: Math.floor((Date.now() - startTime) / 1000),
      };
    });

    // Events
    fastify.get<{ Querystring: { offset?: string; limit?: string } }>(
      '/api/events',
      async (request) => {
        const offset = parseInt(request.query.offset ?? '0', 10);
        const limit = parseInt(request.query.limit ?? '50', 10);
        return {
          events: eventStore.getPage(offset, Math.min(limit, 200)),
          total: eventStore.size,
          offset,
          limit,
        };
      }
    );

    fastify.get<{ Params: { id: string } }>('/api/events/:id', async (request, reply) => {
      const event = eventStore.get(request.params.id);
      if (!event) return reply.status(404).send({ error: 'Event not found' });
      return event;
    });

    // Pending approvals
    fastify.get('/api/pending', async () => {
      return { pending: pendingManager.getPendingDTO() };
    });

    fastify.post<{
      Params: { id: string };
      Body: { decision: 'allow' | 'deny' | 'ask'; reason?: string; updatedInput?: Record<string, unknown> };
    }>('/api/pending/:id/decide', async (request, reply) => {
      const { id } = request.params;
      const { decision, reason, updatedInput } = request.body;

      const resolved = pendingManager.resolveApproval(id, { decision, reason, updatedInput });
      if (!resolved) {
        return reply.status(404).send({ error: 'Approval not found or already resolved' });
      }
      return { ok: true };
    });

    // Config
    fastify.get('/api/config', async () => {
      return activeConfig;
    });

    fastify.post<{ Body: Partial<LaymanConfig> }>('/api/config', async (request) => {
      activeConfig = updateConfig(request.body);
      analysisEngine.configure(activeConfig.analysis);
      pendingManager.setHookTimeout(activeConfig.hookTimeout);
      saveConfig(activeConfig);
      broadcast({ type: 'session:config', config: activeConfig });
      return activeConfig;
    });

    // Analysis
    fastify.post<{
      Params: { eventId: string };
      Body: { depth?: 'quick' | 'detailed' };
    }>('/api/analysis/:eventId', async (request, reply) => {
      const event = eventStore.get(request.params.eventId);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      const depth = request.body.depth ?? 'quick';
      try {
        broadcast({ type: 'analysis:start', eventId: event.id });
        const result = await analysisEngine.analyze({
          toolName: event.data.toolName ?? 'Unknown',
          toolInput: event.data.toolInput ?? {},
          toolOutput: event.data.toolOutput,
          cwd: process.cwd(),
          depth,
        });
        eventStore.attachAnalysis(event.id, result);
        broadcast({ type: 'analysis:result', eventId: event.id, result });
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'analysis:error', eventId: event.id, error: errorMsg });
        return reply.status(500).send({ error: errorMsg });
      }
    });

    fastify.post<{
      Params: { eventId: string };
      Body: { question: string };
    }>('/api/analysis/:eventId/ask', async (request, reply) => {
      const event = eventStore.get(request.params.eventId);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      try {
        const result = await analysisEngine.ask(request.body.question, {
          toolName: event.data.toolName ?? 'Unknown',
          toolInput: event.data.toolInput ?? {},
          toolOutput: event.data.toolOutput,
          previousAnalysis: event.analysis,
          cwd: process.cwd(),
        });
        return { answer: result.text, tokens: result.tokens, latencyMs: result.latencyMs, model: result.model };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: errorMsg });
      }
    });

    // Model discovery — proxies /v1/models from the configured OpenAI-compatible endpoint.
    // Accepts an optional ?endpoint= override so the UI can probe before saving.
    fastify.get<{ Querystring: { endpoint?: string } }>('/api/models', async (request, reply) => {
      const rawEndpoint = request.query.endpoint ?? activeConfig.analysis.endpoint;
      if (!rawEndpoint) {
        return reply.status(400).send({ error: 'No endpoint configured. Set an endpoint URL first.' });
      }

      const endpoint = resolveEndpoint(rawEndpoint.replace(/\/+$/, ''));
      const modelsUrl = endpoint.endsWith('/v1') ? `${endpoint}/models` : `${endpoint}/v1/models`;

      try {
        const res = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${activeConfig.analysis.apiKey ?? 'not-needed'}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return reply.status(res.status).send({ error: `Models endpoint returned HTTP ${res.status}` });
        }
        const data = await res.json() as { data?: { id: string }[] } | { models?: { id?: string; name?: string }[] };
        // Normalise: OpenAI format { data: [{id}] } or Ollama { models: [{name}] }
        const ids: string[] =
          'data' in data && Array.isArray(data.data)
            ? data.data.map((m) => m.id)
            : 'models' in data && Array.isArray(data.models)
              ? data.models.map((m) => m.id ?? m.name ?? '').filter(Boolean)
              : [];
        return { models: ids };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ error: `Could not reach ${modelsUrl}: ${msg}` });
      }
    });

    // Shutdown
    fastify.post('/api/shutdown', async (_request, reply) => {
      reply.send({ ok: true });
      setImmediate(() => {
        void fastify.close();
        process.exit(0);
      });
    });

    // WebSocket — @fastify/websocket v10: handler receives (socket, request) directly
    fastify.register(async (wsInstance) => {
      wsInstance.get('/ws', { websocket: true }, (socket) => {
        const ws = socket as unknown as {
          readyState: number;
          send: (data: string) => void;
          on: (event: string, handler: (...args: unknown[]) => void) => void;
        };

        wsClients.add(ws);

        // Send initial state
        ws.send(JSON.stringify({
          type: 'connected',
          serverVersion: '0.1.0',
          eventCount: eventStore.size,
        } satisfies ServerMessage));

        // Send current config
        ws.send(JSON.stringify({
          type: 'session:config',
          config: activeConfig,
        } satisfies ServerMessage));

        // Send recent events (last 100)
        const recentEvents = eventStore.getPage(
          Math.max(0, eventStore.size - 100),
          100
        );
        for (const event of recentEvents) {
          ws.send(JSON.stringify({ type: 'event:new', event } satisfies ServerMessage));
        }

        // Send pending approvals
        for (const approval of pendingManager.getPendingDTO()) {
          ws.send(JSON.stringify({ type: 'approval:pending', approval } satisfies ServerMessage));
        }

        // Send current sessions list
        ws.send(JSON.stringify({
          type: 'sessions:list',
          sessions: eventStore.getSessions(),
        } satisfies ServerMessage));

        ws.on('message', (data: unknown) => {
          try {
            const message = JSON.parse(String(data)) as ClientMessage;
            handleClientMessage(message);
          } catch {
            // Ignore malformed messages
          }
        });

        ws.on('close', () => {
          wsClients.delete(ws);
        });
      });
    });
  }

  function handleClientMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'approval:decide': {
        pendingManager.resolveApproval(message.approvalId, message.decision);
        break;
      }
      case 'analysis:request': {
        const event = eventStore.get(message.eventId);
        if (!event) break;

        void (async () => {
          try {
            broadcast({ type: 'analysis:start', eventId: message.eventId });
            const result = await analysisEngine.analyze({
              toolName: event.data.toolName ?? 'Unknown',
              toolInput: event.data.toolInput ?? {},
              toolOutput: event.data.toolOutput,
              cwd: process.cwd(),
              depth: message.depth,
            });
            eventStore.attachAnalysis(message.eventId, result);
            broadcast({ type: 'analysis:result', eventId: message.eventId, result });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'analysis:error', eventId: message.eventId, error: errorMsg });
          }
        })();
        break;
      }
      case 'laymans:request': {
        const event = eventStore.get(message.eventId);
        if (!event) break;

        void (async () => {
          try {
            broadcast({ type: 'laymans:start', eventId: message.eventId });
            const result = await analysisEngine.laymans(
              {
                toolName: event.data.toolName ?? 'Unknown',
                toolInput: event.data.toolInput ?? {},
                toolOutput: event.data.toolOutput,
                cwd: process.cwd(),
                depth: message.depth,
              },
              activeConfig.laymansPrompt,
            );
            eventStore.attachLaymans(message.eventId, result);
            broadcast({ type: 'laymans:result', eventId: message.eventId, result });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'laymans:error', eventId: message.eventId, error: errorMsg });
          }
        })();
        break;
      }
      case 'both:request': {
        const event = eventStore.get(message.eventId);
        if (!event) break;

        // Fire both laymans and analysis in parallel
        void (async () => {
          try {
            broadcast({ type: 'laymans:start', eventId: message.eventId });
            const result = await analysisEngine.laymans(
              {
                toolName: event.data.toolName ?? 'Unknown',
                toolInput: event.data.toolInput ?? {},
                toolOutput: event.data.toolOutput,
                cwd: process.cwd(),
                depth: message.depth,
              },
              activeConfig.laymansPrompt,
            );
            eventStore.attachLaymans(message.eventId, result);
            broadcast({ type: 'laymans:result', eventId: message.eventId, result });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'laymans:error', eventId: message.eventId, error: errorMsg });
          }
        })();
        void (async () => {
          try {
            broadcast({ type: 'analysis:start', eventId: message.eventId });
            const result = await analysisEngine.analyze({
              toolName: event.data.toolName ?? 'Unknown',
              toolInput: event.data.toolInput ?? {},
              toolOutput: event.data.toolOutput,
              cwd: process.cwd(),
              depth: message.depth,
            });
            eventStore.attachAnalysis(message.eventId, result);
            broadcast({ type: 'analysis:result', eventId: message.eventId, result });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            broadcast({ type: 'analysis:error', eventId: message.eventId, error: errorMsg });
          }
        })();
        break;
      }
      case 'analysis:ask': {
        const event = eventStore.get(message.eventId);
        if (!event) break;

        void (async () => {
          try {
            const result = await analysisEngine.ask(message.question, {
              toolName: event.data.toolName ?? 'Unknown',
              toolInput: event.data.toolInput ?? {},
              toolOutput: event.data.toolOutput,
              previousAnalysis: event.analysis,
              cwd: process.cwd(),
            });
            // Send answer back as analysis result with answer field
            broadcast({
              type: 'analysis:result',
              eventId: message.eventId,
              result: {
                ...(event.analysis ?? {
                  meaning: '',
                  goal: '',
                  safety: { level: 'safe' as const, summary: '' },
                  security: { level: 'safe' as const, summary: '' },
                  risk: { level: 'low' as const, summary: '' },
                  model: '',
                  latencyMs: 0,
                  tokens: { input: 0, output: 0 },
                }),
                // Embed the answer in meaning field for display
                meaning: result.text,
              },
            });
          } catch {
            // Ignore analysis ask errors
          }
        })();
        break;
      }
      case 'config:update': {
        activeConfig = updateConfig(message.config);
        analysisEngine.configure(activeConfig.analysis);
        pendingManager.setHookTimeout(activeConfig.hookTimeout);
        saveConfig(activeConfig);
        broadcast({ type: 'session:config', config: activeConfig });
        break;
      }
    }
  }

  // Register hook handler routes
  registerHookHandler(fastify, pendingManager, eventStore, analysisEngine, getConfig);

  let resolvedPort = config.port;

  return {
    async start() {
      await registerPlugins();
      registerRoutes();

      // Try ports sequentially if default is taken
      for (let portAttempt = config.port; portAttempt <= config.port + 9; portAttempt++) {
        try {
          await fastify.listen({ port: portAttempt, host: config.host });
          resolvedPort = portAttempt;
          if (portAttempt !== config.port) {
            console.log(`Port ${config.port} in use, using port ${portAttempt}`);
          }
          break;
        } catch (err) {
          if (portAttempt === config.port + 9) throw err;
          await fastify.close();
        }
      }
    },

    async stop() {
      await fastify.close();
    },

    getPort() {
      return resolvedPort;
    },
  };
}

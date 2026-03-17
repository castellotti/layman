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
import { updateConfig } from './config/config.js';
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

  // Track connected WebSocket clients
  const wsClients = new Set<ReturnType<typeof fastify.websocketServer.clients.values> extends IterableIterator<infer T> ? T : never>();

  function broadcast(message: ServerMessage): void {
    const json = JSON.stringify(message);
    for (const client of wsClients) {
      if ((client as { readyState: number }).readyState === 1) {
        (client as { send: (data: string) => void }).send(json);
      }
    }
  }

  // Forward store events to WebSocket
  eventStore.on('event:new', (event) => {
    broadcast({ type: 'event:new', event });
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
        const answer = await analysisEngine.ask(request.body.question, {
          toolName: event.data.toolName ?? 'Unknown',
          toolInput: event.data.toolInput ?? {},
          toolOutput: event.data.toolOutput,
          previousAnalysis: event.analysis,
          cwd: process.cwd(),
        });
        return { answer };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: errorMsg });
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

    // WebSocket
    fastify.register(async (wsInstance) => {
      wsInstance.get('/ws', { websocket: true }, (connection) => {
        const socket = connection.socket as unknown as {
          readyState: number;
          send: (data: string) => void;
          on: (event: string, handler: (data: Buffer) => void) => void;
          close: () => void;
        };

        wsClients.add(socket as Parameters<typeof wsClients.add>[0]);

        // Send initial state
        const connected: ServerMessage = {
          type: 'connected',
          serverVersion: '0.1.0',
          eventCount: eventStore.size,
        };
        socket.send(JSON.stringify(connected));

        // Send current config
        const configMsg: ServerMessage = {
          type: 'session:config',
          config: activeConfig,
        };
        socket.send(JSON.stringify(configMsg));

        // Send recent events (last 100)
        const recentEvents = eventStore.getPage(
          Math.max(0, eventStore.size - 100),
          100
        );
        for (const event of recentEvents) {
          const msg: ServerMessage = { type: 'event:new', event };
          socket.send(JSON.stringify(msg));
        }

        // Send pending approvals
        for (const approval of pendingManager.getPendingDTO()) {
          const msg: ServerMessage = { type: 'approval:pending', approval };
          socket.send(JSON.stringify(msg));
        }

        socket.on('message', (data: Buffer) => {
          try {
            const message = JSON.parse(data.toString()) as ClientMessage;
            handleClientMessage(message);
          } catch {
            // Ignore malformed messages
          }
        });

        connection.socket.on('close', () => {
          wsClients.delete(socket as Parameters<typeof wsClients.delete>[0]);
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
      case 'analysis:ask': {
        const event = eventStore.get(message.eventId);
        if (!event) break;

        void (async () => {
          try {
            const answer = await analysisEngine.ask(message.question, {
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
                meaning: answer,
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

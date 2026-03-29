import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { PendingApprovalManager } from './hooks/pending.js';
import { EventStore } from './events/store.js';
import { SessionGate } from './hooks/gate.js';
import { HookInstaller } from './hooks/installer.js';
import { registerHookHandler } from './hooks/handler.js';
import { registerClineHookHandler } from './cline/handler.js';
import { AnalysisEngine } from './analysis/engine.js';
import { resolveEndpoint } from './analysis/providers/openai-compat.js';
import { filterPii } from './pii/filter.js';
import { PII_CATEGORIES, PII_GROUPS } from './pii/categories.js';
import { scanPii, executePurge } from './pii/purge.js';
import { updateConfig, saveConfig } from './config/config.js';
import { openDatabase } from './db/database.js';
import { SessionRecorder } from './db/recorder.js';
import { BookmarkStore } from './db/bookmarks.js';
import { searchEvents } from './db/search.js';
import type { SearchRequest } from './db/search.js';
import type { LaymanConfig } from './config/schema.js';
import { VibeSessionWatcher } from './vibe/watcher.js';
import { recoverSessionGaps } from './hooks/recovery.js';
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
  const gate = new SessionGate();
  const vibeWatcher = new VibeSessionWatcher(eventStore);
  const startTime = Date.now();

  // Wire PII filter — checks config on every event so toggling takes effect immediately
  eventStore.setDataFilter((data) => {
    if (getConfig().piiFilter) return filterPii(data);
    return data;
  });

  // In-memory queue of prompts to be relayed to OpenCode by the plugin.
  interface PendingPrompt { id: string; sessionId: string; prompt: string; queuedAt: number }
  const promptQueue: PendingPrompt[] = [];

  let activeConfig = config;
  const getConfig = (): LaymanConfig => activeConfig;

  // Persistent storage
  const db = openDatabase();
  const bookmarkStore = new BookmarkStore(db);
  const recorder = new SessionRecorder(db, () => getConfig().sessionRecording);
  recorder.attach(eventStore);

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

  // Forward gate events to WebSocket
  gate.on('session:activated', (sessionId: string) => {
    broadcast({ type: 'session:activated', sessionId });
  });

  gate.on('session:deactivated', (sessionId: string) => {
    broadcast({ type: 'session:deactivated', sessionId });
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

    // PII categories — returns the full list of PII categories for the UI
    fastify.get('/api/pii-categories', async () => ({
      categories: PII_CATEGORIES,
      groups: PII_GROUPS,
    }));

    // PII purge — scan all SQLite data for PII matches
    fastify.post('/api/pii-purge/scan', async () => {
      return scanPii(db);
    });

    // Recording recovery — on-demand gap fill across all stored sessions
    fastify.post('/api/recovery/scan', async () => {
      return recoverSessionGaps(db, eventStore);
    });

    // PII purge — execute redaction on all SQLite data
    fastify.post('/api/pii-purge/execute', async () => {
      const result = executePurge(db);
      // Broadcast refreshed bookmarks since names may have been redacted
      broadcast({
        type: 'bookmarks:state',
        folders: bookmarkStore.listFolders(),
        bookmarks: bookmarkStore.listAllBookmarks(),
      });
      return result;
    });

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
      Body: { question: string; model?: string };
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
          modelOverride: request.body.model,
        });
        recorder.recordQA(event.id, event.sessionId, {
          question: request.body.question,
          answer: result.text,
          model: result.model,
          tokensIn: result.tokens.input,
          tokensOut: result.tokens.output,
          latencyMs: result.latencyMs,
        });
        return { answer: result.text, tokens: result.tokens, latencyMs: result.latencyMs, model: result.model };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: errorMsg });
      }
    });

    // Model discovery — lists available models for the configured or specified provider.
    // Accepts optional ?provider= and ?endpoint= overrides.
    fastify.get<{ Querystring: { endpoint?: string; provider?: string } }>('/api/models', async (request, reply) => {
      const provider = request.query.provider ?? activeConfig.analysis.provider;

      // Anthropic: return hardcoded model list (no public model list API)
      if (provider === 'anthropic') {
        return {
          models: [
            'haiku',
            'sonnet',
            'opus',
            'claude-haiku-4-5-20251001',
            'claude-sonnet-4-6',
            'claude-opus-4-6',
          ],
        };
      }

      // OpenAI provider uses the official OpenAI API
      const defaultEndpoint = provider === 'openai' ? 'https://api.openai.com/v1' : undefined;
      const rawEndpoint = request.query.endpoint ?? activeConfig.analysis.endpoint ?? defaultEndpoint;
      if (!rawEndpoint) {
        return reply.status(400).send({ error: 'No endpoint configured. Set an endpoint URL first.' });
      }

      const endpoint = resolveEndpoint(rawEndpoint.replace(/\/+$/, ''));
      const modelsUrl = endpoint.endsWith('/v1') ? `${endpoint}/models` : `${endpoint}/v1/models`;

      // Determine API key: use configured key, or fall back to provider-specific env vars
      const apiKey = activeConfig.analysis.apiKey
        ?? (provider === 'openai' ? process.env.OPENAI_API_KEY : undefined)
        ?? process.env.LAYMAN_API_KEY
        ?? 'not-needed';

      try {
        const res = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
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

    // Setup status — check if hooks and slash command are installed
    fastify.get('/api/setup/status', async () => {
      const resolvedHookUrl = activeConfig.hookUrl ?? `http://${activeConfig.host}:${activeConfig.port}`;
      const installer = new HookInstaller({
        serverUrl: resolvedHookUrl,
        hookTimeout: activeConfig.hookTimeout,
      });
      return installer.getStatus();
    });

    // Setup install — write hooks + slash command with user consent
    fastify.post('/api/setup/install', async () => {
      const resolvedHookUrl = activeConfig.hookUrl ?? `http://${activeConfig.host}:${activeConfig.port}`;
      const installer = new HookInstaller({
        serverUrl: resolvedHookUrl,
        hookTimeout: activeConfig.hookTimeout,
      });
      installer.install();
      installer.installCommand();
      installer.installOptionalClientCommands();
      installer.installClineHooks();
      return installer.getStatus();
    });

    // Send a prompt to an OpenCode session.
    // Strategy: try the OpenCode HTTP API directly (available when started with --port),
    // then fall back to queuing it for the plugin to relay via `opencode run`.
    fastify.post<{
      Params: { sessionId: string };
      Body: { prompt: string };
    }>('/api/sessions/:sessionId/prompt', async (request, reply) => {
      const { sessionId } = request.params;
      const { prompt } = request.body;

      if (!prompt?.trim()) {
        return reply.status(400).send({ error: 'prompt is required' });
      }

      const session = eventStore.getSessions().find((s) => s.sessionId === sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }
      if (session.agentType === 'cline') {
        return reply.status(400).send({ error: 'Prompt submission is not yet supported for Cline sessions' });
      }
      if (session.agentType !== 'opencode') {
        return reply.status(400).send({ error: 'Prompt submission is only supported for OpenCode sessions' });
      }

      // Try OpenCode HTTP API first (only works when started with --port).
      if (session.opencodeUrl) {
        try {
          const res = await fetch(
            `${session.opencodeUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(session.cwd)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ parts: [{ type: 'text', text: prompt.trim() }] }),
              signal: AbortSignal.timeout(5000),
            }
          );
          if (res.ok) return { ok: true, method: 'http' };
        } catch {
          // fall through to queue
        }
      }

      // Queue for plugin relay — the plugin polls this endpoint and submits via opencode run.
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      promptQueue.push({ id, sessionId, prompt: prompt.trim(), queuedAt: Date.now() });
      return { ok: true, method: 'queued' };
    });

    // Plugin polling endpoint — returns the oldest pending prompt for any of the given sessions.
    fastify.get<{ Querystring: { sessionIds?: string } }>(
      '/api/opencode/pending-prompt',
      async (request) => {
        const ids = (request.query.sessionIds ?? '').split(',').filter(Boolean);
        if (ids.length === 0) return null;
        // Evict stale prompts (older than 10 minutes)
        const cutoff = Date.now() - 10 * 60 * 1000;
        while (promptQueue.length > 0 && promptQueue[0].queuedAt < cutoff) {
          promptQueue.shift();
        }
        const idx = promptQueue.findIndex((p) => ids.includes(p.sessionId));
        if (idx < 0) return null;
        return promptQueue[idx];
      }
    );

    // Plugin dequeue endpoint — acknowledge and remove a pending prompt.
    fastify.delete<{ Params: { id: string } }>(
      '/api/opencode/pending-prompt/:id',
      async (request) => {
        const idx = promptQueue.findIndex((p) => p.id === request.params.id);
        if (idx >= 0) promptQueue.splice(idx, 1);
        return { ok: true };
      }
    );

    // Activate a session for monitoring
    fastify.post('/api/activate', async (request) => {
      // The session_id may come from the hook body (PreToolUse detection)
      // or from a direct curl call (no session_id in body).
      // For direct curl, we extract session_id from the most recent hook event.
      const body = request.body as { session_id?: string } | null;
      let sessionId = body?.session_id;

      if (!sessionId) {
        // Find the most recently seen session that isn't already activated
        const sessions = eventStore.getSessions();
        const recent = sessions.find((s) => !gate.isActive(s.sessionId));
        sessionId = recent?.sessionId;
      }

      if (!sessionId) {
        // Activate the most recent session we've seen from hooks
        // (the curl command itself triggers a PreToolUse hook with the session_id,
        // and the handler detects the activation pattern before this route is hit)
        return { ok: true, message: 'Session will be activated on next hook event' };
      }

      gate.activate(sessionId);
      return { ok: true, sessionId };
    });

    // Deactivate a session
    fastify.post<{ Body: { session_id?: string } | null }>('/api/deactivate', async (request) => {
      const body = request.body;
      const sessionId = body?.session_id;
      if (sessionId) {
        gate.deactivate(sessionId);
        return { ok: true, sessionId };
      }
      return { ok: false, error: 'session_id required' };
    });

    // Bookmark folders
    fastify.get('/api/bookmarks/folders', async () => {
      return { folders: bookmarkStore.listFolders() };
    });

    fastify.post<{ Body: { name: string } }>('/api/bookmarks/folders', async (request) => {
      const folder = bookmarkStore.createFolder(request.body.name);
      broadcast({ type: 'bookmarks:folder:created', folder });
      return { folder };
    });

    fastify.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/bookmarks/folders/:id', async (request, reply) => {
      const { id } = request.params;
      const { name } = request.body;
      if (name !== undefined) {
        const folder = bookmarkStore.renameFolder(id, name);
        if (!folder) return reply.status(404).send({ error: 'Folder not found' });
        broadcast({ type: 'bookmarks:folder:updated', folder });
        return { folder };
      }
      return reply.status(400).send({ error: 'No valid fields to update' });
    });

    fastify.delete<{ Params: { id: string } }>('/api/bookmarks/folders/:id', async (request) => {
      bookmarkStore.deleteFolder(request.params.id);
      broadcast({ type: 'bookmarks:folder:deleted', folderId: request.params.id });
      return { ok: true };
    });

    fastify.post<{ Body: { ids: string[] } }>('/api/bookmarks/folders/reorder', async (request) => {
      bookmarkStore.reorderFolders(request.body.ids);
      const folders = bookmarkStore.listFolders();
      for (const folder of folders) {
        broadcast({ type: 'bookmarks:folder:updated', folder });
      }
      return { ok: true };
    });

    // Bookmarks
    fastify.get('/api/bookmarks', async () => {
      return { bookmarks: bookmarkStore.listAllBookmarks() };
    });

    fastify.post<{ Body: { sessionId: string; name: string; folderId?: string | null } }>('/api/bookmarks', async (request) => {
      const { sessionId, name, folderId } = request.body;
      const bookmark = bookmarkStore.createBookmark(sessionId, name, folderId);
      broadcast({ type: 'bookmarks:created', bookmark });
      return { bookmark };
    });

    fastify.patch<{
      Params: { id: string };
      Body: { name?: string; folderId?: string | null; sortOrder?: number };
    }>('/api/bookmarks/:id', async (request, reply) => {
      const { id } = request.params;
      const { name, folderId, sortOrder } = request.body;
      let bookmark = null;
      if (name !== undefined) {
        bookmark = bookmarkStore.renameBookmark(id, name);
      }
      if (folderId !== undefined || sortOrder !== undefined) {
        bookmark = bookmarkStore.moveBookmark(id, folderId ?? null, sortOrder);
      }
      if (!bookmark) return reply.status(404).send({ error: 'Bookmark not found' });
      broadcast({ type: 'bookmarks:updated', bookmark });
      return { bookmark };
    });

    fastify.delete<{ Params: { id: string } }>('/api/bookmarks/:id', async (request) => {
      bookmarkStore.deleteBookmark(request.params.id);
      broadcast({ type: 'bookmarks:deleted', bookmarkId: request.params.id });
      return { ok: true };
    });

    fastify.post<{ Body: { folderId: string | null; ids: string[] } }>('/api/bookmarks/reorder', async (request) => {
      bookmarkStore.reorderBookmarks(request.body.folderId, request.body.ids);
      const bookmarks = bookmarkStore.listAllBookmarks();
      for (const bookmark of bookmarks) {
        broadcast({ type: 'bookmarks:updated', bookmark });
      }
      return { ok: true };
    });

    // Recorded sessions
    fastify.get('/api/bookmarks/sessions', async () => {
      return { sessions: bookmarkStore.listRecordedSessions() };
    });

    fastify.get<{ Params: { sessionId: string } }>('/api/bookmarks/sessions/:sessionId/events', async (request, reply) => {
      const { sessionId } = request.params;
      const session = bookmarkStore.getRecordedSession(sessionId);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      return { events: bookmarkStore.getEventsForSession(sessionId) };
    });

    fastify.get<{ Params: { sessionId: string } }>('/api/bookmarks/sessions/:sessionId/qa', async (request) => {
      return { qa: bookmarkStore.getQAForSession(request.params.sessionId) };
    });

    fastify.delete<{ Params: { sessionId: string } }>('/api/bookmarks/sessions/:sessionId', async (request, reply) => {
      const { sessionId } = request.params;
      const session = bookmarkStore.getRecordedSession(sessionId);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      bookmarkStore.deleteSession(sessionId);
      broadcast({ type: 'bookmarks:state', folders: bookmarkStore.listFolders(), bookmarks: bookmarkStore.listAllBookmarks() });
      return { ok: true };
    });

    // Search across recorded sessions
    fastify.post<{ Body: SearchRequest }>('/api/search', async (request, reply) => {
      const { query } = request.body;
      if (!query?.trim()) {
        return reply.status(400).send({ error: 'query is required' });
      }
      return searchEvents(db, request.body);
    });

    // Import events from a saved JSON file (e.g. from /api/events export)
    fastify.post<{ Body: { events: unknown[] } }>('/api/bookmarks/sessions/import', async (request, reply) => {
      const { events } = request.body;
      if (!Array.isArray(events) || events.length === 0) {
        return reply.status(400).send({ error: 'events must be a non-empty array' });
      }

      // Validate and cast — accept anything that looks like a TimelineEvent
      const typed = events.filter(
        (e): e is import('./events/types.js').TimelineEvent =>
          typeof e === 'object' && e !== null &&
          typeof (e as Record<string, unknown>).id === 'string' &&
          typeof (e as Record<string, unknown>).sessionId === 'string' &&
          typeof (e as Record<string, unknown>).type === 'string' &&
          typeof (e as Record<string, unknown>).timestamp === 'number'
      );

      if (typed.length === 0) {
        return reply.status(400).send({ error: 'No valid events found in payload' });
      }

      recorder.saveEventsFromMemory(typed);

      // Group by sessionId to create one bookmark per session
      const bySession = new Map<string, { events: typeof typed; agentType: string }>();
      for (const ev of typed) {
        const existing = bySession.get(ev.sessionId);
        if (existing) {
          existing.events.push(ev);
        } else {
          bySession.set(ev.sessionId, { events: [ev], agentType: ev.agentType });
        }
      }

      const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const createdBookmarks = [];
      let idx = 1;
      for (const [sessionId, { events: sessEvents, agentType }] of bySession) {
        // Skip if already bookmarked
        const allBookmarks = bookmarkStore.listAllBookmarks();
        if (allBookmarks.some((b) => b.sessionId === sessionId)) continue;

        const name = `${dateStr} import ${idx} (${agentType === 'opencode' ? 'OC' : 'CC'} · ${sessionId.slice(0, 6)})`;
        const bookmark = bookmarkStore.createBookmark(sessionId, name);
        broadcast({ type: 'bookmarks:created', bookmark });
        createdBookmarks.push(bookmark);

        // Update last_seen on the recorded session row
        const latest = Math.max(...sessEvents.map((e) => e.timestamp));
        db.prepare('UPDATE recorded_sessions SET last_seen = MAX(last_seen, ?) WHERE session_id = ?').run(latest, sessionId);
        idx++;
      }

      // Broadcast updated bookmark list so all open tabs refresh
      broadcast({
        type: 'bookmarks:state',
        folders: bookmarkStore.listFolders(),
        bookmarks: bookmarkStore.listAllBookmarks(),
      });

      return {
        ok: true,
        importedEventCount: typed.length,
        sessionCount: bySession.size,
        bookmarksCreated: createdBookmarks.length,
      };
    });

    // Snapshot in-memory events to SQLite (must be called before container rebuild)
    fastify.post<{ Body?: { sessionId?: string } }>('/api/bookmarks/sessions/save-current', async (request) => {
      const { sessionId } = request.body ?? {};
      const allEvents = eventStore.getAll();
      const toSave = sessionId ? allEvents.filter((e) => e.sessionId === sessionId) : allEvents;
      recorder.saveEventsFromMemory(toSave);
      // Patch cwd + agentType from the live sessions map
      const updateSession = db.prepare(
        'UPDATE recorded_sessions SET cwd = ?, agent_type = ?, last_seen = ? WHERE session_id = ?'
      );
      for (const s of eventStore.getSessions()) {
        if (!sessionId || s.sessionId === sessionId) {
          updateSession.run(s.cwd, s.agentType, s.lastSeen, s.sessionId);
        }
      }
      const savedSessionIds = [...new Set(toSave.map((e) => e.sessionId))];
      return { ok: true, eventCount: toSave.length, sessionIds: savedSessionIds };
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

        // Send bookmarks state
        ws.send(JSON.stringify({
          type: 'bookmarks:state',
          folders: bookmarkStore.listFolders(),
          bookmarks: bookmarkStore.listAllBookmarks(),
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

        const req = {
          toolName: event.data.toolName ?? 'Unknown',
          toolInput: event.data.toolInput ?? {},
          toolOutput: event.data.toolOutput,
          cwd: process.cwd(),
          depth: message.depth,
        };

        // Run both in parallel — the engine's concurrency limit + pacer handle rate limiting
        void (async () => {
          try {
            broadcast({ type: 'laymans:start', eventId: message.eventId });
            const result = await analysisEngine.laymans(req, activeConfig.laymansPrompt);
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
            const result = await analysisEngine.analyze(req);
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
      case 'setup:install': {
        const resolvedHookUrl = activeConfig.hookUrl ?? `http://${activeConfig.host}:${activeConfig.port}`;
        const installer = new HookInstaller({
          serverUrl: resolvedHookUrl,
          hookTimeout: activeConfig.hookTimeout,
        });
        installer.install();
        installer.installCommand();
        installer.installOptionalClientCommands();
        installer.installClineHooks();
        break;
      }
      case 'bookmarks:get': {
        broadcast({
          type: 'bookmarks:state',
          folders: bookmarkStore.listFolders(),
          bookmarks: bookmarkStore.listAllBookmarks(),
        });
        break;
      }
    }
  }

  // Register hook handler routes
  registerHookHandler(fastify, pendingManager, eventStore, analysisEngine, getConfig, gate);
  registerClineHookHandler(fastify, pendingManager, eventStore, analysisEngine, getConfig, gate);

  let resolvedPort = config.port;

  return {
    async start() {
      await registerPlugins();
      registerRoutes();
      vibeWatcher.start();

      if (getConfig().recordingRecovery && getConfig().sessionRecording) {
        void recoverSessionGaps(db, eventStore).then(({ events, sessions }) => {
          if (events > 0) console.log(`[recovery] Startup scan filled ${events} events across ${sessions} session${sessions === 1 ? '' : 's'}`);
        });
      }

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
      vibeWatcher.stop();
      await fastify.close();
    },

    getPort() {
      return resolvedPort;
    },
  };
}

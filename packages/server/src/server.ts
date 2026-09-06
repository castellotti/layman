import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

import { PendingApprovalManager } from './hooks/pending.js';
import { EventStore } from './events/store.js';
import type { FileAccess, UrlAccess } from './events/types.js';
import { SessionGate } from './hooks/gate.js';
import { HookInstaller, findOrphanedProjectHooks, repairOrphanedProjectHooks } from './hooks/installer.js';
import { registerHookHandler } from './hooks/handler.js';
import { registerClineHookHandler } from './cline/handler.js';
import { registerOpenWebUIHookHandler } from './openwebui/handler.js';
import { AnalysisEngine } from './analysis/engine.js';
import { DriftMonitor } from './drift/monitor.js';
import { LiveStreamStore, type LiveStream } from './stream/live.js';
import { resolveEndpoint } from './analysis/providers/openai-compat.js';
import { filterPii, redactValue, redactString } from './pii/filter.js';
import { PII_CATEGORIES, PII_GROUPS } from './pii/categories.js';
import { scanPii, executePurge } from './pii/purge.js';
import { updateConfig, saveConfig } from './config/config.js';
import { openDatabase } from './db/database.js';
import { ensureHostIdentity } from './sync/identity.js';
import { SessionRecorder, countRecordedSessionsByAgentType } from './db/recorder.js';
import { BookmarkStore } from './db/bookmarks.js';
import { HighlightStore } from './db/highlights.js';
import { TurnStore } from './turns/store.js';
import { registerTurnRoutes } from './routes/turns.js';
import { registerTtsRoutes } from './routes/tts.js';
import { searchEvents, parseSearchQuery, matchesSearchTerms } from './db/search.js';
import { computeTimeMetrics } from './db/time-metrics.js';
import type { SearchRequest } from './db/search.js';
import type { LaymanConfig } from './config/schema.js';
import { VibeSessionWatcher } from './vibe/watcher.js';
import { PiSessionWatcher } from './pi/watcher.js';
import { NativeVibeSource, NativePiSource, GloveSource } from './monitor/sources.js';
import { recoverSessionGaps, importHistoricalSessions } from './hooks/recovery.js';
import type { ServerMessage, ClientMessage, SessionStatus, SetupStatus } from './types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: SERVER_VERSION } = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as { version: string };

function mergeDeclined(status: SetupStatus, declinedClients: string[], openWebUiUrl?: string): SetupStatus {
  status.claudeCodeDeclined = declinedClients.includes('claude-code');
  for (const c of status.optionalClients) {
    c.declined = declinedClients.includes(c.id);
    if (c.id === 'open-webui') {
      c.detected = !!(openWebUiUrl?.trim());
    }
  }
  return status;
}

/**
 * Annotate the setup status with recorded-session counts per harness. Each
 * client's id is also its stored agent_type ('claude-code', 'codex', 'cline',
 * 'pi', 'opencode', 'mistral-vibe', 'open-webui'), so the map keys line up
 * directly. Lets the UI show that a harness's history is preserved even when
 * the harness is no longer installed on this machine.
 */
function mergeRecordedCounts(status: SetupStatus, counts: Record<string, number>): SetupStatus {
  status.claudeCodeRecordedSessions = counts['claude-code'] ?? 0;
  for (const c of status.optionalClients) {
    c.recordedSessionCount = counts[c.id] ?? 0;
  }
  return status;
}

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
    // Default 1MB body limit is too small for PostToolUse payloads, which
    // embed full tool output (large file reads, command stdout, etc.).
    bodyLimit: 10 * 1024 * 1024,
  });

  const eventStore = new EventStore();
  const pendingManager = new PendingApprovalManager(config.hookTimeout);
  const analysisEngine = new AnalysisEngine(config.analysis);
  const gate = new SessionGate();
  const startTime = Date.now();
  // DriftMonitor is initialized here with a placeholder broadcast function.
  // The real broadcast is wired up after wsClients is defined below.
  let driftMonitor: DriftMonitor;

  // Wire PII filter — checks config on every event so toggling takes effect immediately
  eventStore.setDataFilter((data) => {
    if (getConfig().piiFilter) return filterPii(data);
    return data;
  });
  // Layman's-terms explanations bypass EventData entirely (attachLaymans), so they need
  // their own filter hook to get the same redaction as everything else leaving the store.
  eventStore.setStringFilter((text) => (getConfig().piiFilter ? redactString(text) : text));

  // In-memory queue of prompts to be relayed to OpenCode by the plugin.
  interface PendingPrompt { id: string; sessionId: string; prompt: string; queuedAt: number }
  const promptQueue: PendingPrompt[] = [];

  let activeConfig = config;
  const getConfig = (): LaymanConfig => activeConfig;
  // Redacts a session's cwd for anything leaving the process (client display,
  // persisted storage, or LLM prompts) when the PII filter is enabled. Kept
  // separate from EventStore's own dataFilter because some internal-only
  // consumers (e.g. the OpenCode prompt relay) need the literal filesystem
  // path to function and must not be redacted.
  const filterCwd = (cwd: string): string => getConfig().piiFilter ? redactString(cwd) : cwd;
  const resolvedServerUrl = (): string =>
    activeConfig.hookUrl ?? `http://${activeConfig.host}:${activeConfig.port}`;

  const makeInstaller = (): HookInstaller =>
    new HookInstaller({
      serverUrl: resolvedServerUrl(),
      hookTimeout: activeConfig.hookTimeout,
    });

  /**
   * Session cwds are stored PII-redacted, so `~` has to be expanded back.
   * The PII filter redacts a cwd that is exactly the home directory to the
   * bare string `~` (no trailing slash), so that case is handled alongside `~/`.
   */
  const expandHome = (dir: string): string => {
    if (dir === '~') return homedir();
    return dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir;
  };

  /**
   * Directories Layman is tracking, as absolute paths that exist.
   * Hook-repair routes are restricted to these so they cannot be used to
   * rewrite settings files at an arbitrary path on disk.
   */
  const trackedCwds = (): string[] => {
    const raw = [
      ...eventStore.getSessions().map((s) => s.cwd),
      ...bookmarkStore.listRecordedSessions().map((s) => s.cwd),
    ];
    const dirs = new Set(raw.filter(Boolean).map(expandHome));
    return [...dirs].filter((dir) => existsSync(dir));
  };

  /**
   * Resolves the `cwd` parameter against the tracked set.
   * Returns every tracked directory when omitted, or null when the requested
   * directory is not one Layman knows about.
   */
  const resolveTrackedCwds = (cwd?: string): string[] | null => {
    const tracked = trackedCwds();
    if (!cwd) return tracked;
    const target = resolve(expandHome(cwd));
    return tracked.some((dir) => resolve(dir) === target) ? [target] : null;
  };

  // Passive-watcher sources: the native root always, plus glove sandbox roots
  // when enabled. Native precedes glove so it wins any path collision. The glove
  // source emits both Vibe and pi roots; each watcher filters roots() to the
  // agent type it parses, so the shared source instance feeds both.
  const gloveSource = new GloveSource(() => {
    const glove = getConfig().glove;
    return glove.enabled ? expandHome(glove.sessionsDir) : null;
  });
  const vibeWatcher = new VibeSessionWatcher(eventStore, gate, getConfig, [
    new NativeVibeSource(),
    gloveSource,
  ]);
  const piWatcher = new PiSessionWatcher(eventStore, gate, getConfig, [
    new NativePiSource(),
    gloveSource,
  ]);

  // Persistent storage
  const db = openDatabase();
  // Establish this host's identity before any recorded-data write, so the sync
  // journal triggers can stamp rows with the local host id (see sync/identity.ts).
  ensureHostIdentity(config, db);
  const bookmarkStore = new BookmarkStore(db);
  const highlightStore = new HighlightStore(db);
  const turnStore = new TurnStore(db, eventStore, bookmarkStore);
  const recorder = new SessionRecorder(
    db,
    () => getConfig().sessionRecording,
    () => getConfig().piiFilter,
  );
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

  // Now that broadcast exists, create the DriftMonitor
  driftMonitor = new DriftMonitor(eventStore, analysisEngine, pendingManager, getConfig, broadcast);

  // ─── Live token streaming ─────────────────────────────────────────────────
  const liveStreams = new LiveStreamStore();
  // Deltas never pass through EventStore, so they never meet its PII filter.
  // Wire the same redaction in here — see LiveStreamStore.setStringFilter for
  // why it is applied to the accumulated buffer rather than to each delta.
  liveStreams.setStringFilter((text) => (getConfig().piiFilter ? redactString(text) : text));
  liveStreams.start();

  /**
   * Coalesce stream broadcasts to ~10 Hz per session.
   *
   * A local model on a fast GPU generates far quicker than a browser can
   * usefully repaint, and the producer already batches. Re-amplifying that to
   * one frame per delta would saturate the socket and the React render loop for
   * no visible gain. The trailing timer guarantees the final state of a burst is
   * always sent, so the last tokens before a pause are never left unrendered.
   */
  const STREAM_BROADCAST_INTERVAL_MS = 100;
  const streamPending = new Map<string, LiveStream>();
  const streamTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function flushStream(sessionId: string): void {
    const stream = streamPending.get(sessionId);
    streamPending.delete(sessionId);
    streamTimers.delete(sessionId);
    if (stream) broadcast({ type: 'stream:update', sessionId, stream });
  }

  liveStreams.on('stream:update', (stream: LiveStream) => {
    streamPending.set(stream.sessionId, stream);
    if (streamTimers.has(stream.sessionId)) return;
    streamTimers.set(
      stream.sessionId,
      setTimeout(() => flushStream(stream.sessionId), STREAM_BROADCAST_INTERVAL_MS),
    );
  });

  liveStreams.on('stream:end', (sessionId: string) => {
    // Drop any coalesced partial: it is superseded by the committed
    // agent_response, and delivering it after the end would resurrect the row.
    const timer = streamTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    streamTimers.delete(sessionId);
    streamPending.delete(sessionId);
    broadcast({ type: 'stream:end', sessionId });
  });

  // Build sessions list annotated with active flag from the gate
  function buildSessionsList() {
    return eventStore.getSessions().map(s => ({
      ...s,
      cwd: filterCwd(s.cwd),
      active: gate.isActive(s.sessionId),
    }));
  }

  // ─── Full-session investigation context ───────────────────────────────────
  // Context assembly priority for analyze/laymans/ask: (1) the selected event verbatim
  // (handled by callers), (2) a window of surrounding events, (3) a rolling summary of
  // everything older than that window. The summary is cached per session and refreshed
  // in the background — it never blocks the caller, so the first investigation in a long
  // session simply lacks it until the background summarization completes.
  const RECENT_EVENTS_WINDOW = 20;
  const sessionSummaryCache = new Map<string, { summary: string; eventCount: number }>();

  function summarizeEventForContext(e: import('./events/types.js').TimelineEvent): { type: string; summary: string } {
    return {
      type: e.type,
      summary: e.data.toolName
        ? `${e.data.toolName}: ${JSON.stringify(e.data.toolInput ?? {}).slice(0, 120)}`
        : (e.data.prompt as string | undefined)?.slice(0, 120) ?? e.type,
    };
  }

  function getSessionEventsForContext(sessionId: string): import('./events/types.js').TimelineEvent[] {
    const live = eventStore.getAll().filter((e) => e.sessionId === sessionId);
    return live.length > 0 ? live : bookmarkStore.getEventsForSession(sessionId);
  }

  function buildSessionContext(sessionId: string, excludeEventId: string, modelOverride?: string): {
    recentEvents: Array<{ type: string; summary: string }>;
    sessionSummary?: string;
  } {
    const others = getSessionEventsForContext(sessionId).filter((e) => e.id !== excludeEventId);
    const recentEvents = others.slice(-RECENT_EVENTS_WINDOW).map(summarizeEventForContext);
    const older = others.slice(0, -RECENT_EVENTS_WINDOW);

    if (older.length === 0) return { recentEvents };

    const cached = sessionSummaryCache.get(sessionId);
    if (!cached || cached.eventCount !== older.length) {
      void analysisEngine.summarizeSession(older.map(summarizeEventForContext), process.cwd(), modelOverride)
        .then((result) => sessionSummaryCache.set(sessionId, { summary: result.summary, eventCount: older.length }))
        .catch(() => {});
    }

    return { recentEvents, sessionSummary: cached?.summary };
  }

  // Forward store events to WebSocket
  eventStore.on('event:new', (event) => {
    broadcast({ type: 'event:new', event });
  });

  eventStore.on('sessions:changed', () => {
    broadcast({ type: 'sessions:list', sessions: buildSessionsList() });
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
        sessionId: approval.sessionId,
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
        sessionId: approval.sessionId,
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

      // SPA fallback: deep links like /s/<id>/t/<id> are client-side routes, so
      // any unmatched GET that isn't an API/hook/ws path serves index.html and
      // lets the app resolve it. Without this, reloading a deep link 404s.
      fastify.setNotFoundHandler((request, reply) => {
        const path = request.url.split('?')[0];
        const isAppRoute =
          request.method === 'GET' &&
          !path.startsWith('/api/') &&
          !path.startsWith('/hooks/') &&
          path !== '/ws';

        if (isAppRoute) return reply.sendFile('index.html');
        return reply.status(404).send({ error: 'Not found' });
      });
    }
  }

  function registerRoutes(): void {
    // Turn model + data egress (see docs: addressable URLs)
    registerTurnRoutes(fastify, { turnStore, bookmarkStore, getConfig });

    // Text-to-speech pass-through to speaches (speaches has CORS off by default)
    registerTtsRoutes(fastify, { getConfig });

    // Health check
    fastify.get('/api/health', async () => ({ status: 'ok', version: SERVER_VERSION }));

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

    // Historical session import — discover and import transcript files
    fastify.post('/api/import/history', async () => {
      return importHistoricalSessions(db, eventStore, recorder, {
        enrichExisting: true,
        gloveRoots: gloveSource.roots(),
      });
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

    // Access log
    fastify.get<{ Params: { sessionId: string } }>(
      '/api/sessions/:sessionId/access-log',
      async (request) => {
        const { sessionId } = request.params;
        const live = eventStore.getAccessLog(sessionId);
        let result: { files: FileAccess[]; urls: UrlAccess[] };
        if (live.files.length > 0 || live.urls.length > 0) {
          result = live;
        } else {
          // Fall back to reconstructing from persisted events for historical sessions
          const events = bookmarkStore.getEventsForSession(sessionId);
          const files: FileAccess[] = [];
          const urls: UrlAccess[] = [];
          for (const ev of events) {
            if (ev.data.fileAccess) files.push(...ev.data.fileAccess);
            if (ev.data.urlAccess) urls.push(...ev.data.urlAccess);
          }
          result = { files, urls };
        }
        return getConfig().piiFilter ? redactValue(result) : result;
      }
    );

    fastify.get('/api/access-log', async () => {
      const sessions = eventStore.getSessions();
      const logs: Record<string, { files: unknown[]; urls: unknown[] }> = {};
      const applyPii = getConfig().piiFilter;
      for (const s of sessions) {
        const log = eventStore.getAccessLog(s.sessionId);
        logs[s.sessionId] = applyPii ? redactValue(log) as typeof log : log;
      }
      return logs;
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
      const event = eventStore.get(request.params.eventId) ?? bookmarkStore.getEventById(request.params.eventId);
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
      Body: {
        question: string;
        model?: string;
        laymansTerms?: string;
        failureReason?: string;
        previousQuestions?: Array<{ question: string; answer: string }>;
      };
    }>('/api/analysis/:eventId/ask', async (request, reply) => {
      const event = eventStore.get(request.params.eventId) ?? bookmarkStore.getEventById(request.params.eventId);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      const ctx = buildSessionContext(event.sessionId, event.id, request.body.model);

      try {
        const result = await analysisEngine.ask(request.body.question, {
          toolName: event.data.toolName ?? 'Unknown',
          toolInput: event.data.toolInput ?? {},
          toolOutput: event.data.toolOutput,
          previousAnalysis: event.analysis,
          laymansTerms: request.body.laymansTerms ?? event.laymans?.explanation,
          failureReason: request.body.failureReason ?? (event.data.error as string | undefined),
          previousQuestions: request.body.previousQuestions,
          recentSessionEvents: ctx.recentEvents,
          sessionSummary: ctx.sessionSummary,
          cwd: process.cwd(),
          modelOverride: request.body.model,
        }, 'high');
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

    // Session summary — generates a plain-English summary of the entire session.
    fastify.post<{
      Body: { sessionId?: string; model?: string };
    }>('/api/sessions/summary', async (request, reply) => {
      const { sessionId, model } = request.body;
      const allEvents = eventStore.getAll();
      let sessionEvents = sessionId
        ? allEvents.filter((e) => e.sessionId === sessionId)
        : allEvents;

      // Fall back to DB for historical sessions not in the live store
      if (sessionEvents.length === 0 && sessionId) {
        sessionEvents = bookmarkStore.getEventsForSession(sessionId);
      }

      if (sessionEvents.length === 0) {
        return reply.status(404).send({ error: 'No events found for session' });
      }

      // Build compact event list for summary
      const eventSummaries = sessionEvents.slice(-100).map((e) => ({
        type: e.type,
        summary: e.data.toolName
          ? `${e.data.toolName}: ${JSON.stringify(e.data.toolInput ?? {}).slice(0, 150)}`
          : (e.data.prompt as string | undefined)?.slice(0, 150) ?? e.type,
        toolName: e.data.toolName as string | undefined,
      }));

      // Try live sessions first, then recorded sessions for cwd. Filtered
      // before use since it's embedded verbatim in the LLM prompt below.
      const liveCwd = eventStore.getSessions().find((s) => !sessionId || s.sessionId === sessionId)?.cwd;
      const dbCwd = sessionId ? bookmarkStore.getRecordedSession(sessionId)?.cwd : undefined;
      const cwd = filterCwd(liveCwd ?? dbCwd ?? process.cwd());

      try {
        const result = await analysisEngine.summarizeSession(eventSummaries, cwd, model, 'high');
        return result;
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
      const installer = makeInstaller();
      const status = mergeDeclined(installer.getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl);
      return mergeRecordedCounts(status, countRecordedSessionsByAgentType(db));
    });

    // Orphaned project-level hooks — leftovers from before Layman installed
    // globally. claude-code merges them with the global set, so every hook
    // fires twice. Read-only.
    fastify.get<{ Querystring: { cwd?: string } }>('/api/setup/orphaned-hooks', async (request, reply) => {
      const dirs = resolveTrackedCwds(request.query.cwd);
      if (dirs === null) {
        return reply.status(400).send({ error: 'cwd is not a directory Layman is tracking' });
      }
      const reports = dirs.flatMap((dir) => findOrphanedProjectHooks(dir, resolvedServerUrl()));
      return { reports };
    });

    // Repair — removes only Layman's own hook entries, preserving foreign hooks
    // and every other key. Restricted to tracked session directories so the
    // route cannot be used to rewrite settings anywhere on disk.
    fastify.post<{ Body?: { cwd?: string } }>('/api/setup/repair-hooks', async (request, reply) => {
      const dirs = resolveTrackedCwds(request.body?.cwd);
      if (dirs === null) {
        return reply.status(400).send({ error: 'cwd is not a directory Layman is tracking' });
      }
      const repaired = dirs.flatMap((dir) => repairOrphanedProjectHooks(dir, resolvedServerUrl()));
      if (repaired.length > 0) {
        fastify.log.info(
          `Removed ${repaired.reduce((n, r) => n + r.hookCount, 0)} orphaned Layman hook(s) from ${repaired.length} file(s)`,
        );
      }
      return { repaired };
    });

    // Setup install — install selected clients (by id array) or all if omitted
    fastify.post<{ Body: { clients?: string[] } }>('/api/setup/install', async (request) => {
      const installer = makeInstaller();
      const { clients } = request.body ?? {};
      if (clients && clients.length > 0) {
        for (const id of clients) installer.installClient(id);
        // Remove newly-installed clients from declinedClients
        activeConfig = updateConfig({
          declinedClients: (activeConfig.declinedClients ?? []).filter((c) => !clients.includes(c)),
        });
        saveConfig(activeConfig);
        broadcast({ type: 'session:config', config: activeConfig });
      } else {
        installer.install();
        installer.installCommand();
        installer.installOptionalClientCommands();
        installer.installCodexHooks();
        installer.installClineHooks();
      }
      return mergeRecordedCounts(
        mergeDeclined(installer.getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl),
        countRecordedSessionsByAgentType(db),
      );
    });

    // Setup install single client
    fastify.post<{ Params: { client: string } }>('/api/setup/install/:client', async (request) => {
      const { client } = request.params;
      const installer = makeInstaller();
      installer.installClient(client);
      activeConfig = updateConfig({
        declinedClients: (activeConfig.declinedClients ?? []).filter((c) => c !== client),
      });
      saveConfig(activeConfig);
      broadcast({ type: 'session:config', config: activeConfig });
      return mergeRecordedCounts(
        mergeDeclined(installer.getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl),
        countRecordedSessionsByAgentType(db),
      );
    });

    // Setup uninstall single client
    fastify.post<{ Params: { client: string } }>('/api/setup/uninstall/:client', async (request) => {
      const { client } = request.params;
      const installer = makeInstaller();
      installer.uninstallClient(client);
      return mergeRecordedCounts(
        mergeDeclined(installer.getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl),
        countRecordedSessionsByAgentType(db),
      );
    });

    // Record declined clients
    fastify.post<{ Body: { clients: string[] } }>('/api/setup/decline', async (request) => {
      const { clients } = request.body ?? {};
      if (clients && clients.length > 0) {
        activeConfig = updateConfig({
          declinedClients: [...new Set([...(activeConfig.declinedClients ?? []), ...clients])],
        });
        saveConfig(activeConfig);
        broadcast({ type: 'session:config', config: activeConfig });
      }
      return { ok: true };
    });

    // Remove a client from the declined list (without installing it)
    fastify.post<{ Params: { client: string } }>('/api/setup/undecline/:client', async (request) => {
      const { client } = request.params;
      activeConfig = updateConfig({
        declinedClients: (activeConfig.declinedClients ?? []).filter((c) => c !== client),
      });
      saveConfig(activeConfig);
      broadcast({ type: 'session:config', config: activeConfig });
      return mergeDeclined(makeInstaller().getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl);
    });

    // Open WebUI: install filter function via the Open WebUI REST API.
    // Accepts optional { url, apiKey } in the request body so the client can pass the current
    // form values without waiting for a config:update WebSocket round-trip first.
    fastify.post<{ Body?: { url?: string; apiKey?: string } }>(
      '/api/setup/openwebui/install',
      async (request, reply) => {
        const url = (request.body?.url ?? activeConfig.openWebUiUrl)?.trim();
        const apiKey = (request.body?.apiKey ?? activeConfig.openWebUiApiKey)?.trim();
        if (!url) return reply.status(400).send({ error: 'openWebUiUrl not configured' });
        const installer = makeInstaller();
        try {
          await installer.installOpenWebUIFunction(url, apiKey ?? '');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return reply.status(400).send({ error: msg });
        }
        return mergeRecordedCounts(
        mergeDeclined(installer.getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl),
        countRecordedSessionsByAgentType(db),
      );
      },
    );

    // Open WebUI: uninstall filter function
    fastify.post('/api/setup/openwebui/uninstall', async (_request, reply) => {
      const url = activeConfig.openWebUiUrl?.trim();
      const apiKey = activeConfig.openWebUiApiKey?.trim();
      if (!url) return reply.status(400).send({ error: 'openWebUiUrl not configured' });
      const installer = makeInstaller();
      try {
        await installer.uninstallOpenWebUIFunction(url, apiKey ?? '');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: msg });
      }
      return mergeRecordedCounts(
        mergeDeclined(installer.getStatus(), activeConfig.declinedClients ?? [], activeConfig.openWebUiUrl),
        countRecordedSessionsByAgentType(db),
      );
    });

    // Open WebUI: probe common URLs in parallel to auto-detect a running instance
    fastify.post('/api/setup/openwebui/detect', async (_request, reply) => {
      const candidates = [
        'http://host.docker.internal:3000',
        'http://host.docker.internal:8080',
        'http://localhost:3000',
        'http://localhost:8080',
      ];
      const results = await Promise.all(
        candidates.map(async (url) => {
          try {
            const res = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
              const data = await res.json().catch(() => ({})) as { version?: string };
              return { detected: true as const, url, version: data.version ?? null };
            }
          } catch { /* not reachable */ }
          return null;
        })
      );
      const found = results.find((r) => r !== null) ?? null;
      return reply.send(found ?? { detected: false, url: null, version: null });
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
      // Harnesses whose integration polls the prompt queue and can inject the
      // result back into a running session. Everything else has no way to
      // receive a prompt it did not solicit.
      if (session.agentType !== 'opencode' && session.agentType !== 'pi') {
        return reply.status(400).send({
          error: `Prompt submission is not supported for ${session.agentType} sessions`,
        });
      }

      // pi has no HTTP surface of its own; its extension polls the queue and
      // calls pi.sendUserMessage(), which is strictly simpler than OpenCode's
      // HTTP-or-subprocess dance below.
      if (session.agentType === 'pi') {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        promptQueue.push({ id, sessionId, prompt: prompt.trim(), queuedAt: Date.now() });
        return { ok: true, method: 'queued' };
      }

      // Try OpenCode HTTP API first (only works when started with --port).
      // session.cwd is intentionally NOT passed through filterCwd here: this
      // is a same-host request to the local OpenCode process, which needs
      // the literal filesystem path to route the prompt — a redacted "~/..."
      // value would not resolve correctly. Never log or surface this URL.
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

    // ─── Prompt relay ─────────────────────────────────────────────────────
    // Polled by any harness integration that can inject a prompt into a running
    // session (the OpenCode plugin and the pi extension today).
    //
    // The `/api/opencode/*` spellings predate pi and are kept as aliases: an
    // OpenCode plugin installed before this change is a file on the user's disk
    // that we do not control the update timing of, and it polls the old path
    // forever until they reinstall.

    function takePendingPrompt(sessionIdsCsv: string) {
      const ids = sessionIdsCsv.split(',').filter(Boolean);
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

    function dequeuePrompt(id: string) {
      const idx = promptQueue.findIndex((p) => p.id === id);
      if (idx >= 0) promptQueue.splice(idx, 1);
      return { ok: true };
    }

    for (const path of ['/api/prompts/pending', '/api/opencode/pending-prompt']) {
      fastify.get<{ Querystring: { sessionIds?: string } }>(
        path,
        async (request) => takePendingPrompt(request.query.sessionIds ?? ''),
      );
    }

    for (const path of ['/api/prompts/pending/:id', '/api/opencode/pending-prompt/:id']) {
      fastify.delete<{ Params: { id: string } }>(
        path,
        async (request) => dequeuePrompt(request.params.id),
      );
    }

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
      // Bookmarks that were inside this folder are now unfiled (folder_id set to
      // NULL server-side via ON DELETE SET NULL). Clients reassign folderId
      // locally off this single event — see removeFolder in sessionStore.ts.
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

    fastify.get<{ Params: { sessionId: string }; Querystring: { idleThresholdMinutes?: string } }>('/api/bookmarks/sessions/:sessionId/time-metrics', async (request, reply) => {
      const { sessionId } = request.params;
      const session = bookmarkStore.getRecordedSession(sessionId);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      const threshold = request.query.idleThresholdMinutes
        ? Math.max(1, Math.min(60, parseInt(request.query.idleThresholdMinutes, 10) || 5))
        : (config.idleThresholdMinutes ?? 5);
      const events = bookmarkStore.getEventsForSession(sessionId);
      return computeTimeMetrics(events, threshold);
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

    // Lightweight per-session match counts for the Sessions sidebar search — matches session
    // name, cwd, AND recorded event content (reuses the same LIKE-based search as /api/search).
    fastify.get<{ Querystring: { q?: string } }>('/api/bookmarks/search', async (request) => {
      const q = (request.query.q ?? '').trim();
      if (!q) return { results: [] };

      const eventMatches = searchEvents(db, { query: q, fields: ['allText'], limit: 1 }).sessions;
      const matchCounts = new Map<string, number>(eventMatches.map((s) => [s.sessionId, s.matchCount]));

      const terms = parseSearchQuery(q);
      for (const session of bookmarkStore.listRecordedSessions()) {
        const nameMatch = matchesSearchTerms(session.sessionName ?? '', terms);
        const cwdMatch = matchesSearchTerms(session.cwd ?? '', terms);
        if (nameMatch || cwdMatch) {
          const bonus = (nameMatch ? 1 : 0) + (cwdMatch ? 1 : 0);
          matchCounts.set(session.sessionId, (matchCounts.get(session.sessionId) ?? 0) + bonus);
        }
      }

      const results = Array.from(matchCounts.entries()).map(([sessionId, matchCount]) => ({ sessionId, matchCount }));
      return { results };
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
          updateSession.run(filterCwd(s.cwd), s.agentType, s.lastSeen, s.sessionId);
        }
      }
      const savedSessionIds = [...new Set(toSave.map((e) => e.sessionId))];
      return { ok: true, eventCount: toSave.length, sessionIds: savedSessionIds };
    });

    // Highlight folders
    fastify.get('/api/highlights/folders', async () => {
      return { folders: highlightStore.listFolders() };
    });

    fastify.post<{ Body: { name: string } }>('/api/highlights/folders', async (request, reply) => {
      const name = (request.body.name ?? '').trim();
      if (!name) return reply.status(400).send({ error: 'name is required' });
      const folder = highlightStore.createFolder(name);
      broadcast({ type: 'highlights:folder:created', folder });
      return { folder };
    });

    fastify.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/highlights/folders/:id', async (request, reply) => {
      const { id } = request.params;
      const name = (request.body.name ?? '').trim();
      if (!name) return reply.status(400).send({ error: 'name is required' });
      const folder = highlightStore.renameFolder(id, name);
      if (!folder) return reply.status(404).send({ error: 'Folder not found' });
      broadcast({ type: 'highlights:folder:updated', folder });
      return { folder };
    });

    fastify.delete<{ Params: { id: string } }>('/api/highlights/folders/:id', async (request) => {
      highlightStore.deleteFolder(request.params.id);
      // Same as bookmarks: highlights that were inside this folder are now
      // unfiled via ON DELETE SET NULL. Clients already reassign folderId
      // locally off this event — see removeHighlightFolder in sessionStore.ts.
      broadcast({ type: 'highlights:folder:deleted', folderId: request.params.id });
      return { ok: true };
    });

    fastify.post<{ Body: { ids: string[] } }>('/api/highlights/folders/reorder', async (request) => {
      const { ids } = request.body;
      highlightStore.reorderFolders(ids);
      const idSet = new Set(ids);
      for (const folder of highlightStore.listFolders().filter((f) => idSet.has(f.id))) {
        broadcast({ type: 'highlights:folder:updated', folder });
      }
      return { ok: true };
    });

    // Highlights
    fastify.get('/api/highlights', async () => {
      return { highlights: highlightStore.listAllHighlights() };
    });

    fastify.post<{ Body: { sessionId: string; promptEventId: string; responseEventId: string; name: string; folderId?: string | null } }>('/api/highlights', async (request, reply) => {
      const { sessionId, promptEventId, responseEventId, folderId } = request.body;
      const name = (request.body.name ?? '').trim();
      if (!name) return reply.status(400).send({ error: 'name is required' });
      const highlight = highlightStore.createHighlight(sessionId, promptEventId, responseEventId, name, folderId);
      broadcast({ type: 'highlights:created', highlight });
      return { highlight };
    });

    fastify.patch<{
      Params: { id: string };
      Body: { name?: string; folderId?: string | null; sortOrder?: number };
    }>('/api/highlights/:id', async (request, reply) => {
      const { id } = request.params;
      const { folderId, sortOrder } = request.body;
      const name = request.body.name !== undefined ? request.body.name.trim() : undefined;
      if (name !== undefined && name === '') return reply.status(400).send({ error: 'name cannot be empty' });
      const highlight = highlightStore.updateHighlight(id, { name, folderId, sortOrder });
      if (!highlight) return reply.status(404).send({ error: 'Highlight not found' });
      broadcast({ type: 'highlights:updated', highlight });
      return { highlight };
    });

    fastify.delete<{ Params: { id: string } }>('/api/highlights/:id', async (request) => {
      highlightStore.deleteHighlight(request.params.id);
      broadcast({ type: 'highlights:deleted', highlightId: request.params.id });
      return { ok: true };
    });

    fastify.post<{ Body: { folderId: string | null; ids: string[] } }>('/api/highlights/reorder', async (request) => {
      const { folderId, ids } = request.body;
      highlightStore.reorderHighlights(folderId, ids);
      for (const highlight of highlightStore.listHighlightsByFolder(folderId)) {
        broadcast({ type: 'highlights:updated', highlight });
      }
      return { ok: true };
    });

    fastify.get<{ Params: { id: string } }>('/api/highlights/:id/events', async (request, reply) => {
      const highlight = highlightStore.getHighlight(request.params.id);
      if (!highlight) return reply.status(404).send({ error: 'Highlight not found' });
      const promptEvent = eventStore.get(highlight.promptEventId) ?? bookmarkStore.getEventById(highlight.promptEventId);
      const responseEvent = eventStore.get(highlight.responseEventId) ?? bookmarkStore.getEventById(highlight.responseEventId);
      return { promptEvent, responseEvent };
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
          serverVersion: SERVER_VERSION,
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

        // Send current sessions list with active flags
        ws.send(JSON.stringify({
          type: 'sessions:list',
          sessions: buildSessionsList(),
        } satisfies ServerMessage));

        // Send bookmarks state
        ws.send(JSON.stringify({
          type: 'bookmarks:state',
          folders: bookmarkStore.listFolders(),
          bookmarks: bookmarkStore.listAllBookmarks(),
        } satisfies ServerMessage));

        // Send highlights state
        const allHighlights = highlightStore.listAll();
        ws.send(JSON.stringify({
          type: 'highlights:state',
          folders: allHighlights.folders,
          highlights: allHighlights.highlights,
        } satisfies ServerMessage));

        // Send current drift state for active sessions
        for (const session of buildSessionsList()) {
          const driftState = driftMonitor.getState(session.sessionId);
          if (driftState) {
            ws.send(JSON.stringify({
              type: 'drift:update',
              sessionId: session.sessionId,
              state: driftState,
            } satisfies ServerMessage));
          }
        }

        // Send any in-flight token streams. Without this, opening the dashboard
        // mid-generation shows nothing until the next delta — and if the agent
        // has just gone quiet, nothing at all.
        for (const stream of liveStreams.getAll()) {
          ws.send(JSON.stringify({
            type: 'stream:update',
            sessionId: stream.sessionId,
            stream,
          } satisfies ServerMessage));
        }

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
        const event = eventStore.get(message.eventId) ?? bookmarkStore.getEventById(message.eventId);
        if (!event) break;

        const ctx = buildSessionContext(event.sessionId, event.id, message.model);
        void (async () => {
          try {
            broadcast({ type: 'analysis:start', eventId: message.eventId });
            const result = await analysisEngine.analyze({
              toolName: event.data.toolName ?? 'Unknown',
              toolInput: event.data.toolInput ?? {},
              toolOutput: event.data.toolOutput,
              cwd: process.cwd(),
              depth: message.depth,
              recentEvents: ctx.recentEvents,
              sessionSummary: ctx.sessionSummary,
              modelOverride: message.model,
            }, 'high');
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
        const event = eventStore.get(message.eventId) ?? bookmarkStore.getEventById(message.eventId);
        if (!event) break;

        const ctx = buildSessionContext(event.sessionId, event.id, message.model);
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
                recentEvents: ctx.recentEvents,
                sessionSummary: ctx.sessionSummary,
                modelOverride: message.model,
              },
              activeConfig.laymansPrompt,
              'high',
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
        const event = eventStore.get(message.eventId) ?? bookmarkStore.getEventById(message.eventId);
        if (!event) break;

        const ctx = buildSessionContext(event.sessionId, event.id, message.model);
        const req = {
          toolName: event.data.toolName ?? 'Unknown',
          toolInput: event.data.toolInput ?? {},
          toolOutput: event.data.toolOutput,
          cwd: process.cwd(),
          depth: message.depth,
          recentEvents: ctx.recentEvents,
          sessionSummary: ctx.sessionSummary,
          modelOverride: message.model,
        };

        // Run both in parallel — the engine's concurrency limit + pacer handle rate limiting
        void (async () => {
          try {
            broadcast({ type: 'laymans:start', eventId: message.eventId });
            const result = await analysisEngine.laymans(req, activeConfig.laymansPrompt, 'high');
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
            const result = await analysisEngine.analyze(req, 'high');
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
            }, 'high');
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
        const prevDriftEnabled = activeConfig.driftMonitoring.enabled;
        const prevBlockOnRed = activeConfig.driftMonitoring.blockOnRed;
        activeConfig = updateConfig(message.config);
        analysisEngine.configure(activeConfig.analysis);
        pendingManager.setHookTimeout(activeConfig.hookTimeout);
        saveConfig(activeConfig);
        broadcast({ type: 'session:config', config: activeConfig });
        // Release drift blocks if drift blocking was effectively disabled
        const wasDriftBlocking = prevDriftEnabled && prevBlockOnRed;
        const isDriftBlocking = activeConfig.driftMonitoring.enabled && activeConfig.driftMonitoring.blockOnRed;
        if (wasDriftBlocking && !isDriftBlocking) {
          pendingManager.releaseDriftBlocks();
        }
        break;
      }
      case 'setup:install': {
        const resolvedHookUrl = activeConfig.hookUrl ?? `http://${activeConfig.host}:${activeConfig.port}`;
        const installer = new HookInstaller({
          serverUrl: resolvedHookUrl,
          hookTimeout: activeConfig.hookTimeout,
        });
        const clientsToInstall = message.clients;
        if (clientsToInstall && clientsToInstall.length > 0) {
          for (const id of clientsToInstall) installer.installClient(id);
          activeConfig = updateConfig({
            declinedClients: (activeConfig.declinedClients ?? []).filter((c) => !clientsToInstall.includes(c)),
          });
          saveConfig(activeConfig);
          broadcast({ type: 'session:config', config: activeConfig });
        } else {
          installer.install();
          installer.installCommand();
          installer.installOptionalClientCommands();
          installer.installCodexHooks();
          installer.installClineHooks();
        }
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
      case 'drift:reset': {
        driftMonitor.resetScores(message.sessionId);
        break;
      }
      case 'drift:dismiss': {
        driftMonitor.resetScores(message.sessionId);
        pendingManager.resolveApproval(message.approvalId, {
          decision: 'allow',
          reason: 'Dismissed as false positive — drift scores reset',
        });
        break;
      }
      case 'drift:dismiss-item': {
        driftMonitor.dismissItem(message.sessionId, message.category, message.value);
        break;
      }
    }
  }

  // Register hook handler routes
  registerHookHandler(fastify, pendingManager, eventStore, analysisEngine, getConfig, gate, driftMonitor, liveStreams);
  registerClineHookHandler(fastify, pendingManager, eventStore, analysisEngine, getConfig, gate);
  registerOpenWebUIHookHandler(fastify, eventStore, gate, db);

  let resolvedPort = config.port;

  return {
    async start() {
      await registerPlugins();
      registerRoutes();
      vibeWatcher.start();
      piWatcher.start();

      if (getConfig().recordingRecovery && getConfig().sessionRecording) {
        void recoverSessionGaps(db, eventStore).then(({ events, sessions }) => {
          if (events > 0) console.log(`[recovery] Startup scan filled ${events} events across ${sessions} session${sessions === 1 ? '' : 's'}`);
        });
      }

      if (getConfig().historyImport) {
        void importHistoricalSessions(db, eventStore, recorder, { gloveRoots: gloveSource.roots() }).then(({ discovered, totalEvents }) => {
          if (discovered > 0) console.log(`[import] Discovered ${discovered} historical sessions (${totalEvents} events)`);
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
      piWatcher.stop();
      liveStreams.stop();
      await fastify.close();
    },

    getPort() {
      return resolvedPort;
    },
  };
}

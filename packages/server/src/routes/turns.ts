/**
 * The read API for turns — Layman's data-egress spine.
 *
 * Registered as a single call from server.ts so this file, not server.ts, owns
 * the surface area.
 */
import type { FastifyInstance } from 'fastify';
import type { TurnStore } from '../turns/store.js';
import type { BookmarkStore } from '../db/bookmarks.js';
import type { LaymanConfig } from '../config/schema.js';
import { sessionToMarkdown, turnToMarkdown } from '../export/markdown.js';
import { resolveInstanceUrl } from '../export/urls.js';
import type { MarkdownOpts } from '../export/markdown.js';

export interface TurnRouteDeps {
  turnStore: TurnStore;
  bookmarkStore: BookmarkStore;
  getConfig: () => LaymanConfig;
}

/** Text fields longer than this are truncated in list responses. */
const SUMMARY_MAX_CHARS = 2048;

function truncate(text: string): string {
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS)}…` : text;
}

export function registerTurnRoutes(fastify: FastifyInstance, deps: TurnRouteDeps): void {
  const { turnStore, bookmarkStore, getConfig } = deps;

  const instanceUrl = () => resolveInstanceUrl(getConfig());

  const markdownOpts = (query: { toolCalls?: string; analysis?: string }): MarkdownOpts => ({
    instanceUrl: instanceUrl(),
    includeToolCalls:
      query.toolCalls === 'none' || query.toolCalls === 'full' ? query.toolCalls : 'summary',
    includeAnalysis: query.analysis !== 'false',
  });

  /** 404 bodies name the instance, so a client can tell *which* Layman came up empty. */
  const notFound = (what: string) => ({ error: `${what} not found`, instance: instanceUrl() });

  // ── List a session's turns (summary) ───────────────────────────────────────
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/sessions/:sessionId/turns',
    async (request, reply) => {
      const { sessionId } = request.params;
      const turns = turnStore.listTurns(sessionId);
      if (turns.length === 0 && !bookmarkStore.getRecordedSession(sessionId)) {
        return reply.status(404).send(notFound('Session'));
      }
      return {
        turns: turns.map((turn) => ({
          ...turn,
          promptText: truncate(turn.promptText),
          responseText: truncate(turn.responseText),
          thinkingText: null,
        })),
      };
    },
  );

  // ── A single turn, full text or markdown ───────────────────────────────────
  fastify.get<{
    Params: { sessionId: string; promptEventId: string };
    Querystring: { format?: string; toolCalls?: string; analysis?: string };
  }>('/api/turns/:sessionId/:promptEventId', async (request, reply) => {
    const { sessionId, promptEventId } = request.params;
    const turn = turnStore.getTurn(sessionId, promptEventId);
    if (!turn) return reply.status(404).send(notFound('Turn'));

    if (request.query.format === 'md') {
      // Same fallback getTurn() used internally to find the turn — going straight
      // to bookmarkStore here would silently return [] for a live session that
      // hasn't been persisted to SQLite yet, dropping tool-call/explanation sections.
      const events = turnStore.eventsFor(sessionId);
      const owned = new Set(turn.eventIds);
      const markdown = turnToMarkdown(
        turn,
        events.filter((e) => owned.has(e.id)),
        markdownOpts(request.query),
      );
      return reply.type('text/markdown; charset=utf-8').send(markdown);
    }

    return { turn };
  });

  // ── Whole-session export ───────────────────────────────────────────────────
  fastify.get<{
    Params: { sessionId: string };
    Querystring: { format?: string; toolCalls?: string; analysis?: string };
  }>('/api/sessions/:sessionId/export', async (request, reply) => {
    const { sessionId } = request.params;
    const session = bookmarkStore.getRecordedSession(sessionId);
    if (!session) return reply.status(404).send(notFound('Session'));

    const events = bookmarkStore.getEventsForSession(sessionId);

    if (request.query.format === 'md') {
      const markdown = sessionToMarkdown(
        session,
        turnStore.listTurns(sessionId),
        events,
        markdownOpts(request.query),
      );
      return reply.type('text/markdown; charset=utf-8').send(markdown);
    }

    // JSON shape is deliberately the one POST /api/bookmarks/sessions/import
    // accepts, so export → import round-trips without translation.
    return { events };
  });

  // ── Id resolution (full uuid or >= 8-char prefix) ──────────────────────────
  fastify.get<{ Querystring: { id?: string } }>('/api/resolve', async (request, reply) => {
    const id = request.query.id;
    if (!id) return reply.status(400).send({ error: 'Missing id parameter' });

    const resolved = turnStore.resolveId(id);
    if (!resolved) return reply.status(404).send(notFound('Id'));
    if ('ambiguous' in resolved) {
      return reply.status(409).send({ error: 'Ambiguous id prefix', candidates: resolved.candidates });
    }
    return resolved;
  });
}

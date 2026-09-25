/**
 * REST surface for network views (plan §4.2). Registered by one call from
 * server.ts, as `routes/turns.ts` is. The rules write route and the
 * `net:rules:apply` WebSocket message share `NetObs.applyRules`.
 */
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { NetObs, RulesOp } from './index.js';

const OP_KINDS = new Set([
  'blockHost', 'blockDomain', 'blockIp', 'blockGroup', 'allowHost', 'allowDomain', 'removeRule', 'setDefault',
  'cutAll', 'restoreAll', 'saveDraft', 'revert', 'rewrite',
]);

const WINDOWS: Record<string, number | 'session'> = {
  '60s': 60_000,
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  session: 'session',
};

export function registerNetRoutes(fastify: FastifyInstance, deps: { netObs: NetObs }): void {
  const { netObs } = deps;
  const store = netObs.store;
  const notFound = (token: string) => ({ error: `No glove network session '${token}'` });

  fastify.get('/api/net/sessions', async () => ({ sessions: netObs.sessions() }));

  fastify.get<{ Params: { token: string } }>('/api/net/sessions/:token', async (request, reply) => {
    const snapshot = store.snapshot(request.params.token);
    return snapshot ?? reply.status(404).send(notFound(request.params.token));
  });

  fastify.get<{ Params: { token: string }; Querystring: { since?: string; limit?: string } }>(
    '/api/net/sessions/:token/flows',
    async (request, reply) => {
      const since = Number(request.query.since ?? 0);
      const limit = Math.min(5_000, Math.max(1, Number(request.query.limit ?? 500) || 500));
      const flows = store.flows(request.params.token, Number.isFinite(since) ? since : 0, limit);
      return flows ? { flows } : reply.status(404).send(notFound(request.params.token));
    },
  );

  fastify.get<{ Params: { token: string }; Querystring: { window?: string } }>(
    '/api/net/sessions/:token/buckets',
    async (request, reply) => {
      const name = request.query.window ?? '60s';
      const window = WINDOWS[name];
      if (window === undefined) {
        return reply.status(400).send({ error: `window must be one of ${Object.keys(WINDOWS).join(', ')}` });
      }
      const buckets = store.buckets(request.params.token, window);
      return buckets ? { window: name, buckets } : reply.status(404).send(notFound(request.params.token));
    },
  );

  fastify.get<{ Params: { token: string } }>('/api/net/sessions/:token/rules', async (request, reply) => {
    const rules = store.rules(request.params.token);
    return rules ? { rules } : reply.status(404).send(notFound(request.params.token));
  });

  // Whether the write reached disk is the response; whether the gate took it
  // is `rules.write.state` (poll GET, or watch `net:rules`).
  fastify.post<{ Params: { token: string }; Body: { op?: RulesOp; opId?: string } }>(
    '/api/net/sessions/:token/rules',
    async (request, reply) => {
      const { token } = request.params;
      if (!store.location(token)) return reply.status(404).send(notFound(token));
      const op = request.body?.op;
      if (!op || typeof op !== 'object' || !OP_KINDS.has(op.kind)) {
        return reply.status(400).send({ error: `op.kind must be one of ${[...OP_KINDS].join(', ')}` });
      }
      const opId = typeof request.body?.opId === 'string' ? request.body.opId : randomUUID();
      const result = netObs.applyRules(token, op, opId);
      return reply.status(result.ok ? 200 : 409).send({ ...result, opId, rules: store.rules(token) });
    },
  );
}

/**
 * A thin pass-through to a speaches server (OpenAI-compatible TTS).
 *
 * This proxy exists for two concrete reasons, not as a matter of taste:
 *
 *  1. **speaches ships with CORS off** unless it was started with
 *     `allow_origins`, so a browser `fetch()` straight from the Layman origin to
 *     `http://localhost:8000/v1/audio/speech` is blocked out of the box.
 *  2. speaches supports an optional bearer `api_key`, and sending it from the
 *     browser would put it in client code.
 *
 * Users who *have* set `allow_origins` can flip `tts.direct` and skip all of
 * this; the client then calls speaches itself. The proxy stays the default.
 *
 * Nothing is cached or written to disk here — audio is streamed straight back.
 * Triggering and playback are entirely browser-side by design.
 */
import { Readable } from 'stream';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { LaymanConfig } from '../config/schema.js';
import { resolveEndpoint } from '../analysis/providers/openai-compat.js';

export interface TtsRouteDeps {
  getConfig: () => LaymanConfig;
}

/** A cold model load in speaches is genuinely slow the first time. */
const UPSTREAM_TIMEOUT_MS = 60_000;

interface SpeechBody {
  text?: string;
  voice?: string;
  speed?: number;
  model?: string;
  format?: string;
}

/**
 * The upstream base URL, with localhost rewritten to host.docker.internal when
 * we are containerised. Same helper the analysis providers use — a second
 * implementation of this rewrite would be one more place to get it wrong.
 */
function upstreamBase(config: LaymanConfig): string {
  return resolveEndpoint((config.tts.endpoint || 'http://localhost:8000').replace(/\/+$/, ''));
}

function authHeaders(config: LaymanConfig): Record<string, string> {
  return config.tts.apiKey ? { Authorization: `Bearer ${config.tts.apiKey}` } : {};
}

async function fetchUpstream(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError whose message ("The
    // operation was aborted due to timeout") does not say what timed out.
    if (err.name === 'TimeoutError') return `speaches did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`;
    return err.message;
  }
  return String(err);
}

/**
 * speaches is FastAPI, so its errors arrive as `{"detail": "..."}`. Unwrapping
 * that here is the difference between the settings panel showing
 * `Speed must be between 0.5 and 2.0, got 99.0` and showing a JSON string with
 * escaped quotes in it. The message itself is never paraphrased — it is the
 * diagnosis, and speaches words it better than we could.
 */
export function upstreamErrorMessage(body: string, status: number): string {
  if (!body) return `speaches returned HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    if (typeof parsed.detail === 'string') return parsed.detail;
    // 422s from FastAPI validation carry an array of per-field objects.
    if (Array.isArray(parsed.detail)) {
      const parts = parsed.detail
        .map((d) => (typeof d === 'object' && d !== null && 'msg' in d ? String((d as { msg: unknown }).msg) : null))
        .filter((m): m is string => !!m);
      if (parts.length) return parts.join('; ');
    }
  } catch { /* not JSON — the raw body is the message */ }
  return body;
}

/** Forward an upstream failure with its status and a readable message. */
async function relayUpstreamError(reply: FastifyReply, res: Response): Promise<FastifyReply> {
  const body = await res.text().catch(() => '');
  return reply.status(res.status).send({ error: upstreamErrorMessage(body, res.status) });
}

/**
 * Flatten a speaches list response to plain ids.
 *
 * The two list endpoints do not agree on a shape: `/v1/models` returns
 * `{data: [...]}` and `/v1/audio/voices` returns `{voices: [...]}`, and entries
 * are objects keyed `id` (voices additionally carry a `name`). Normalising here
 * means the settings panel deals with one shape — a string list — and neither
 * side has to know which endpoint it came from.
 */
export function toIdList(payload: unknown): string[] {
  const entries = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown[]; voices?: unknown[] })?.data
      ?? (payload as { voices?: unknown[] })?.voices
      ?? [];

  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = entry as { id?: unknown; name?: unknown };
      if (typeof record?.id === 'string') return record.id;
      if (typeof record?.name === 'string') return record.name;
      return null;
    })
    .filter((id): id is string => !!id);
}

export function registerTtsRoutes(fastify: FastifyInstance, deps: TtsRouteDeps): void {
  const { getConfig } = deps;

  // ── Synthesis ──────────────────────────────────────────────────────────────
  fastify.post<{ Body: SpeechBody }>('/api/tts/speech', async (request, reply) => {
    const config = getConfig();
    const body = request.body ?? {};

    const text = (body.text ?? '').trim();
    if (!text) return reply.status(400).send({ error: 'No text to speak' });

    // Clamped server-side as well as client-side: the client cap is a UX
    // nicety, this one is the actual bound on what we send upstream.
    const input = text.slice(0, config.tts.maxChars);
    const format = body.format ?? 'mp3';

    let res: Response;
    try {
      res = await fetchUpstream(`${upstreamBase(config)}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
        body: JSON.stringify({
          model: body.model ?? config.tts.model,
          input,
          voice: body.voice ?? config.tts.voice,
          speed: body.speed ?? config.tts.speed,
          response_format: format,
        }),
      });
    } catch (err) {
      return reply.status(502).send({ error: errorMessage(err) });
    }

    if (!res.ok) return relayUpstreamError(reply, res);
    if (!res.body) return reply.status(502).send({ error: 'speaches returned an empty response' });

    // Stream rather than buffer: a long response is a large file, and Fastify's
    // raised body limit is headroom for something else entirely.
    // Fastify 4 sends Node streams, not the web ReadableStream fetch returns.
    return reply
      .type(res.headers.get('content-type') ?? `audio/${format}`)
      .send(Readable.fromWeb(res.body as NodeWebReadableStream));
  });

  // ── Voice list (never hardcode these — they depend on installed models) ────
  fastify.get('/api/tts/voices', async (_request, reply) => {
    const config = getConfig();
    try {
      const res = await fetchUpstream(`${upstreamBase(config)}/v1/audio/voices`, {
        headers: authHeaders(config),
      });
      if (!res.ok) return relayUpstreamError(reply, res);
      return { voices: toIdList(await res.json()) };
    } catch (err) {
      return reply.status(502).send({ error: errorMessage(err) });
    }
  });

  // ── Model list ─────────────────────────────────────────────────────────────
  fastify.get('/api/tts/models', async (_request, reply) => {
    const config = getConfig();
    try {
      const res = await fetchUpstream(`${upstreamBase(config)}/v1/models`, {
        headers: authHeaders(config),
      });
      if (!res.ok) return relayUpstreamError(reply, res);
      return { models: toIdList(await res.json()) };
    } catch (err) {
      return reply.status(502).send({ error: errorMessage(err) });
    }
  });

  // ── Connection test ────────────────────────────────────────────────────────
  // Synthesises a short phrase and discards the audio. Round-tripping real
  // synthesis is the point: reaching /v1/models proves nothing about whether
  // the configured voice and model can actually produce sound.
  fastify.post('/api/tts/test', async (_request, reply) => {
    const config = getConfig();
    const startedAt = Date.now();
    try {
      const res = await fetchUpstream(`${upstreamBase(config)}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
        body: JSON.stringify({
          model: config.tts.model,
          input: 'Layman is connected.',
          voice: config.tts.voice,
          speed: config.tts.speed,
          response_format: 'mp3',
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          error: upstreamErrorMessage(detail, res.status),
        };
      }

      const bytes = (await res.arrayBuffer()).byteLength;
      if (bytes === 0) {
        return { ok: false, latencyMs: Date.now() - startedAt, error: 'speaches returned no audio' };
      }
      return { ok: true, latencyMs: Date.now() - startedAt, bytes };
    } catch (err) {
      // A 200 with ok:false, not a 5xx: the request succeeded, the connection
      // it was testing did not, and the panel wants the message either way.
      return reply.status(200).send({ ok: false, latencyMs: Date.now() - startedAt, error: errorMessage(err) });
    }
  });
}

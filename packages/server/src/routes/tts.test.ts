import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTtsRoutes, toIdList, upstreamErrorMessage } from './tts.js';
import { LaymanConfigSchema, type LaymanConfig } from '../config/schema.js';

/** Records what the proxy sent upstream so assertions can inspect it. */
interface UpstreamCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let calls: UpstreamCall[] = [];
let config: LaymanConfig;
let app: FastifyInstance;

function audioResponse(bytes = 'ID3-fake-mp3', contentType = 'audio/mpeg'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
}

/** Installs a fetch stub that answers with `respond` and records the request. */
function stubFetch(respond: (call: UpstreamCall) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: UpstreamCall = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    };
    calls.push(call);
    return respond(call);
  });
}

beforeEach(async () => {
  calls = [];
  config = LaymanConfigSchema.parse({});
  app = Fastify();
  registerTtsRoutes(app, { getConfig: () => config });
  await app.ready();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

describe('POST /api/tts/speech', () => {
  it('forwards speaches field names and streams the audio back', async () => {
    stubFetch(() => audioResponse());

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/speech',
      payload: { text: 'Hello there' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.body).toBe('ID3-fake-mp3');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:8000/v1/audio/speech');
    // `input`, not `text` — the field names are speaches', per its request model.
    expect(calls[0].body).toEqual({
      model: config.tts.model,
      input: 'Hello there',
      voice: config.tts.voice,
      speed: config.tts.speed,
      response_format: 'mp3',
    });
  });

  it('lets the caller override model, voice, speed and format', async () => {
    stubFetch(() => audioResponse());

    await app.inject({
      method: 'POST',
      url: '/api/tts/speech',
      payload: { text: 'Hi', model: 'other-model', voice: 'af_sky', speed: 1.5, format: 'wav' },
    });

    expect(calls[0].body).toMatchObject({
      model: 'other-model',
      voice: 'af_sky',
      speed: 1.5,
      response_format: 'wav',
    });
  });

  it('rejects empty and whitespace-only text without calling upstream', async () => {
    stubFetch(() => audioResponse());

    for (const payload of [{}, { text: '' }, { text: '   \n ' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/tts/speech', payload });
      expect(res.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it('clamps text to maxChars server-side', async () => {
    config = LaymanConfigSchema.parse({ tts: { maxChars: 200 } });
    stubFetch(() => audioResponse());

    await app.inject({
      method: 'POST',
      url: '/api/tts/speech',
      payload: { text: 'a'.repeat(5000) },
    });

    expect(String(calls[0].body?.input)).toHaveLength(200);
  });

  it('sends a bearer token only when an api key is configured', async () => {
    stubFetch(() => audioResponse());

    await app.inject({ method: 'POST', url: '/api/tts/speech', payload: { text: 'Hi' } });
    expect(calls[0].headers.Authorization).toBeUndefined();

    config = LaymanConfigSchema.parse({ tts: { apiKey: 'sk-secret' } });
    await app.inject({ method: 'POST', url: '/api/tts/speech', payload: { text: 'Hi' } });
    expect(calls[1].headers.Authorization).toBe('Bearer sk-secret');
  });

  it('relays an upstream error with its status and a readable message', async () => {
    // speaches says something useful here, and the settings panel shows it.
    stubFetch(() => new Response('{"detail":"Speed must be between 0.5 and 2.0, got 99.0"}', { status: 422 }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/tts/speech',
      payload: { text: 'Hi', speed: 99 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Speed must be between 0.5 and 2.0, got 99.0' });
  });

  it('reports an unreachable speaches as 502 rather than throwing', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); });

    const res = await app.inject({ method: 'POST', url: '/api/tts/speech', payload: { text: 'Hi' } });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('ECONNREFUSED');
  });

  it('strips a trailing slash from the configured endpoint', async () => {
    config = LaymanConfigSchema.parse({ tts: { endpoint: 'http://speaches.local:9000/' } });
    stubFetch(() => audioResponse());

    await app.inject({ method: 'POST', url: '/api/tts/speech', payload: { text: 'Hi' } });

    expect(calls[0].url).toBe('http://speaches.local:9000/v1/audio/speech');
  });
});

describe('upstreamErrorMessage', () => {
  it('unwraps the FastAPI {detail} envelope speaches errors arrive in', () => {
    // Observed verbatim from a real speaches 0.9 build on an out-of-range speed.
    expect(upstreamErrorMessage('{"detail":"Speed must be between 0.5 and 2.0, got 99.0"}', 422))
      .toBe('Speed must be between 0.5 and 2.0, got 99.0');
  });

  it('joins FastAPI validation arrays into one line', () => {
    expect(upstreamErrorMessage(
      '{"detail":[{"msg":"field required","loc":["body","input"]},{"msg":"not a valid float"}]}',
      422,
    )).toBe('field required; not a valid float');
  });

  it('passes a non-JSON body through untouched', () => {
    expect(upstreamErrorMessage('Internal Server Error', 500)).toBe('Internal Server Error');
  });

  it('falls back to the status when the body is empty', () => {
    expect(upstreamErrorMessage('', 503)).toBe('speaches returned HTTP 503');
  });

  it('keeps JSON that has no detail key', () => {
    expect(upstreamErrorMessage('{"error":"nope"}', 400)).toBe('{"error":"nope"}');
  });
});

describe('toIdList', () => {
  // The two speaches list endpoints disagree on their envelope key, so the
  // normaliser has to cope with both plus the empty case a fresh install returns.
  it('reads the {voices: []} envelope /v1/audio/voices uses', () => {
    expect(toIdList({ voices: [{ id: 'af_heart' }, { id: 'af_sky' }], object: 'list' }))
      .toEqual(['af_heart', 'af_sky']);
  });

  it('reads the {data: []} envelope /v1/models uses', () => {
    expect(toIdList({ data: [{ id: 'speaches-ai/Kokoro-82M-v1.0-ONNX' }], object: 'list' }))
      .toEqual(['speaches-ai/Kokoro-82M-v1.0-ONNX']);
  });

  it('accepts a bare array and plain strings', () => {
    expect(toIdList(['a', { id: 'b' }])).toEqual(['a', 'b']);
  });

  it('falls back to name when there is no id', () => {
    expect(toIdList({ voices: [{ name: 'af_bella' }] })).toEqual(['af_bella']);
  });

  it('returns empty for a fresh install with no models downloaded', () => {
    expect(toIdList({ voices: [], object: 'list' })).toEqual([]);
    expect(toIdList({ data: [], object: 'list' })).toEqual([]);
    expect(toIdList(null)).toEqual([]);
  });

  it('drops entries with neither id nor name', () => {
    expect(toIdList({ data: [{ id: 'keep' }, {}, { other: 1 }] })).toEqual(['keep']);
  });
});

describe('GET /api/tts/voices', () => {
  it('flattens the installed voice list to ids', async () => {
    stubFetch(() => new Response(JSON.stringify({ voices: [{ id: 'af_heart' }, { id: 'af_sky' }], object: 'list' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));

    const res = await app.inject({ method: 'GET', url: '/api/tts/voices' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ voices: ['af_heart', 'af_sky'] });
    expect(calls[0].url).toBe('http://localhost:8000/v1/audio/voices');
  });

  it('surfaces an upstream failure', async () => {
    stubFetch(() => new Response('no such route', { status: 404 }));

    const res = await app.inject({ method: 'GET', url: '/api/tts/voices' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no such route' });
  });
});

describe('GET /api/tts/models', () => {
  it('flattens the OpenAI-shaped model list to ids', async () => {
    stubFetch(() => new Response(
      JSON.stringify({ data: [{ id: 'speaches-ai/Kokoro-82M-v1.0-ONNX' }, { id: 'rhasspy/piper-voices' }, {}] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const res = await app.inject({ method: 'GET', url: '/api/tts/models' });

    expect(res.json()).toEqual({
      models: ['speaches-ai/Kokoro-82M-v1.0-ONNX', 'rhasspy/piper-voices'],
    });
    expect(calls[0].url).toBe('http://localhost:8000/v1/models');
  });
});

describe('POST /api/tts/test', () => {
  it('round-trips real synthesis and reports latency', async () => {
    stubFetch(() => audioResponse());

    const res = await app.inject({ method: 'POST', url: '/api/tts/test' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.bytes).toBeGreaterThan(0);
    expect(typeof body.latencyMs).toBe('number');
    expect(calls[0].body).toMatchObject({ input: 'Layman is connected.' });
  });

  it('reports a connection failure as ok:false with the message, not a 5xx', async () => {
    // The request succeeded; the connection it was testing did not. The panel
    // wants the message either way, so a 5xx here would be the wrong signal.
    vi.stubGlobal('fetch', async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8000'); });

    const res = await app.inject({ method: 'POST', url: '/api/tts/test' });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().error).toContain('ECONNREFUSED');
  });

  it('treats an empty audio body as a failure', async () => {
    stubFetch(() => new Response('', { status: 200, headers: { 'content-type': 'audio/mpeg' } }));

    const res = await app.inject({ method: 'POST', url: '/api/tts/test' });

    expect(res.json()).toMatchObject({ ok: false, error: 'speaches returned no audio' });
  });

  it('reports an upstream HTTP error with its body', async () => {
    stubFetch(() => new Response('model not found', { status: 404 }));

    const res = await app.inject({ method: 'POST', url: '/api/tts/test' });

    expect(res.json()).toMatchObject({ ok: false, error: 'model not found' });
  });
});

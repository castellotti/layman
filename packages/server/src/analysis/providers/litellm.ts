import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { resolveEndpoint } from './openai-compat.js';
import type { AnalysisConfig, RawLLMResponse } from '../types.js';

/** Only retry on 429 (rate limit). 503 means the upstream model is down — retrying wastes quota. */
const RETRYABLE_STATUS_CODES = new Set([429]);
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 5000;

/**
 * LiteLLM-specific provider that uses streaming (required by some LiteLLM proxies):
 *   - stream: true
 *   - stream_options: { include_usage: true }
 *   - drop_params: true  (LiteLLM silently drops unsupported params)
 */
export class LiteLLMProvider {
  private client: OpenAI | null = null;
  private lastConfig: string | undefined;

  private getClient(config: AnalysisConfig): OpenAI {
    const resolved = resolveEndpoint(config.endpoint ?? '');
    const configKey = `${resolved}:${config.apiKey}`;
    if (!this.client || configKey !== this.lastConfig) {
      const apiKey =
        config.apiKey ??
        process.env.OPENAI_API_KEY ??
        process.env.LAYMAN_API_KEY ??
        'not-needed';

      this.client = new OpenAI({
        apiKey,
        baseURL: resolved,
      });
      this.lastConfig = configKey;
    }
    return this.client;
  }

  async analyze(
    systemPrompt: string,
    userMessage: string,
    config: AnalysisConfig
  ): Promise<RawLLMResponse> {
    const client = this.getClient(config);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // LiteLLM proxies may only support streaming for certain models
        // (e.g. Anthropic via LiteLLM). Always stream for compatibility.
        // `drop_params` is LiteLLM-specific (not in OpenAI types), hence the cast.
        const stream: Stream<ChatCompletionChunk> = await (client.chat.completions.create as Function)({
          model: config.model,
          max_tokens: config.maxTokens,
          temperature: config.temperature,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          stream: true,
          stream_options: { include_usage: true },
          drop_params: true,
        });

        // Collect streamed chunks into a single response
        let text = '';
        let promptTokens: number | undefined;
        let completionTokens: number | undefined;

        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens;
            completionTokens = chunk.usage.completion_tokens;
          }
        }

        return {
          text,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
          },
        };
      } catch (err: unknown) {
        lastErr = err;
        const status = (err as { status?: number }).status;
        if (status && RETRYABLE_STATUS_CODES.has(status) && attempt < MAX_RETRIES) {
          // Exponential backoff: 5s, 15s
          await new Promise((r) => setTimeout(r, BASE_DELAY_MS * 3 ** attempt));
          continue;
        }
        break;
      }
    }

    // Extract meaningful details from SDK errors
    const apiErr = lastErr as {
      status?: number;
      message?: string;
      error?: Record<string, unknown>;
    };
    const status = apiErr.status;
    const detail = extractErrorDetail(apiErr) ?? String(lastErr);
    const endpoint = config.endpoint ?? '(no endpoint)';
    throw new Error(
      `LiteLLM API error${status ? ` (HTTP ${status})` : ''}: ${detail} [model=${config.model}, endpoint=${endpoint}]`
    );
  }
}

/**
 * Extract a human-readable error message from the SDK error object.
 * Handles multiple response formats:
 *   - Standard OpenAI: { error: { message: "..." } }
 *   - LiteLLM/SAP proxy: { errorMessage: "{\"error\":{\"message\":\"...\"}}" }
 */
function extractErrorDetail(err: {
  message?: string;
  error?: Record<string, unknown>;
}): string | undefined {
  const body = err.error;
  if (!body) return err.message;

  // Standard OpenAI format
  if (typeof body.message === 'string' && body.message) return body.message;

  // LiteLLM / SAP proxy: errorMessage is a JSON string with nested error details
  if (typeof body.errorMessage === 'string') {
    try {
      const nested = JSON.parse(body.errorMessage) as { error?: { message?: string }; message?: string };
      const msg = nested.error?.message ?? nested.message;
      if (msg) return msg;
    } catch {
      // Not valid JSON — use the raw string
      return body.errorMessage;
    }
  }

  // Fallback: error field as string
  if (typeof body.error === 'string') return body.error;

  return err.message;
}

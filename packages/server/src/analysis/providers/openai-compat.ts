import { existsSync } from 'fs';
import OpenAI from 'openai';
import type { AnalysisConfig, RawLLMResponse } from '../types.js';

/**
 * When running inside Docker, `localhost` resolves to the container itself.
 * Rewrite localhost/127.0.0.1 to host.docker.internal so requests reach the host.
 */
function resolveEndpoint(url: string): string {
  if (!existsSync('/.dockerenv')) return url;
  return url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:\/]|$)/, '$1host.docker.internal');
}

export { resolveEndpoint };

export class OpenAICompatProvider {
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
        'not-needed'; // Local models often don't require a key

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

    try {
      const response = await client.chat.completions.create({
        model: config.model,
        max_tokens: config.maxTokens,
        temperature: config.temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });

      const text = response.choices[0]?.message?.content ?? '';
      const usage = response.usage;

      return {
        text,
        usage: {
          prompt_tokens: usage?.prompt_tokens,
          completion_tokens: usage?.completion_tokens,
        },
      };
    } catch (err: unknown) {
      // Extract meaningful details from OpenAI SDK errors (APIError, etc.)
      const apiErr = err as { status?: number; error?: { message?: string; error?: string }; message?: string };
      const status = apiErr.status;
      const detail =
        apiErr.error?.message ??
        apiErr.error?.error ??
        apiErr.message ??
        String(err);
      const endpoint = config.endpoint ?? '(no endpoint)';
      throw new Error(
        `${config.provider} API error${status ? ` (HTTP ${status})` : ''}: ${detail} [model=${config.model}, endpoint=${endpoint}]`
      );
    }
  }
}

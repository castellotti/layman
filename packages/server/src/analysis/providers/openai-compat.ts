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

/**
 * Basic OpenAI-compatible provider for local models (llama.cpp, Ollama, etc.).
 * No streaming, no special headers — just a straightforward chat completion.
 */
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
  }
}

import { existsSync } from 'fs';
import OpenAI from 'openai';
import type { AnalysisConfig, RawLLMResponse } from '../types.js';

/**
 * True when we are running inside a container. Docker writes `/.dockerenv`;
 * Podman (which Layman also supports as a container engine) writes
 * `/run/.containerenv` instead and never creates `/.dockerenv`, so both must
 * be checked or the host-rewrite below silently no-ops under Podman.
 */
function isContainerised(): boolean {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * When running inside a container, `localhost` resolves to the container itself.
 * Rewrite localhost/127.0.0.1 to host.docker.internal so requests reach the host.
 * Podman 4.7+ provides the same `host.docker.internal` alias (in addition to
 * `host.containers.internal`), so one target works for both engines.
 */
function resolveEndpoint(url: string): string {
  if (!isContainerised()) return url;
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

    const msg = response.choices[0]?.message;
    // Some providers (e.g. llama.cpp with Qwen3) return thinking tokens in reasoning_content
    // and the actual output in content. Fall back to reasoning_content if content is empty.
    const text = msg?.content || (msg as unknown as { reasoning_content?: string })?.reasoning_content || '';
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

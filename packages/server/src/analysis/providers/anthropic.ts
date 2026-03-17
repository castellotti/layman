import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisConfig, RawLLMResponse } from '../types.js';

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export class AnthropicProvider {
  private client: Anthropic | null = null;
  private lastApiKey: string | undefined;

  private getClient(apiKey: string | undefined): Anthropic {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.LAYMAN_API_KEY;
    if (!key) throw new Error('No Anthropic API key configured. Set ANTHROPIC_API_KEY or configure in settings.');

    if (!this.client || key !== this.lastApiKey) {
      this.client = new Anthropic({ apiKey: key });
      this.lastApiKey = key;
    }
    return this.client;
  }

  async analyze(
    systemPrompt: string,
    userMessage: string,
    config: AnalysisConfig
  ): Promise<RawLLMResponse> {
    const client = this.getClient(config.apiKey);
    const modelId = MODEL_ALIASES[config.model] ?? config.model;

    const response = await client.messages.create({
      model: modelId,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const text = textBlock?.type === 'text' ? textBlock.text : '';

    return {
      text,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }
}

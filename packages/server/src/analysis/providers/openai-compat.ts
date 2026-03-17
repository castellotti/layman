import OpenAI from 'openai';
import type { AnalysisConfig, RawLLMResponse } from '../types.js';

export class OpenAICompatProvider {
  private client: OpenAI | null = null;
  private lastConfig: string | undefined;

  private getClient(config: AnalysisConfig): OpenAI {
    const configKey = `${config.endpoint}:${config.apiKey}`;
    if (!this.client || configKey !== this.lastConfig) {
      const apiKey =
        config.apiKey ??
        process.env.OPENAI_API_KEY ??
        process.env.LAYMAN_API_KEY ??
        'not-needed'; // Some local models don't need keys

      this.client = new OpenAI({
        apiKey,
        baseURL: config.endpoint,
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

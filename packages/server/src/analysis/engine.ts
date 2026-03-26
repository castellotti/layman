import { AnalysisCache } from './cache.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { LiteLLMProvider } from './providers/litellm.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import {
  ANALYSIS_SYSTEM_PROMPT,
  INVESTIGATION_SYSTEM_PROMPT,
  buildLaymansSystemPrompt,
  formatAnalysisUserMessage,
  formatInvestigationUserMessage,
} from './prompt.js';
import type { AnalysisResult, AnalysisRequest, AnalysisConfig, InvestigationContext, LaymansResult } from './types.js';

const DEFAULT_CONFIG: AnalysisConfig = {
  provider: 'anthropic',
  model: 'sonnet',
  maxTokens: 400,
  temperature: 0.1,
};

// Allow 2 concurrent requests (Layman's Terms + Analysis in parallel)
const MAX_CONCURRENT = 2;

// Minimum gap between proxy requests (ms) to stagger concurrent requests slightly
const MIN_REQUEST_GAP_MS = 1000;

export class AnalysisEngine {
  private config: AnalysisConfig;
  private cache = new AnalysisCache();
  private anthropicProvider = new AnthropicProvider();
  private litellmProvider = new LiteLLMProvider();
  private openaiProvider = new OpenAICompatProvider();
  private activeRequests = 0;
  private queue: Array<() => void> = [];
  private lastRequestTime = 0;

  constructor(config?: Partial<AnalysisConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  configure(config: Partial<AnalysisConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private async withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeRequests >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.activeRequests++;
    try {
      // Enforce minimum gap between requests to avoid overwhelming rate-limited proxies
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < MIN_REQUEST_GAP_MS) {
        await new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS - elapsed));
      }
      this.lastRequestTime = Date.now();
      return await fn();
    } finally {
      this.activeRequests--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    // Check cache first
    const cached = this.cache.get(request.toolName, request.toolInput, request.depth);
    if (cached) return cached;

    const effectiveConfig = {
      ...this.config,
      maxTokens: request.depth === 'detailed' ? 1200 : 400,
    };

    const result = await this.withConcurrencyLimit(async () => {
      const startTime = Date.now();
      const userMessage = formatAnalysisUserMessage(request);

      const raw = await this.callProvider(ANALYSIS_SYSTEM_PROMPT, userMessage, effectiveConfig);
      const latencyMs = Date.now() - startTime;

      const parsed = this.parseAnalysisResponse(raw.text, effectiveConfig.model, latencyMs, raw);
      return parsed;
    });

    this.cache.set(request.toolName, request.toolInput, request.depth, result);
    return result;
  }

  async ask(
    question: string,
    context: InvestigationContext
  ): Promise<{ text: string; tokens: { input: number; output: number }; latencyMs: number; model: string }> {
    const userMessage = formatInvestigationUserMessage(
      question,
      context.toolName,
      context.toolInput,
      context.toolOutput,
      context.previousAnalysis
    );

    const effectiveConfig = context.modelOverride
      ? { ...this.config, model: context.modelOverride, maxTokens: 400 }
      : { ...this.config, maxTokens: 400 };

    return this.withConcurrencyLimit(async () => {
      const startTime = Date.now();
      const raw = await this.callProvider(
        INVESTIGATION_SYSTEM_PROMPT,
        userMessage,
        effectiveConfig
      );
      return {
        text: raw.text.trim(),
        tokens: {
          input: raw.usage.input_tokens ?? raw.usage.prompt_tokens ?? 0,
          output: raw.usage.output_tokens ?? raw.usage.completion_tokens ?? 0,
        },
        latencyMs: Date.now() - startTime,
        model: effectiveConfig.model,
      };
    });
  }

  async laymans(
    request: AnalysisRequest,
    prompt: string
  ): Promise<LaymansResult> {
    const effectiveConfig = {
      ...this.config,
      maxTokens: request.depth === 'detailed' ? 800 : 300,
    };

    return this.withConcurrencyLimit(async () => {
      const startTime = Date.now();
      const systemPrompt = buildLaymansSystemPrompt(prompt, request.depth);
      const userMessage = formatAnalysisUserMessage(request);

      const raw = await this.callProvider(systemPrompt, userMessage, effectiveConfig);
      const latencyMs = Date.now() - startTime;

      const inputTokens = raw.usage.input_tokens ?? raw.usage.prompt_tokens ?? 0;
      const outputTokens = raw.usage.output_tokens ?? raw.usage.completion_tokens ?? 0;

      return {
        explanation: raw.text.trim(),
        model: effectiveConfig.model,
        latencyMs,
        tokens: { input: inputTokens, output: outputTokens },
      };
    });
  }

  private async callProvider(
    systemPrompt: string,
    userMessage: string,
    config: AnalysisConfig
  ) {
    if (config.provider === 'anthropic') {
      return this.anthropicProvider.analyze(systemPrompt, userMessage, config);
    }
    if (config.provider === 'litellm') {
      return this.litellmProvider.analyze(systemPrompt, userMessage, config);
    }
    // openai and openai-compatible use the basic OpenAI-compatible provider
    const effectiveConfig = config.provider === 'openai'
      ? { ...config, endpoint: config.endpoint || 'https://api.openai.com/v1' }
      : config;
    return this.openaiProvider.analyze(systemPrompt, userMessage, effectiveConfig);
  }

  private parseAnalysisResponse(
    text: string,
    model: string,
    latencyMs: number,
    raw: { usage: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }
  ): AnalysisResult {
    let parsed: Partial<AnalysisResult>;
    try {
      // Strip potential markdown code fences
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      parsed = JSON.parse(cleaned) as Partial<AnalysisResult>;
    } catch {
      // Fallback if JSON parsing fails
      parsed = {
        meaning: text.slice(0, 200),
        goal: 'Unable to parse analysis response.',
        safety: { level: 'caution', summary: 'Analysis parsing failed.' },
        security: { level: 'caution', summary: 'Analysis parsing failed.' },
        risk: { level: 'medium', summary: 'Unable to determine risk level.' },
      };
    }

    const inputTokens =
      raw.usage.input_tokens ?? raw.usage.prompt_tokens ?? 0;
    const outputTokens =
      raw.usage.output_tokens ?? raw.usage.completion_tokens ?? 0;

    return {
      meaning: (parsed.meaning as string) ?? 'No analysis available.',
      goal: (parsed.goal as string) ?? 'Unknown goal.',
      safety: {
        level: (parsed.safety as { level: string })?.level as 'safe' | 'caution' | 'danger' ?? 'caution',
        summary: (parsed.safety as { summary: string })?.summary ?? 'Unknown.',
        details: (parsed.safety as { details?: string[] })?.details,
      },
      security: {
        level: (parsed.security as { level: string })?.level as 'safe' | 'caution' | 'danger' ?? 'caution',
        summary: (parsed.security as { summary: string })?.summary ?? 'Unknown.',
        details: (parsed.security as { details?: string[] })?.details,
      },
      risk: {
        level: (parsed.risk as { level: string })?.level as 'low' | 'medium' | 'high' ?? 'medium',
        summary: (parsed.risk as { summary: string })?.summary ?? 'Unknown.',
      },
      model,
      latencyMs,
      tokens: { input: inputTokens, output: outputTokens },
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

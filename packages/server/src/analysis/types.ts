export interface AnalysisResult {
  meaning: string;
  goal: string;
  safety: {
    level: 'safe' | 'caution' | 'danger';
    summary: string;
    details?: string[];
  };
  security: {
    level: 'safe' | 'caution' | 'danger';
    summary: string;
    details?: string[];
  };
  risk: {
    level: 'low' | 'medium' | 'high';
    summary: string;
  };
  model: string;
  latencyMs: number;
  tokens: { input: number; output: number };
}

export interface AnalysisRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: unknown;
  cwd: string;
  depth: 'quick' | 'detailed';
  recentEvents?: Array<{ type: string; summary: string }>;
}

export interface AnalysisConfig {
  provider: 'anthropic' | 'openai-compatible';
  model: string;
  endpoint?: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
}

export interface RawLLMResponse {
  text: string;
  usage: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

export interface InvestigationContext {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput?: unknown;
  previousAnalysis?: AnalysisResult;
  cwd: string;
}

export interface LaymansResult {
  explanation: string;
  model: string;
  latencyMs: number;
  tokens: { input: number; output: number };
}

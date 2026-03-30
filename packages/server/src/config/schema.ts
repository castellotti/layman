import { z } from 'zod';

export const AutoAllowRulesSchema = z.object({
  readOnly: z.boolean().default(true),
  safeEdits: z.boolean().default(false),
  trustedCommands: z.array(z.string()).default([]),
});

export const PROVIDER_OPTIONS = ['anthropic', 'openai', 'openai-compatible', 'litellm'] as const;
export type AnalysisProvider = typeof PROVIDER_OPTIONS[number];

export const AnalysisConfigSchema = z.object({
  provider: z.enum(PROVIDER_OPTIONS).default('anthropic'),
  model: z.string().default('sonnet'),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  maxTokens: z.number().int().positive().default(400),
  temperature: z.number().min(0).max(2).default(0.1),
});

export const DEFAULT_LAYMANS_PROMPT = 'Explain what the AI is doing here in absolute layman\'s terms to someone who has no understanding of technology';

export const LaymanConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8880),
  host: z.string().default('localhost'),
  autoAnalyze: z.enum(['all', 'risky', 'none']).default('none'),
  autoExplain: z.enum(['all', 'medium', 'high', 'none']).default('none'),
  autoExplainDepth: z.enum(['quick', 'detailed']).default('quick'),
  analysis: AnalysisConfigSchema.default({}),
  autoAllow: AutoAllowRulesSchema.default({}),
  hookTimeout: z.number().int().min(10).max(3600).default(300),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  open: z.boolean().default(true),
  autoApprove: z.boolean().default(true), // Auto-approve all PreToolUse; only block on PermissionRequest
  laymansPrompt: z.string().default(DEFAULT_LAYMANS_PROMPT),
  hookUrl: z.string().optional(),
  sessionRecording: z.boolean().default(false),
  recordingRecovery: z.boolean().default(false),
  piiFilter: z.boolean().default(true),
  showFullCommand: z.boolean().default(false),
  switchToNewestSession: z.boolean().default(false),
  declinedClients: z.array(z.string()).default([]),
});

export type LaymanConfig = z.infer<typeof LaymanConfigSchema>;
export type AnalysisConfigType = z.infer<typeof AnalysisConfigSchema>;
export type AutoAllowRules = z.infer<typeof AutoAllowRulesSchema>;

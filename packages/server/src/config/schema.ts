import { z } from 'zod';

export const AutoAllowRulesSchema = z.object({
  readOnly: z.boolean().default(true),
  safeEdits: z.boolean().default(false),
  trustedCommands: z.array(z.string()).default([]),
});

export const AnalysisConfigSchema = z.object({
  provider: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
  model: z.string().default('sonnet'),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  maxTokens: z.number().int().positive().default(400),
  temperature: z.number().min(0).max(2).default(0.1),
});

export const DEFAULT_LAYMANS_PROMPT = 'Explain what the AI is doing here in absolute layman\'s terms to someone who has no understanding of technology';

export const LaymanConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8090),
  host: z.string().default('localhost'),
  autoAnalyze: z.enum(['all', 'risky', 'none']).default('risky'),
  analysis: AnalysisConfigSchema.default({}),
  autoAllow: AutoAllowRulesSchema.default({}),
  hookTimeout: z.number().int().min(10).max(3600).default(300),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  open: z.boolean().default(true),
  autoApprove: z.boolean().default(true), // Auto-approve all PreToolUse; only block on PermissionRequest
  laymansPrompt: z.string().default(DEFAULT_LAYMANS_PROMPT),
  settingsPath: z.string().optional(),
  hookUrl: z.string().optional(),
  global: z.boolean().default(false),
});

export type LaymanConfig = z.infer<typeof LaymanConfigSchema>;
export type AnalysisConfigType = z.infer<typeof AnalysisConfigSchema>;
export type AutoAllowRules = z.infer<typeof AutoAllowRulesSchema>;

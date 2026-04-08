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

export const DriftThresholdsSchema = z.object({
  green: z.number().min(0).max(100).default(15),
  yellow: z.number().min(0).max(100).default(30),
  orange: z.number().min(0).max(100).default(50),
}).refine(
  (v) => v.green < v.yellow && v.yellow < v.orange,
  { message: 'Drift thresholds must satisfy: green < yellow < orange' }
);

export const DriftMonitoringConfigSchema = z.object({
  enabled: z.boolean().default(false),
  checkIntervalToolCalls: z.number().int().min(1).max(100).default(10),
  checkIntervalMinutes: z.number().int().min(1).max(60).default(5),
  sessionDriftThresholds: DriftThresholdsSchema.default({}),
  rulesDriftThresholds: DriftThresholdsSchema.default({}),
  blockOnRed: z.boolean().default(false),
  remindOnOrange: z.boolean().default(true),
});

export const LaymanConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(8880),
  host: z.string().default('localhost'),
  autoAnalyze: z.union([
    z.enum(['all', 'medium', 'high', 'none']),
    z.literal('risky').transform(() => 'medium' as const), // migrate old value
  ]).default('none'),
  autoAnalyzeDepth: z.enum(['quick', 'detailed']).default('detailed'),
  autoExplain: z.enum(['all', 'medium', 'high', 'none']).default('none'),
  autoExplainDepth: z.enum(['quick', 'detailed']).default('quick'),
  analysis: AnalysisConfigSchema.default({}),
  autoAllow: AutoAllowRulesSchema.default({}),
  hookTimeout: z.number().int().min(10).max(3600).default(300),
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  open: z.boolean().default(true),
  autoApprove: z.union([
    z.enum(['all', 'medium', 'low', 'none']),
    z.boolean().transform(b => b ? 'all' : 'none' as const),
  ]).default('medium'), // 'all'=approve everything, 'medium'=approve low+medium, 'low'=approve only low, 'none'=always prompt
  laymansPrompt: z.string().default(DEFAULT_LAYMANS_PROMPT),
  hookUrl: z.string().optional(),
  sessionRecording: z.boolean().default(false),
  recordingRecovery: z.boolean().default(false),
  piiFilter: z.boolean().default(true),
  showFullCommand: z.boolean().default(false),
  switchToNewestSession: z.boolean().default(false),
  collapseHistory: z.boolean().default(true),
  autoScroll: z.boolean().default(true),
  declinedClients: z.array(z.string()).default([]),
  idleThresholdMinutes: z.number().int().min(1).max(60).default(5),
  autoActivateClients: z.array(z.string()).default([]),
  driftMonitoring: DriftMonitoringConfigSchema.default({}),
  setupWizardComplete: z.boolean().default(false),
});

export type LaymanConfig = z.infer<typeof LaymanConfigSchema>;
export type AnalysisConfigType = z.infer<typeof AnalysisConfigSchema>;
export type AutoAllowRules = z.infer<typeof AutoAllowRulesSchema>;

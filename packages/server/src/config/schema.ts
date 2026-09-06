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

/**
 * Text-to-speech via a speaches server (OpenAI-compatible /v1/audio/speech).
 *
 * Two speed controls, not one, because speaches accepts no pitch parameter:
 * `speed` goes upstream and changes tempo with pitch preserved, while
 * `playbackRate` is applied to the audio element in the browser and — with
 * `preservePitch` off — gives the pitch-shifted "sped-up tape" effect instead.
 */
export const TtsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default('http://localhost:8000'),
  apiKey: z.string().default(''),
  /** Bypass the Layman proxy. Only works if speaches was started with allow_origins. */
  direct: z.boolean().default(false),
  model: z.string().default('speaches-ai/Kokoro-82M-v1.0-ONNX'),
  voice: z.string().default('af_heart'),
  speed: z.number().min(0.25).max(4).default(1.0),
  playbackRate: z.number().min(0.5).max(3).default(1.0),
  preservePitch: z.boolean().default(true),
  autoSpeak: z.enum(['none', 'final', 'all']).default('none'),
  /** Speak the layman's explanation instead of the raw response. Needs autoExplain. */
  speakLaymans: z.boolean().default(false),
  codeBlocks: z.enum(['skip', 'announce']).default('announce'),
  maxChars: z.number().int().min(200).max(20000).default(4000),
});

/**
 * Live token streaming — partial assistant output pushed to the dashboard as it
 * is generated. Only harnesses that expose a streaming hook can feed it (pi and
 * OpenCode today); for the rest its absence renders as no live row at all.
 */
export const LiveTokensConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Show the reasoning stream alongside the response stream. */
  showThinking: z.boolean().default(true),
});

/**
 * glove — passive monitoring of sandboxed harnesses (github.com/castellotti/glove).
 *
 * glove runs harnesses in containers with a per-environment fake home persisted
 * on the host under `sessionsDir`. When enabled, the passive file watchers
 * discover those environments and tail their harness logs (Vibe and pi)
 * alongside native ones, read-only. Off by default: native monitoring is
 * entirely unaffected either way.
 */
export const GloveConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Host directory glove persists environment homes under (`<sessionsDir>/<env-id>/home/`). */
  sessionsDir: z.string().default('~/.glove/envs'),
});

/**
 * Multi-host sync (see docs/planning/multi-host-sync.md).
 *
 * `standalone` (default) is exactly today's behaviour — nothing new runs. A
 * `central` accepts pushes from enrolled remotes; a `remote` pushes its own data
 * to `centralUrl` and optionally mirrors everything else back. `hostId` is minted
 * once by `ensureHostIdentity()` and must never be edited by the UI — it is the
 * stable origin stamped onto every row, so the deep-merge in config.ts protects
 * it from a partial Settings update blanking it (which would orphan every row).
 */
export const SyncConfigSchema = z.object({
  role: z.enum(['standalone', 'central', 'remote']).default('standalone'),
  hostId: z.string().default(''),          // filled by ensureHostIdentity(); never edited by UI
  hostName: z.string().default(''),
  centralUrl: z.string().default(''),      // remote only
  token: z.string().default(''),           // remote only; plaintext, same trust level as apiKey
  intervalSeconds: z.number().int().min(2).max(300).default(5),
  mirror: z.boolean().default(false),      // remote only: pull everything else from central
  mirrorIntervalSeconds: z.number().int().min(15).max(3600).default(60),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
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
  /**
   * Base URL used when generating outbound links (copy-link buttons, markdown
   * exports).  Persisted, unlike hookUrl — it is a user preference, not an
   * invocation detail.  Empty falls back to hookUrl, then host:port.
   */
  publicUrl: z.string().default(''),
  sessionRecording: z.boolean().default(false),
  recordingRecovery: z.boolean().default(false),
  historyImport: z.boolean().default(false),
  piiFilter: z.boolean().default(true),
  showFullCommand: z.boolean().default(false),
  switchToNewestSession: z.boolean().default(false),
  collapseHistory: z.boolean().default(true),
  autoScroll: z.boolean().default(true),
  declinedClients: z.array(z.string()).default([]),
  idleThresholdMinutes: z.number().int().min(1).max(60).default(5),
  autoActivateClients: z.array(z.string()).default([]),
  /**
   * Client agent types whose tool calls Layman is allowed to suspend for approval.
   *
   * Only consulted for harnesses whose blocking is opt-in — currently just pi,
   * whose stated position is that a coding agent should not impose permission
   * popups and that confirmation flows belong to the user. Empty by default, so
   * pi runs unblocked until the user asks otherwise.
   *
   * A per-client array rather than a `pi`-specific boolean so the same toggle
   * generalises if another harness ever wants opt-in blocking. Harnesses that
   * block unconditionally (claude-code, Cline) ignore this entirely.
   */
  approvalClients: z.array(z.string()).default([]),
  driftMonitoring: DriftMonitoringConfigSchema.default({}),
  liveTokens: LiveTokensConfigSchema.default({}),
  glove: GloveConfigSchema.default({}),
  sync: SyncConfigSchema.default({}),
  tts: TtsConfigSchema.default({}),
  setupWizardComplete: z.boolean().default(false),
  openWebUiUrl: z.string().default(''),
  openWebUiApiKey: z.string().default(''),
});

export type LaymanConfig = z.infer<typeof LaymanConfigSchema>;
export type SyncConfig = z.infer<typeof SyncConfigSchema>;
export type LiveTokensConfig = z.infer<typeof LiveTokensConfigSchema>;
export type GloveConfig = z.infer<typeof GloveConfigSchema>;
export type AnalysisConfigType = z.infer<typeof AnalysisConfigSchema>;
export type TtsConfig = z.infer<typeof TtsConfigSchema>;
export type AutoAllowRules = z.infer<typeof AutoAllowRulesSchema>;

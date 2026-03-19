import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { cosmiconfig } from 'cosmiconfig';
import { LaymanConfigSchema } from './schema.js';
import type { LaymanConfig } from './schema.js';

const explorer = cosmiconfig('layman', {
  searchPlaces: [
    '.laymanrc',
    '.laymanrc.json',
    '.laymanrc.yml',
    '.laymanrc.yaml',
    'layman.config.js',
    'layman.config.ts',
    'package.json',
  ],
});

/**
 * Derive the path for the auto-saved runtime config.
 * Co-located with settings.local.json so it lives in the Docker-mounted volume.
 * e.g. /workspace/.claude/layman.json  (Docker)
 *   or .claude/layman.json             (local)
 */
function getRuntimeConfigPath(settingsPath?: string): string {
  if (settingsPath) {
    return join(dirname(settingsPath), 'layman.json');
  }
  return join(process.cwd(), '.claude', 'layman.json');
}

/** Fields not worth persisting (they're CLI/startup-only concerns). */
const EPHEMERAL_KEYS: (keyof LaymanConfig)[] = ['port', 'host', 'open', 'settingsPath', 'hookUrl', 'global'];

export function saveConfig(config: LaymanConfig): void {
  const path = getRuntimeConfigPath(config.settingsPath);
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Strip ephemeral keys before saving
    const toSave: Partial<LaymanConfig> = { ...config };
    for (const key of EPHEMERAL_KEYS) delete toSave[key];

    writeFileSync(path, JSON.stringify(toSave, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal — settings just won't persist this run
  }
}

function loadRuntimeConfig(settingsPath?: string): Partial<LaymanConfig> {
  const path = getRuntimeConfigPath(settingsPath);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<LaymanConfig>;
  } catch {
    return {};
  }
}

export async function loadConfig(
  cliFlags: Partial<LaymanConfig> = {}
): Promise<LaymanConfig> {
  // Static file config (cosmiconfig — .laymanrc etc.)
  let fileConfig: Partial<LaymanConfig> = {};
  try {
    const result = await explorer.search();
    if (result && !result.isEmpty) {
      fileConfig = result.config as Partial<LaymanConfig>;
    }
  } catch {
    // No config file — use defaults
  }

  // Auto-saved runtime config (.claude/layman.json)
  const runtimeFile = loadRuntimeConfig(cliFlags.settingsPath);

  // Env vars
  const envConfig: Partial<LaymanConfig> = {};
  if (process.env.LAYMAN_PORT) envConfig.port = parseInt(process.env.LAYMAN_PORT, 10);
  if (process.env.LAYMAN_HOST) envConfig.host = process.env.LAYMAN_HOST;
  if (process.env.LAYMAN_AUTO_ANALYZE) {
    envConfig.autoAnalyze = process.env.LAYMAN_AUTO_ANALYZE as 'all' | 'risky' | 'none';
  }
  if (process.env.LAYMAN_AUTO_APPROVE) envConfig.autoApprove = process.env.LAYMAN_AUTO_APPROVE === 'true';
  if (process.env.ANTHROPIC_API_KEY && !envConfig.analysis) {
    envConfig.analysis = { provider: 'anthropic', model: 'sonnet', maxTokens: 400, temperature: 0.1 };
  }

  // Merge order: defaults → env vars → static file → auto-saved runtime → CLI flags
  // CLI flags (port, host, etc.) always win; runtime file wins over static file
  const merged = {
    ...envConfig,
    ...fileConfig,
    ...runtimeFile,
    ...cliFlags,
    analysis: {
      ...envConfig.analysis,
      ...fileConfig.analysis,
      ...runtimeFile.analysis,
      ...cliFlags.analysis,
    },
    autoAllow: {
      ...envConfig.autoAllow,
      ...fileConfig.autoAllow,
      ...runtimeFile.autoAllow,
      ...cliFlags.autoAllow,
    },
  };

  return LaymanConfigSchema.parse(merged);
}

let runtimeConfig: LaymanConfig | null = null;

export function getConfig(): LaymanConfig {
  if (!runtimeConfig) throw new Error('Config not initialized. Call loadConfig() first.');
  return runtimeConfig;
}

export function setConfig(config: LaymanConfig): void {
  runtimeConfig = config;
}

export function updateConfig(updates: Partial<LaymanConfig>): LaymanConfig {
  if (!runtimeConfig) throw new Error('Config not initialized.');
  runtimeConfig = LaymanConfigSchema.parse({
    ...runtimeConfig,
    ...updates,
    analysis: { ...runtimeConfig.analysis, ...updates.analysis },
    autoAllow: { ...runtimeConfig.autoAllow, ...updates.autoAllow },
  });
  return runtimeConfig;
}

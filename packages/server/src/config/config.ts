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

export async function loadConfig(
  cliFlags: Partial<LaymanConfig> = {}
): Promise<LaymanConfig> {
  let fileConfig: Partial<LaymanConfig> = {};

  try {
    const result = await explorer.search();
    if (result && !result.isEmpty) {
      fileConfig = result.config as Partial<LaymanConfig>;
    }
  } catch {
    // No config file found or parse error — use defaults
  }

  // Env vars
  const envConfig: Partial<LaymanConfig> = {};
  if (process.env.LAYMAN_PORT) envConfig.port = parseInt(process.env.LAYMAN_PORT, 10);
  if (process.env.LAYMAN_HOST) envConfig.host = process.env.LAYMAN_HOST;
  if (process.env.LAYMAN_AUTO_ANALYZE) {
    envConfig.autoAnalyze = process.env.LAYMAN_AUTO_ANALYZE as 'all' | 'risky' | 'none';
  }

  // Merge order: defaults → env vars → config file → CLI flags
  const merged = {
    ...envConfig,
    ...fileConfig,
    ...cliFlags,
    analysis: {
      ...envConfig.analysis,
      ...fileConfig.analysis,
      ...cliFlags.analysis,
    },
    autoAllow: {
      ...envConfig.autoAllow,
      ...fileConfig.autoAllow,
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
  runtimeConfig = LaymanConfigSchema.parse({ ...runtimeConfig, ...updates });
  return runtimeConfig;
}

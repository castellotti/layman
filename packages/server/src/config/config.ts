import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { cosmiconfig } from 'cosmiconfig';
import { LaymanConfigSchema } from './schema.js';
import { laymanConfigPath } from './paths.js';
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
 * Stored in Layman's harness-agnostic data dir (see config/paths.ts);
 * historically this lived at ~/.claude/layman.json.
 */
function getRuntimeConfigPath(): string {
  return laymanConfigPath();
}

/** Fields not worth persisting (they're CLI/startup-only concerns). */
const EPHEMERAL_KEYS: (keyof LaymanConfig)[] = ['port', 'host', 'open', 'hookUrl'];

export function saveConfig(config: LaymanConfig): void {
  const path = getRuntimeConfigPath();
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

function loadRuntimeConfig(): Partial<LaymanConfig> {
  const path = getRuntimeConfigPath();
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

  // Auto-saved runtime config (layman.json in the data dir; see config/paths.ts)
  const runtimeFile = loadRuntimeConfig();

  // Existing users who already have a config file should not see the wizard
  if (Object.keys(runtimeFile).length > 0 && runtimeFile.setupWizardComplete === undefined) {
    runtimeFile.setupWizardComplete = true;
  }

  // Env vars
  const envConfig: Partial<LaymanConfig> = {};
  if (process.env.LAYMAN_PORT) envConfig.port = parseInt(process.env.LAYMAN_PORT, 10);
  if (process.env.LAYMAN_HOST) envConfig.host = process.env.LAYMAN_HOST;
  if (process.env.LAYMAN_AUTO_ANALYZE) {
    envConfig.autoAnalyze = process.env.LAYMAN_AUTO_ANALYZE as 'all' | 'medium' | 'high' | 'none';
  }
  if (process.env.LAYMAN_AUTO_APPROVE) {
    const raw = process.env.LAYMAN_AUTO_APPROVE;
    if (raw === 'true' || raw === 'all') envConfig.autoApprove = 'all';
    else if (raw === 'false' || raw === 'none') envConfig.autoApprove = 'none';
    else if (raw === 'medium' || raw === 'low') envConfig.autoApprove = raw;
  }
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
    // Deep-merge sync so a partial runtime/file config can never blank the
    // persisted hostId (which would orphan every row stamped with it).
    sync: {
      ...envConfig.sync,
      ...fileConfig.sync,
      ...runtimeFile.sync,
      ...cliFlags.sync,
    },
    // Deep-merge glove and glove.network so a partial config (e.g. only
    // `glove.enabled`) can neither blank `home` nor reset the network block.
    glove: {
      ...envConfig.glove,
      ...fileConfig.glove,
      ...runtimeFile.glove,
      ...cliFlags.glove,
      network: {
        ...envConfig.glove?.network,
        ...fileConfig.glove?.network,
        ...runtimeFile.glove?.network,
        ...cliFlags.glove?.network,
      },
    },
  };

  merged.glove = migrateGloveHome(merged.glove);
  return LaymanConfigSchema.parse(merged);
}

/**
 * glove v2's `glove.sessionsDir` (`~/.glove/envs`) became v3's `glove.home`
 * (`~/.glove`): its parent. Read once, when `home` is absent; the schema then
 * drops the old key, and the next save writes only `home`.
 */
export function migrateGloveHome<T extends Record<string, unknown> | undefined>(glove: T): T {
  if (!glove || typeof glove.home === 'string' || typeof glove.sessionsDir !== 'string') return glove;
  const { sessionsDir, ...rest } = glove;
  const trimmed = (sessionsDir as string).replace(/\/+$/, '');
  const home = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/')) || '/' : '~/.glove';
  return { ...rest, home } as unknown as T;
}

let runtimeConfig: LaymanConfig | null = null;

/** The URL hooks are installed under: `hookUrl` if set, else the listen address. */
export function resolveHookUrl(config: Pick<LaymanConfig, 'hookUrl' | 'host' | 'port'>): string {
  return config.hookUrl ?? `http://${config.host}:${config.port}`;
}

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
    // Deep-merge so a Settings update that omits sync.hostId (or sends only a
    // role change) keeps the persisted identity instead of minting a new one.
    sync: { ...runtimeConfig.sync, ...updates.sync },
    // Deep-merge so a Settings update carrying only `glove.enabled` keeps
    // `home` and the network block (and one carrying only a network
    // toggle keeps the rest of it).
    glove: {
      ...runtimeConfig.glove,
      ...updates.glove,
      network: { ...runtimeConfig.glove.network, ...updates.glove?.network },
    },
  });
  return runtimeConfig;
}

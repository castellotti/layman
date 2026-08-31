import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

/**
 * Harness-agnostic locations for Layman's own data and config.
 *
 * Historically the SQLite database and the runtime config lived inside
 * `~/.claude/` — Claude Code's config directory — even though neither is tied
 * to Claude Code: the database records events from every harness, and the
 * config is Layman's alone. A user who runs only Codex, Vibe, or pi (and never
 * installs Claude Code) still had Layman scatter its state into a directory
 * belonging to a tool they don't use.
 *
 * Data now lives in an XDG-style data directory, resolved in this order:
 *   1. $LAYMAN_DATA_DIR   — explicit override (also lets Docker pin the path)
 *   2. $XDG_DATA_HOME/layman
 *   3. ~/.local/share/layman   — the XDG default
 *
 * The Linux container has neither env var set, so it resolves to
 * `/root/.local/share/layman`, which docker-compose bind-mounts to the host's
 * `${HOME}/.local/share/layman`. That keeps the database on the host
 * filesystem (never a Docker volume) exactly as before, just at a neutral path.
 */
export function laymanDataDir(): string {
  const override = process.env.LAYMAN_DATA_DIR;
  if (override && override.trim()) return override;

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return join(xdg, 'layman');

  return join(homedir(), '.local', 'share', 'layman');
}

/** Ensure the data directory exists and return it. */
export function ensureLaymanDataDir(): string {
  const dir = laymanDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function laymanDbPath(): string {
  return join(laymanDataDir(), 'layman.db');
}

export function laymanConfigPath(): string {
  return join(laymanDataDir(), 'layman.json');
}

/** Legacy locations, kept only so the one-time migration can find old data. */
export function legacyDbPath(): string {
  return join(homedir(), '.claude', 'layman.db');
}

export function legacyConfigPath(): string {
  return join(homedir(), '.claude', 'layman.json');
}

/**
 * One-time, non-destructive migration from the legacy `~/.claude` location to
 * the neutral data directory.
 *
 * For each of the database and the config file: if the new file does not exist
 * but a legacy one does, **copy** it across (the legacy file is left untouched
 * as a backup). This runs on every startup but is a no-op once migrated — the
 * guard is "new file absent", so it never clobbers live data and never fights a
 * second process.
 *
 * It also doubles as a restore path: dropping a backed-up `~/.claude/layman.db`
 * into place is enough for the next launch to adopt it.
 *
 * Copying the SQLite database while journal_mode=DELETE is safe — a DELETE-mode
 * database is a single self-contained file (any `-journal` sidecar only exists
 * mid-transaction, and Layman is not writing during this pre-open migration).
 *
 * Returns a short list of human-readable messages describing what was migrated,
 * for the caller to log. Empty when nothing was done.
 *
 * `pairs` is injectable for testing; it defaults to the real legacy→new
 * database and config paths.
 */
export interface MigrationPair {
  legacy: string;
  next: string;
  label: string;
}

export function defaultMigrationPairs(): MigrationPair[] {
  return [
    { legacy: legacyDbPath(), next: laymanDbPath(), label: 'database' },
    { legacy: legacyConfigPath(), next: laymanConfigPath(), label: 'config' },
  ];
}

export function migrateLegacyData(pairs: MigrationPair[] = defaultMigrationPairs()): string[] {
  const messages: string[] = [];

  const needed = pairs.filter(p => !existsSync(p.next) && existsSync(p.legacy));
  if (needed.length === 0) return messages;

  for (const { legacy, next, label } of needed) {
    try {
      const dir = dirname(next);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      copyFileSync(legacy, next);
      messages.push(`Migrated ${label} from ${legacy} to ${next} (original kept as backup)`);
    } catch (err) {
      messages.push(`Failed to migrate ${label} from ${legacy}: ${(err as Error).message}`);
    }
  }
  return messages;
}

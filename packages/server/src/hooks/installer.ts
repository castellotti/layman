import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

interface HookEntry {
  type: 'http';
  url: string;
  timeout: number;
  async?: boolean;
  statusMessage?: string;
  _layman?: boolean;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface SettingsHooks {
  [eventName: string]: HookMatcher[];
}

interface Settings {
  hooks?: SettingsHooks;
  [key: string]: unknown;
}

export interface HookInstallerOptions {
  serverUrl: string;
  hookTimeout: number;
}

export interface OptionalClientStatus {
  id: string;
  name: string;
  detected: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
  hooksInstalled?: boolean;
  hooksUpToDate?: boolean;
  declined?: boolean;
}

export interface SetupStatus {
  hooksInstalled: boolean;
  hooksUpToDate: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
  claudeCodeDeclined?: boolean;
  optionalClients: OptionalClientStatus[];
}

const GLOBAL_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const COMMANDS_DIR = join(homedir(), '.claude', 'commands');

/**
 * Optional AI clients that support slash commands via a commands directory.
 * Each entry defines how to detect whether the client is installed and where
 * to write the command file. Add new clients here — no other code changes needed.
 *
 * Detection: we check for the client's config directory rather than a binary,
 * since the binary may not be on PATH (e.g. installed as an app bundle). A config
 * dir existing is a reliable signal the user has set up the client at least once.
 */
interface OptionalClient {
  id: string;
  name: string;
  configDir: string;
  commandsDir: string;
  /** File name to write (default: 'layman.md') */
  fileName?: string;
  /** Custom content generator — if omitted, uses the standard layman.md content */
  getContent?: () => string;
  /**
   * Files or directories inside configDir whose presence proves the client is
   * genuinely installed — not just an empty directory created by a Docker bind mount.
   * If defined, at least one must exist for `detected` to be true.
   */
  signalFiles?: string[];
}

const VIBE_SKILL_CONTENT = `---
name: layman
description: Check Layman monitoring dashboard status
user-invocable: true
---

Layman is passively monitoring this Vibe session via session log files.

Tell the user: "Layman is monitoring this session. Open http://localhost:8880 to see the dashboard."
`;

const CODEX_SKILL_CONTENT = `---
name: layman
description: Activate Layman monitoring for this Codex session
metadata:
  short-description: Activate Layman monitoring
---

You were invoked via \`@layman\`. Layman is now monitoring this session.

Tell the user: "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."
`;

const OPTIONAL_CLIENTS: OptionalClient[] = [
  {
    id: 'codex',
    name: 'Codex',
    configDir: join(homedir(), '.codex'),
    commandsDir: join(homedir(), '.codex', 'skills', 'layman'),
    fileName: 'SKILL.md',
    getContent: () => CODEX_SKILL_CONTENT,
    signalFiles: ['config.toml', 'instructions.md'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    configDir: join(homedir(), '.config', 'opencode'),
    commandsDir: join(homedir(), '.config', 'opencode', 'commands'),
    signalFiles: ['opencode.json'],
  },
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    configDir: join(homedir(), '.vibe'),
    commandsDir: join(homedir(), '.vibe', 'skills', 'layman'),
    fileName: 'SKILL.md',
    getContent: () => VIBE_SKILL_CONTENT,
    signalFiles: ['config.json', 'logs'],
  },
  {
    id: 'cline',
    name: 'Cline',
    configDir: join(homedir(), 'Documents', 'Cline'),
    commandsDir: join(homedir(), 'Documents', 'Cline', 'Workflows'),
    getContent: () => getClineWorkflowContent(),
    signalFiles: ['Rules'],
  },
];

function readSettings(filePath: string): Settings {
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Settings;
  } catch {
    return {};
  }
}

function writeSettings(filePath: string, settings: Settings): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function buildLaymanHooks(serverUrl: string, hookTimeout: number): SettingsHooks {
  const asyncHook = (eventName: string): HookMatcher => ({
    matcher: '',
    hooks: [
      {
        type: 'http',
        url: `${serverUrl}/hooks/${eventName}`,
        timeout: 10,
        async: true,
        _layman: true,
      },
    ],
  });

  const blockingHook = (eventName: string, statusMessage: string): HookMatcher => ({
    matcher: '',
    hooks: [
      {
        type: 'http',
        url: `${serverUrl}/hooks/${eventName}`,
        timeout: hookTimeout,
        statusMessage,
        _layman: true,
      },
    ],
  });

  return {
    PreToolUse: [blockingHook('PreToolUse', 'Layman is analyzing this action...')],
    PostToolUse: [asyncHook('PostToolUse')],
    PostToolUseFailure: [asyncHook('PostToolUseFailure')],
    PermissionRequest: [
      {
        matcher: '',
        hooks: [
          {
            type: 'http',
            url: `${serverUrl}/hooks/PermissionRequest`,
            timeout: hookTimeout,
            statusMessage: 'Layman is evaluating this permission request...',
            _layman: true,
          },
        ],
      },
    ],
    Notification: [
      {
        matcher: 'permission_prompt|idle_prompt',
        hooks: [
          {
            type: 'http',
            url: `${serverUrl}/hooks/Notification`,
            timeout: 10,
            async: true,
            _layman: true,
          },
        ],
      },
    ],
    SessionStart: [asyncHook('SessionStart')],
    SessionEnd: [asyncHook('SessionEnd')],
    Stop: [asyncHook('Stop')],
    UserPromptSubmit: [asyncHook('UserPromptSubmit')],
    SubagentStart: [asyncHook('SubagentStart')],
    SubagentStop: [asyncHook('SubagentStop')],
    StopFailure: [asyncHook('StopFailure')],
    PreCompact: [asyncHook('PreCompact')],
    PostCompact: [asyncHook('PostCompact')],
    Elicitation: [asyncHook('Elicitation')],
    ElicitationResult: [asyncHook('ElicitationResult')],
  };
}

function isLaymanHook(hook: HookEntry, serverUrl?: string): boolean {
  if (hook._layman === true) return true;
  // Legacy: detect hooks installed before the _layman tag was added, matched by URL
  if (serverUrl && typeof hook.url === 'string' && hook.url.startsWith(`${serverUrl}/hooks/`)) return true;
  return false;
}

/** Hash of the expected command file content, used to detect staleness */
function commandHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

function getCommandContent(): string {
  // Read the bundled command template from the package
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const commandPath = join(__dirname, '..', '..', 'commands', 'layman.md');
  const fallbackPath = join(__dirname, '..', 'commands', 'layman.md');

  if (existsSync(commandPath)) {
    return readFileSync(commandPath, 'utf-8');
  }
  if (existsSync(fallbackPath)) {
    return readFileSync(fallbackPath, 'utf-8');
  }
  // Inline fallback
  return [
    '---',
    'description: Activate Layman monitoring for this session',
    '---',
    '',
    'You are activating the Layman monitoring dashboard. Follow these steps:',
    '',
    '1. Activate this session with Layman by running:',
    '   `echo "layman:activate"`',
    '',
    '2. Tell the user:',
    '   "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."',
    '',
    '3. If Layman does not appear to be monitoring (no events appear in the dashboard), tell the user:',
    '   "Layman server may not be running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"',
    '',
  ].join('\n');
}

function getClineWorkflowContent(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const workflowPath = join(__dirname, '..', '..', 'workflows', 'layman.md');
  const fallbackPath = join(__dirname, '..', 'workflows', 'layman.md');

  if (existsSync(workflowPath)) {
    return readFileSync(workflowPath, 'utf-8');
  }
  if (existsSync(fallbackPath)) {
    return readFileSync(fallbackPath, 'utf-8');
  }
  // Inline fallback
  return [
    'You are activating the Layman monitoring dashboard. Follow these steps:',
    '',
    '1. Activate this session with Layman by running:',
    '   `echo "layman:activate"`',
    '',
    '2. Tell the user:',
    '   "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."',
    '',
    '3. If Layman does not appear to be monitoring (no events appear in the dashboard), tell the user:',
    '   "Layman server may not be running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"',
    '',
  ].join('\n');
}

export class HookInstaller {
  constructor(private options: HookInstallerOptions) {}

  install(): void {
    const settings = readSettings(GLOBAL_SETTINGS_PATH);
    const laymanHooks = buildLaymanHooks(this.options.serverUrl, this.options.hookTimeout);

    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Merge: for each event, remove existing Layman hooks and add new ones
    for (const [eventName, matchers] of Object.entries(laymanHooks)) {
      if (!settings.hooks[eventName]) {
        settings.hooks[eventName] = [];
      }

      // Remove existing Layman hooks for this event (by tag or by URL, to handle legacy installs)
      settings.hooks[eventName] = settings.hooks[eventName].filter(
        (m) => !m.hooks.some((h) => isLaymanHook(h as HookEntry, this.options.serverUrl))
      );

      // Add new Layman hooks
      settings.hooks[eventName].push(...matchers);
    }

    writeSettings(GLOBAL_SETTINGS_PATH, settings);
    console.log(`Layman hooks installed at ${GLOBAL_SETTINGS_PATH}`);
  }

  uninstall(): void {
    if (!existsSync(GLOBAL_SETTINGS_PATH)) return;

    const settings = readSettings(GLOBAL_SETTINGS_PATH);
    if (!settings.hooks) return;

    // Remove all Layman hooks (by tag or by URL, to handle legacy installs)
    for (const eventName of Object.keys(settings.hooks)) {
      settings.hooks[eventName] = settings.hooks[eventName].filter(
        (m) => !m.hooks.some((h) => isLaymanHook(h as HookEntry, this.options.serverUrl))
      );

      // Remove empty event arrays
      if (settings.hooks[eventName].length === 0) {
        delete settings.hooks[eventName];
      }
    }

    // Remove empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    // If settings is now empty, remove file
    if (Object.keys(settings).length === 0) {
      try {
        unlinkSync(GLOBAL_SETTINGS_PATH);
        console.log(`Removed empty settings file at ${GLOBAL_SETTINGS_PATH}`);
      } catch {
        // Ignore
      }
    } else {
      writeSettings(GLOBAL_SETTINGS_PATH, settings);
    }

    console.log(`Layman hooks uninstalled from ${GLOBAL_SETTINGS_PATH}`);
  }

  installCommand(): void {
    if (!existsSync(COMMANDS_DIR)) {
      mkdirSync(COMMANDS_DIR, { recursive: true });
    }

    const content = getCommandContent();
    const hash = commandHash(content);
    const tagged = `${content.trimEnd()}\n<!-- layman:${hash} -->\n`;
    writeFileSync(join(COMMANDS_DIR, 'layman.md'), tagged, 'utf-8');
    console.log(`Layman command installed at ${join(COMMANDS_DIR, 'layman.md')}`);
  }

  uninstallCommand(): void {
    const cmdPath = join(COMMANDS_DIR, 'layman.md');
    if (existsSync(cmdPath)) {
      try {
        unlinkSync(cmdPath);
        console.log(`Layman command removed from ${cmdPath}`);
      } catch {
        // Ignore
      }
    }
  }

  /** Install Cline hook scripts to ~/Documents/Cline/Hooks/ if Cline is detected. */
  installClineHooks(): void {
    const clineHooksDir = join(homedir(), 'Documents', 'Cline', 'Hooks');
    const clineConfigDir = join(homedir(), 'Documents', 'Cline');

    if (!existsSync(clineConfigDir)) {
      // Also check ~/.cline as newer config location
      if (!existsSync(join(homedir(), '.cline'))) return;
    }

    // Read bundled hook script templates
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const templatesDir = join(__dirname, '..', '..', 'hooks', 'cline');
    const fallbackDir = join(__dirname, '..', 'hooks', 'cline');
    const srcDir = existsSync(templatesDir) ? templatesDir : existsSync(fallbackDir) ? fallbackDir : null;
    if (!srcDir) {
      console.log('Cline hook templates not found — skipping');
      return;
    }

    if (!existsSync(clineHooksDir)) {
      mkdirSync(clineHooksDir, { recursive: true });
    }

    const hookFiles = readdirSync(srcDir).filter((f) => !f.startsWith('.'));
    for (const hookFile of hookFiles) {
      const template = readFileSync(join(srcDir, hookFile), 'utf-8');
      const content = template.replace(/__LAYMAN_URL__/g, this.options.serverUrl);
      const destPath = join(clineHooksDir, hookFile);
      writeFileSync(destPath, content, { mode: 0o755 });
    }

    // Write version marker for staleness detection
    const versionContent = commandHash(hookFiles.map((f) => readFileSync(join(srcDir, f), 'utf-8')).join(''));
    writeFileSync(join(clineHooksDir, '.layman-version'), versionContent, 'utf-8');

    console.log(`Cline hook scripts installed at ${clineHooksDir} (${hookFiles.length} hooks)`);
  }

  /** Remove Cline hook scripts installed by Layman. */
  uninstallClineHooks(): void {
    const clineHooksDir = join(homedir(), 'Documents', 'Cline', 'Hooks');
    const versionFile = join(clineHooksDir, '.layman-version');

    // Only remove if we installed them (version marker exists)
    if (!existsSync(versionFile)) return;

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const templatesDir = join(__dirname, '..', '..', 'hooks', 'cline');
    const fallbackDir = join(__dirname, '..', 'hooks', 'cline');
    const srcDir = existsSync(templatesDir) ? templatesDir : existsSync(fallbackDir) ? fallbackDir : null;

    if (srcDir) {
      const hookFiles = readdirSync(srcDir).filter((f) => !f.startsWith('.'));
      for (const hookFile of hookFiles) {
        const destPath = join(clineHooksDir, hookFile);
        if (existsSync(destPath)) {
          try { unlinkSync(destPath); } catch { /* ignore */ }
        }
      }
    }

    try { unlinkSync(versionFile); } catch { /* ignore */ }
    console.log(`Cline hook scripts removed from ${clineHooksDir}`);
  }

  /** Check if Cline hook scripts are installed and up to date. */
  getClineHooksStatus(): { installed: boolean; upToDate: boolean } {
    const clineHooksDir = join(homedir(), 'Documents', 'Cline', 'Hooks');
    const versionFile = join(clineHooksDir, '.layman-version');

    if (!existsSync(versionFile)) return { installed: false, upToDate: false };

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const templatesDir = join(__dirname, '..', '..', 'hooks', 'cline');
    const fallbackDir = join(__dirname, '..', 'hooks', 'cline');
    const srcDir = existsSync(templatesDir) ? templatesDir : existsSync(fallbackDir) ? fallbackDir : null;
    if (!srcDir) return { installed: true, upToDate: false };

    const hookFiles = readdirSync(srcDir).filter((f) => !f.startsWith('.'));
    const expectedHash = commandHash(hookFiles.map((f) => readFileSync(join(srcDir, f), 'utf-8')).join(''));
    const installedHash = readFileSync(versionFile, 'utf-8').trim();

    return { installed: true, upToDate: installedHash === expectedHash };
  }

  /** Install Codex hook scripts and hooks.json to ~/.codex/ if Codex is detected. */
  installCodexHooks(): void {
    const codexConfigDir = join(homedir(), '.codex');
    if (!existsSync(codexConfigDir)) return;

    const __dirname = dirname(fileURLToPath(import.meta.url));
    // In production (dist/), __dirname is packages/server/dist/ so hooks are at ../../hooks/codex.
    // In development (src/), tsup puts output one level shallower, so fall back to ../hooks/codex.
    const templatesDir = join(__dirname, '..', '..', 'hooks', 'codex');
    const fallbackDir = join(__dirname, '..', 'hooks', 'codex');
    const srcDir = existsSync(templatesDir) ? templatesDir : existsSync(fallbackDir) ? fallbackDir : null;
    if (!srcDir) {
      console.log('Codex hook templates not found — skipping');
      return;
    }

    // Install hook scripts to ~/.codex/hooks/layman/
    const codexHooksDir = join(codexConfigDir, 'hooks', 'layman');
    if (!existsSync(codexHooksDir)) {
      mkdirSync(codexHooksDir, { recursive: true });
    }

    const hookFiles = readdirSync(srcDir).filter((f) => !f.startsWith('.'));
    for (const hookFile of hookFiles) {
      const template = readFileSync(join(srcDir, hookFile), 'utf-8');
      const content = template.replace(/__LAYMAN_URL__/g, this.options.serverUrl);
      const destPath = join(codexHooksDir, hookFile);
      writeFileSync(destPath, content, { mode: 0o755 });
    }

    // Write version marker for staleness detection
    const versionContent = commandHash(hookFiles.map((f) => readFileSync(join(srcDir, f), 'utf-8')).join(''));
    writeFileSync(join(codexHooksDir, '.layman-version'), versionContent, 'utf-8');

    // Merge Layman entries into ~/.codex/hooks.json
    const hooksJsonPath = join(codexConfigDir, 'hooks.json');
    let hooksJson: Record<string, unknown[]> = {};
    if (existsSync(hooksJsonPath)) {
      try {
        const raw = readFileSync(hooksJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
        hooksJson = parsed.hooks ?? {};
      } catch { /* start fresh */ }
    }

    const laymanHookMarker = '__layman__';
    const codexEvents: Array<{ event: string; file: string; timeout: number }> = [
      { event: 'PreToolUse',       file: 'PreToolUse',       timeout: 60 },
      { event: 'PostToolUse',      file: 'PostToolUse',      timeout: 10 },
      { event: 'SessionStart',     file: 'SessionStart',     timeout: 10 },
      { event: 'UserPromptSubmit', file: 'UserPromptSubmit', timeout: 10 },
      { event: 'Stop',             file: 'Stop',             timeout: 10 },
    ];

    // Codex runs on the host machine and executes hook command paths literally.
    // The installer runs inside Docker where homedir() = /root, but the host home
    // is passed via HOST_HOME so the paths written to hooks.json are valid on the host.
    const hostHome = process.env.HOST_HOME || homedir();
    const hostCodexHooksDir = join(hostHome, '.codex', 'hooks', 'layman');

    for (const { event, file, timeout } of codexEvents) {
      const scriptPath = join(hostCodexHooksDir, file);
      if (!hooksJson[event]) hooksJson[event] = [];
      // Remove existing Layman entries for this event
      hooksJson[event] = (hooksJson[event] as Array<Record<string, unknown>>).filter(
        (group) => !(group[laymanHookMarker] === true)
      );
      // Add new Layman entry
      hooksJson[event].push({
        matcher: '',
        [laymanHookMarker]: true,
        hooks: [{ type: 'command', command: scriptPath, timeout }],
      });
    }

    writeFileSync(hooksJsonPath, JSON.stringify({ hooks: hooksJson }, null, 2) + '\n', 'utf-8');
    console.log(`Codex hook scripts installed at ${codexHooksDir} (${hookFiles.length} hooks)`);
    console.log(`Codex hooks.json updated at ${hooksJsonPath}`);

    // Enable the codex_hooks feature flag in config.toml — it is disabled by default.
    // Without this, Codex ignores hooks.json entirely and no hook scripts will run.
    this.enableCodexHooksFeature(codexConfigDir);
  }

  /**
   * Enable the `codex_hooks` feature flag in ~/.codex/config.toml.
   * Codex disables hooks by default; without this flag, hooks.json is ignored.
   * We do simple line-based TOML editing rather than a full TOML parser.
   */
  private enableCodexHooksFeature(codexConfigDir: string): void {
    const configPath = join(codexConfigDir, 'config.toml');
    const raw = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '';
    const lines = raw.split('\n');

    // Already enabled — nothing to do
    if (lines.some((l) => /^\s*codex_hooks\s*=\s*true/.test(l))) return;

    // Remove any existing codex_hooks = false line
    const filtered = lines.filter((l) => !/^\s*codex_hooks\s*=/.test(l));

    // Find the [features] section and insert after it, otherwise append a new section
    const featuresIdx = filtered.findIndex((l) => /^\[features\]/.test(l));
    if (featuresIdx !== -1) {
      filtered.splice(featuresIdx + 1, 0, 'codex_hooks = true');
    } else {
      // Ensure a blank line separator before the new section
      if (filtered.length > 0 && filtered[filtered.length - 1].trim() !== '') {
        filtered.push('');
      }
      filtered.push('[features]', 'codex_hooks = true', '');
    }

    writeFileSync(configPath, filtered.join('\n'), 'utf-8');
    console.log('Codex: enabled codex_hooks feature flag in config.toml');
  }

  /** Remove Codex hook scripts and Layman entries from ~/.codex/hooks.json. */
  uninstallCodexHooks(): void {
    const codexConfigDir = join(homedir(), '.codex');
    const codexHooksDir = join(codexConfigDir, 'hooks', 'layman');
    const versionFile = join(codexHooksDir, '.layman-version');

    // Only remove scripts if we installed them (version marker exists)
    if (existsSync(versionFile)) {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      // Production path (dist/) vs development path — see installCodexHooks for explanation.
      const templatesDir = join(__dirname, '..', '..', 'hooks', 'codex');
      const fallbackDir = join(__dirname, '..', 'hooks', 'codex');
      const srcDir = existsSync(templatesDir) ? templatesDir : existsSync(fallbackDir) ? fallbackDir : null;

      if (srcDir) {
        const hookFiles = readdirSync(srcDir).filter((f) => !f.startsWith('.'));
        for (const hookFile of hookFiles) {
          const destPath = join(codexHooksDir, hookFile);
          if (existsSync(destPath)) {
            try { unlinkSync(destPath); } catch { /* ignore */ }
          }
        }
      }
      try { unlinkSync(versionFile); } catch { /* ignore */ }
    }

    // Remove Layman entries from hooks.json
    const hooksJsonPath = join(codexConfigDir, 'hooks.json');
    if (existsSync(hooksJsonPath)) {
      try {
        const raw = readFileSync(hooksJsonPath, 'utf-8');
        const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
        if (parsed.hooks) {
          for (const event of Object.keys(parsed.hooks)) {
            parsed.hooks[event] = (parsed.hooks[event] as Array<Record<string, unknown>>).filter(
              (group) => !(group['__layman__'] === true)
            );
            if (parsed.hooks[event].length === 0) delete parsed.hooks[event];
          }
          if (Object.keys(parsed.hooks).length === 0) delete parsed.hooks;
          writeFileSync(hooksJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
        }
      } catch { /* ignore */ }
    }

    console.log('Codex hook scripts removed');
  }

  /** Check if Codex hook scripts are installed and up to date. */
  getCodexHooksStatus(): { installed: boolean; upToDate: boolean } {
    const codexHooksDir = join(homedir(), '.codex', 'hooks', 'layman');
    const versionFile = join(codexHooksDir, '.layman-version');

    if (!existsSync(versionFile)) return { installed: false, upToDate: false };

    const __dirname = dirname(fileURLToPath(import.meta.url));
    // Production path (dist/) vs development path — see installCodexHooks for explanation.
    const templatesDir = join(__dirname, '..', '..', 'hooks', 'codex');
    const fallbackDir = join(__dirname, '..', 'hooks', 'codex');
    const srcDir = existsSync(templatesDir) ? templatesDir : existsSync(fallbackDir) ? fallbackDir : null;
    if (!srcDir) return { installed: true, upToDate: false };

    const hookFiles = readdirSync(srcDir).filter((f) => !f.startsWith('.'));
    const expectedHash = commandHash(hookFiles.map((f) => readFileSync(join(srcDir, f), 'utf-8')).join(''));
    const installedHash = readFileSync(versionFile, 'utf-8').trim();

    return { installed: true, upToDate: installedHash === expectedHash };
  }

  /** Install the slash command for optional clients whose config dir already exists.
   *  Pass a clientId to restrict to a single client; omit to install all detected. */
  installOptionalClientCommands(clientId?: string): void {
    const defaultContent = getCommandContent();
    const clients = clientId ? OPTIONAL_CLIENTS.filter((c) => c.id === clientId) : OPTIONAL_CLIENTS;

    for (const client of clients) {
      if (!existsSync(client.configDir)) continue; // client not installed — skip
      if (!existsSync(client.commandsDir)) {
        mkdirSync(client.commandsDir, { recursive: true });
      }
      const content = client.getContent ? client.getContent() : defaultContent;
      const hash = commandHash(content);
      const tagged = `${content.trimEnd()}\n<!-- layman:${hash} -->\n`;
      const fileName = client.fileName ?? 'layman.md';
      writeFileSync(join(client.commandsDir, fileName), tagged, 'utf-8');
      console.log(`Layman command installed for ${client.name} at ${join(client.commandsDir, fileName)}`);
    }
  }

  /** Remove the slash command for all optional clients where it is present. */
  uninstallOptionalClientCommands(): void {
    for (const client of OPTIONAL_CLIENTS) {
      const fileName = client.fileName ?? 'layman.md';
      const cmdPath = join(client.commandsDir, fileName);
      if (existsSync(cmdPath)) {
        try {
          unlinkSync(cmdPath);
          console.log(`Layman command removed from ${cmdPath}`);
        } catch {
          // Ignore
        }
      }
    }
  }

  /** Install integration for a single client by id ('claude-code' | 'codex' | 'opencode' | 'mistral-vibe' | 'cline'). */
  installClient(id: string): void {
    if (id === 'claude-code') {
      this.install();
      this.installCommand();
      return;
    }
    this.installOptionalClientCommands(id);
    if (id === 'codex') this.installCodexHooks();
    if (id === 'cline') this.installClineHooks();
  }

  /** Uninstall integration for a single client by id. */
  uninstallClient(id: string): void {
    if (id === 'claude-code') {
      this.uninstall();
      this.uninstallCommand();
      return;
    }
    const client = OPTIONAL_CLIENTS.find((c) => c.id === id);
    if (!client) return;
    const fileName = client.fileName ?? 'layman.md';
    const cmdPath = join(client.commandsDir, fileName);
    if (existsSync(cmdPath)) {
      try { unlinkSync(cmdPath); } catch { /* ignore */ }
    }
    if (id === 'codex') this.uninstallCodexHooks();
    if (id === 'cline') this.uninstallClineHooks();
  }

  isInstalled(): boolean {
    if (!existsSync(GLOBAL_SETTINGS_PATH)) return false;
    const settings = readSettings(GLOBAL_SETTINGS_PATH);
    if (!settings.hooks) return false;

    const preToolUse = settings.hooks['PreToolUse'];
    if (!preToolUse) return false;

    return preToolUse.some((m) => m.hooks.some((h) => isLaymanHook(h as HookEntry, this.options.serverUrl)));
  }

  getStatus(): SetupStatus {
    // Hooks status
    const hooksInstalled = this.isInstalled();
    let hooksUpToDate = false;
    if (hooksInstalled) {
      // Check that every expected hook event type is present with the correct URL.
      // This catches both URL changes (e.g. server moved to a different port) and
      // structural changes (e.g. new hook event types added in a Layman update).
      const settings = readSettings(GLOBAL_SETTINGS_PATH);
      const expectedHooks = buildLaymanHooks(this.options.serverUrl, this.options.hookTimeout);
      hooksUpToDate = Object.entries(expectedHooks).every(([eventName, expectedMatchers]) => {
        const installedMatchers = settings.hooks?.[eventName] ?? [];
        return expectedMatchers.every((expectedMatcher) =>
          expectedMatcher.hooks.every((expectedHook) =>
            installedMatchers.some((installedMatcher) =>
              installedMatcher.hooks.some((h) => {
                const hook = h as HookEntry;
                return isLaymanHook(hook, this.options.serverUrl) && hook.url === expectedHook.url;
              })
            )
          )
        );
      });
    }

    // Command status
    const cmdPath = join(COMMANDS_DIR, 'layman.md');
    const commandInstalled = existsSync(cmdPath);
    let commandUpToDate = false;
    if (commandInstalled) {
      const installed = readFileSync(cmdPath, 'utf-8');
      const expectedContent = getCommandContent();
      const expectedHash = commandHash(expectedContent);
      commandUpToDate = installed.includes(`layman:${expectedHash}`);
    }

    // Optional client status
    const defaultContent = getCommandContent();
    const optionalClients: OptionalClientStatus[] = OPTIONAL_CLIENTS.map((client) => {
      // Check signal files to avoid false positives from empty Docker mount directories
      const dirExists = existsSync(client.configDir);
      const detected = dirExists && (
        !client.signalFiles?.length ||
        client.signalFiles.some((f) => existsSync(join(client.configDir, f)))
      );
      const fileName = client.fileName ?? 'layman.md';
      const clientCmdPath = join(client.commandsDir, fileName);
      const content = client.getContent ? client.getContent() : defaultContent;
      const expectedHash = commandHash(content);
      const commandInstalled = existsSync(clientCmdPath);
      const commandUpToDate = commandInstalled
        ? readFileSync(clientCmdPath, 'utf-8').includes(`layman:${expectedHash}`)
        : false;

      // Hook script status for clients that use them
      let hooksInstalled: boolean | undefined;
      let hooksUpToDate: boolean | undefined;
      if (client.id === 'codex') {
        const hs = this.getCodexHooksStatus();
        hooksInstalled = hs.installed;
        hooksUpToDate = hs.upToDate;
      } else if (client.id === 'cline') {
        const hs = this.getClineHooksStatus();
        hooksInstalled = hs.installed;
        hooksUpToDate = hs.upToDate;
      }

      return { id: client.id, name: client.name, detected, commandInstalled, commandUpToDate, hooksInstalled, hooksUpToDate };
    });

    return { hooksInstalled, hooksUpToDate, commandInstalled, commandUpToDate, optionalClients };
  }

  getSettingsPath(): string {
    return GLOBAL_SETTINGS_PATH;
  }
}

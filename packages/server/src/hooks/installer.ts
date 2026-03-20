import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
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
  name: string;
  detected: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
}

export interface SetupStatus {
  hooksInstalled: boolean;
  hooksUpToDate: boolean;
  commandInstalled: boolean;
  commandUpToDate: boolean;
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
const OPTIONAL_CLIENTS: Array<{ name: string; configDir: string; commandsDir: string }> = [
  {
    name: 'OpenCode',
    configDir: join(homedir(), '.config', 'opencode'),
    commandsDir: join(homedir(), '.config', 'opencode', 'commands'),
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
  };
}

function isLaymanHook(hook: HookEntry): boolean {
  return hook._layman === true;
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
    '   `curl -s -X POST http://localhost:8880/api/activate`',
    '',
    '2. If the curl command succeeds (returns JSON with "ok"), tell the user:',
    '   "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."',
    '',
    '3. If the curl command fails (connection refused or error), tell the user:',
    '   "Layman server is not running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"',
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

      // Remove existing Layman hooks for this event
      settings.hooks[eventName] = settings.hooks[eventName].filter(
        (m) => !m.hooks.some((h) => isLaymanHook(h as HookEntry))
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

    // Remove all Layman hooks
    for (const eventName of Object.keys(settings.hooks)) {
      settings.hooks[eventName] = settings.hooks[eventName].filter(
        (m) => !m.hooks.some((h) => isLaymanHook(h as HookEntry))
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

  /** Install the slash command for every optional client whose config dir already exists. */
  installOptionalClientCommands(): void {
    const content = getCommandContent();
    const hash = commandHash(content);
    const tagged = `${content.trimEnd()}\n<!-- layman:${hash} -->\n`;

    for (const client of OPTIONAL_CLIENTS) {
      if (!existsSync(client.configDir)) continue; // client not installed — skip
      if (!existsSync(client.commandsDir)) {
        mkdirSync(client.commandsDir, { recursive: true });
      }
      writeFileSync(join(client.commandsDir, 'layman.md'), tagged, 'utf-8');
      console.log(`Layman command installed for ${client.name} at ${join(client.commandsDir, 'layman.md')}`);
    }
  }

  /** Remove the slash command for all optional clients where it is present. */
  uninstallOptionalClientCommands(): void {
    for (const client of OPTIONAL_CLIENTS) {
      const cmdPath = join(client.commandsDir, 'layman.md');
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

  isInstalled(): boolean {
    if (!existsSync(GLOBAL_SETTINGS_PATH)) return false;
    const settings = readSettings(GLOBAL_SETTINGS_PATH);
    if (!settings.hooks) return false;

    const preToolUse = settings.hooks['PreToolUse'];
    if (!preToolUse) return false;

    return preToolUse.some((m) => m.hooks.some((h) => isLaymanHook(h as HookEntry)));
  }

  getStatus(): SetupStatus {
    // Hooks status
    const hooksInstalled = this.isInstalled();
    let hooksUpToDate = false;
    if (hooksInstalled) {
      // Check if the URL in the installed hooks matches our serverUrl
      const settings = readSettings(GLOBAL_SETTINGS_PATH);
      const preToolUse = settings.hooks?.['PreToolUse'] ?? [];
      const laymanMatcher = preToolUse.find((m) => m.hooks.some((h) => isLaymanHook(h as HookEntry)));
      if (laymanMatcher) {
        const hook = laymanMatcher.hooks.find((h) => isLaymanHook(h as HookEntry));
        hooksUpToDate = hook?.url === `${this.options.serverUrl}/hooks/PreToolUse`;
      }
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
    const expectedContent = getCommandContent();
    const expectedHash = commandHash(expectedContent);
    const optionalClients: OptionalClientStatus[] = OPTIONAL_CLIENTS.map((client) => {
      const detected = existsSync(client.configDir);
      const clientCmdPath = join(client.commandsDir, 'layman.md');
      const commandInstalled = existsSync(clientCmdPath);
      const commandUpToDate = commandInstalled
        ? readFileSync(clientCmdPath, 'utf-8').includes(`layman:${expectedHash}`)
        : false;
      return { name: client.name, detected, commandInstalled, commandUpToDate };
    });

    return { hooksInstalled, hooksUpToDate, commandInstalled, commandUpToDate, optionalClients };
  }

  getSettingsPath(): string {
    return GLOBAL_SETTINGS_PATH;
  }
}

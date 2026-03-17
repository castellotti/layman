import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

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
  global?: boolean;
  settingsPath?: string;
  cwd?: string;
}

function getSettingsPath(options: HookInstallerOptions): string {
  if (options.settingsPath) return options.settingsPath;
  if (options.global) {
    return join(homedir(), '.claude', 'settings.json');
  }
  const cwd = options.cwd ?? process.cwd();
  return join(cwd, '.claude', 'settings.local.json');
}

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

export class HookInstaller {
  private settingsPath: string;

  constructor(private options: HookInstallerOptions) {
    this.settingsPath = getSettingsPath(options);
  }

  install(): void {
    const settings = readSettings(this.settingsPath);
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

    writeSettings(this.settingsPath, settings);
    console.log(`Layman hooks installed at ${this.settingsPath}`);
  }

  uninstall(): void {
    if (!existsSync(this.settingsPath)) return;

    const settings = readSettings(this.settingsPath);
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
        unlinkSync(this.settingsPath);
        console.log(`Removed empty settings file at ${this.settingsPath}`);
      } catch {
        // Ignore
      }
    } else {
      writeSettings(this.settingsPath, settings);
    }

    console.log(`Layman hooks uninstalled from ${this.settingsPath}`);
  }

  isInstalled(): boolean {
    if (!existsSync(this.settingsPath)) return false;
    const settings = readSettings(this.settingsPath);
    if (!settings.hooks) return false;

    const preToolUse = settings.hooks['PreToolUse'];
    if (!preToolUse) return false;

    return preToolUse.some((m) => m.hooks.some((h) => isLaymanHook(h as HookEntry)));
  }

  getSettingsPath(): string {
    return this.settingsPath;
  }
}

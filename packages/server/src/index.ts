#!/usr/bin/env node
import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { createServer } from './server.js';
import { HookInstaller } from './hooks/installer.js';
import { loadConfig, setConfig } from './config/config.js';
import type { LaymanConfig } from './config/schema.js';

const PID_FILE = join(tmpdir(), 'layman.pid');
const VERSION = '0.1.0';

const program = new Command();

program
  .name('layman')
  .description('Claude Code companion — monitor and approve tool calls via a browser UI')
  .version(VERSION);

// ── layman start ──────────────────────────────────────────────────────────────
program
  .command('start')
  .description('Start the Layman server and install hooks')
  .option('-p, --port <number>', 'Port to listen on', '8090')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .option('--analysis-model <model>', 'Analysis model (haiku|sonnet|opus or full model name)', 'sonnet')
  .option('--analysis-endpoint <url>', 'Custom OpenAI-compatible endpoint URL')
  .option('--analysis-api-key <key>', 'API key for analysis model')
  .option('--auto-analyze <mode>', 'Auto-analyze mode: all|risky|none', 'risky')
  .option('--no-open', 'Do not open browser automatically')
  .option('--hook-timeout <seconds>', 'Hook timeout in seconds', '300')
  .option('--settings-path <path>', 'Override path to .claude/settings.local.json')
  .option('--hook-url <url>', 'URL written into hook config (overrides host:port, useful for Docker)')
  .option('--global', 'Install hooks in global ~/.claude/settings.json')
  .action(async (options) => {
    const cliFlags: Partial<LaymanConfig> = {
      port: parseInt(options.port, 10),
      host: options.host,
      autoAnalyze: options.autoAnalyze as 'all' | 'risky' | 'none',
      open: options.open !== false,
      hookTimeout: parseInt(options.hookTimeout, 10),
      settingsPath: options.settingsPath,
      hookUrl: options.hookUrl,
      global: options.global ?? false,
      analysis: {
        provider: options.analysisEndpoint ? 'openai-compatible' : 'anthropic',
        model: options.analysisModel,
        endpoint: options.analysisEndpoint,
        apiKey: options.analysisApiKey,
        maxTokens: 400,
        temperature: 0.1,
      },
    };

    const config = await loadConfig(cliFlags);
    setConfig(config);

    await startServer(config);
  });

// ── layman stop ───────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the Layman server and remove hooks')
  .option('--settings-path <path>', 'Override path to .claude/settings.local.json')
  .option('--global', 'Remove from global ~/.claude/settings.json')
  .action(async (options) => {
    const config = await loadConfig({
      settingsPath: options.settingsPath,
      global: options.global ?? false,
    });

    // Uninstall hooks
    const installer = new HookInstaller({
      serverUrl: config.hookUrl ?? `http://${config.host}:${config.port}`,
      hookTimeout: config.hookTimeout,
      global: config.global,
      settingsPath: config.settingsPath,
    });
    installer.uninstall();

    // Signal running server to shutdown
    if (existsSync(PID_FILE)) {
      try {
        const pidStr = readFileSync(PID_FILE, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        process.kill(pid, 'SIGTERM');
        console.log(`Sent shutdown signal to Layman server (PID ${pid})`);
      } catch {
        // Server may already be stopped
      }
    }

    // Try HTTP shutdown as fallback
    try {
      await fetch(`http://${config.host}:${config.port}/api/shutdown`, { method: 'POST' });
    } catch {
      // Server may not be running
    }

    console.log('Layman stopped.');
  });

// ── layman wrap ───────────────────────────────────────────────────────────────
program
  .command('wrap <command...>')
  .description('Start Layman server, run command, cleanup on exit')
  .option('-p, --port <number>', 'Port to listen on', '8090')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .option('--analysis-model <model>', 'Analysis model', 'sonnet')
  .option('--analysis-endpoint <url>', 'Custom OpenAI-compatible endpoint URL')
  .option('--analysis-api-key <key>', 'API key for analysis model')
  .option('--auto-analyze <mode>', 'Auto-analyze mode: all|risky|none', 'risky')
  .option('--no-open', 'Do not open browser automatically')
  .option('--hook-timeout <seconds>', 'Hook timeout in seconds', '300')
  .option('--settings-path <path>', 'Override path to .claude/settings.local.json')
  .option('--hook-url <url>', 'URL written into hook config (overrides host:port, useful for Docker)')
  .option('--global', 'Install hooks in global ~/.claude/settings.json')
  .action(async (commandArgs: string[], options) => {
    const cliFlags: Partial<LaymanConfig> = {
      port: parseInt(options.port, 10),
      host: options.host,
      autoAnalyze: options.autoAnalyze as 'all' | 'risky' | 'none',
      open: options.open !== false,
      hookTimeout: parseInt(options.hookTimeout, 10),
      settingsPath: options.settingsPath,
      hookUrl: options.hookUrl,
      global: options.global ?? false,
      analysis: {
        provider: options.analysisEndpoint ? 'openai-compatible' : 'anthropic',
        model: options.analysisModel,
        endpoint: options.analysisEndpoint,
        apiKey: options.analysisApiKey,
        maxTokens: 400,
        temperature: 0.1,
      },
    };

    const config = await loadConfig(cliFlags);
    setConfig(config);

    const server = await startServer(config, { noExit: true });

    const [cmd, ...args] = commandArgs;
    console.log(`\nRunning: ${commandArgs.join(' ')}\n`);

    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
    });

    const cleanup = async (): Promise<void> => {
      const installer = new HookInstaller({
        serverUrl: `http://${config.host}:${server.getPort()}`,
        hookTimeout: config.hookTimeout,
        global: config.global,
        settingsPath: config.settingsPath,
      });
      installer.uninstall();
      await server.stop();
    };

    child.on('exit', (code) => {
      void cleanup().finally(() => {
        process.exit(code ?? 0);
      });
    });

    process.on('SIGINT', () => {
      child.kill('SIGINT');
    });

    process.on('SIGTERM', () => {
      child.kill('SIGTERM');
    });
  });

// ── layman status ─────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show Layman server status')
  .option('-p, --port <number>', 'Port to check', '8090')
  .option('--host <host>', 'Host to check', 'localhost')
  .action(async (options) => {
    const url = `http://${options.host}:${options.port}`;
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) {
        const status = await response.json() as {
          pendingCount: number;
          eventCount: number;
          uptime: number;
        };
        console.log(`Layman is running at ${url}`);
        console.log(`  Pending approvals: ${status.pendingCount}`);
        console.log(`  Events recorded: ${status.eventCount}`);
        console.log(`  Uptime: ${status.uptime}s`);

        const installer = new HookInstaller({
          serverUrl: url,
          hookTimeout: 300,
        });
        const installed = installer.isInstalled();
        console.log(`  Hooks installed: ${installed ? 'yes' : 'no'}`);
      } else {
        console.log('Layman server responded with an error.');
      }
    } catch {
      console.log(`Layman is not running at ${url}`);

      const installer = new HookInstaller({
        serverUrl: url,
        hookTimeout: 300,
      });
      if (installer.isInstalled()) {
        console.log('  Warning: Hooks are installed but server is not running!');
        console.log('  Run `layman start` to start the server.');
      }
    }
  });

// ─────────────────────────────────────────────────────────────────────────────

async function startServer(
  config: LaymanConfig,
  opts: { noExit?: boolean } = {}
): Promise<ReturnType<typeof createServer>> {
  const server = createServer(config);

  // hookUrl separates the bind address from the URL written into hook configs.
  // When running in Docker with --host 0.0.0.0, pass --hook-url http://localhost:8090
  // so Claude Code (on the host) can reach the container via the mapped port.
  const resolvedHookUrl = config.hookUrl ?? `http://${config.host}:${config.port}`;

  const installer = new HookInstaller({
    serverUrl: resolvedHookUrl,
    hookTimeout: config.hookTimeout,
    global: config.global,
    settingsPath: config.settingsPath,
  });

  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start Layman server:', err);
    process.exit(1);
  }

  const port = server.getPort();
  installer.install();

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  const url = `http://${config.host}:${port}`;
  console.log(`\nLayman v${VERSION} running at ${url}`);
  console.log(`Hooks installed → all tool calls will flow through Layman\n`);

  if (config.open) {
    void openBrowser(url);
  }

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down Layman...');
    installer.uninstall();
    await server.stop();
    if (existsSync(PID_FILE)) {
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(PID_FILE);
      } catch {
        // Ignore
      }
    }
    if (!opts.noExit) process.exit(0);
  };

  if (!opts.noExit) {
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }

  return server;
}

async function openBrowser(url: string): Promise<void> {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {
    // Browser open failed — not critical
  }
}

program.parse(process.argv);

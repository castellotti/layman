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
  .description('Start the Layman server')
  .option('-p, --port <number>', 'Port to listen on', '8880')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .option('--analysis-model <model>', 'Analysis model (haiku|sonnet|opus or full model name)')
  .option('--analysis-endpoint <url>', 'Custom OpenAI-compatible endpoint URL')
  .option('--analysis-api-key <key>', 'API key for analysis model')
  .option('--auto-analyze <mode>', 'Auto-analyze mode: all|risky|none')
  .option('--no-open', 'Do not open browser automatically')
  .option('--hook-timeout <seconds>', 'Hook timeout in seconds', '300')
  .option('--hook-url <url>', 'URL written into hook config (overrides host:port, useful for Docker)')
  .action(async (options) => {
    // Only include analysis in cliFlags when explicitly passed — otherwise
    // the defaults would override the user's saved runtime config on every restart.
    const analysisFlags: Partial<LaymanConfig['analysis']> = {};
    if (options.analysisEndpoint !== undefined) {
      analysisFlags.provider = 'openai-compatible';
      analysisFlags.endpoint = options.analysisEndpoint;
    }
    if (options.analysisModel !== undefined) analysisFlags.model = options.analysisModel;
    if (options.analysisApiKey !== undefined) analysisFlags.apiKey = options.analysisApiKey;

    const cliFlags: Partial<LaymanConfig> = {
      port: parseInt(options.port, 10),
      host: options.host,
      ...(options.autoAnalyze !== undefined ? { autoAnalyze: options.autoAnalyze as 'all' | 'risky' | 'none' } : {}),
      open: options.open !== false,
      hookTimeout: parseInt(options.hookTimeout, 10),
      hookUrl: options.hookUrl,
      ...(Object.keys(analysisFlags).length > 0 ? { analysis: analysisFlags as LaymanConfig['analysis'] } : {}),
    };

    const config = await loadConfig(cliFlags);
    setConfig(config);

    await startServer(config);
  });

// ── layman stop ───────────────────────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the Layman server')
  .action(async () => {
    const config = await loadConfig({});

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
  .option('-p, --port <number>', 'Port to listen on', '8880')
  .option('--host <host>', 'Host to bind to', 'localhost')
  .option('--analysis-model <model>', 'Analysis model')
  .option('--analysis-endpoint <url>', 'Custom OpenAI-compatible endpoint URL')
  .option('--analysis-api-key <key>', 'API key for analysis model')
  .option('--auto-analyze <mode>', 'Auto-analyze mode: all|risky|none')
  .option('--no-open', 'Do not open browser automatically')
  .option('--hook-timeout <seconds>', 'Hook timeout in seconds', '300')
  .option('--hook-url <url>', 'URL written into hook config (overrides host:port, useful for Docker)')
  .action(async (commandArgs: string[], options) => {
    const analysisFlags: Partial<LaymanConfig['analysis']> = {};
    if (options.analysisEndpoint !== undefined) {
      analysisFlags.provider = 'openai-compatible';
      analysisFlags.endpoint = options.analysisEndpoint;
    }
    if (options.analysisModel !== undefined) analysisFlags.model = options.analysisModel;
    if (options.analysisApiKey !== undefined) analysisFlags.apiKey = options.analysisApiKey;

    const cliFlags: Partial<LaymanConfig> = {
      port: parseInt(options.port, 10),
      host: options.host,
      ...(options.autoAnalyze !== undefined ? { autoAnalyze: options.autoAnalyze as 'all' | 'risky' | 'none' } : {}),
      open: options.open !== false,
      hookTimeout: parseInt(options.hookTimeout, 10),
      hookUrl: options.hookUrl,
      ...(Object.keys(analysisFlags).length > 0 ? { analysis: analysisFlags as LaymanConfig['analysis'] } : {}),
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
  .option('-p, --port <number>', 'Port to check', '8880')
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
        const setupStatus = installer.getStatus();
        console.log(`  Hooks installed: ${setupStatus.hooksInstalled ? 'yes' : 'no'}`);
        console.log(`  Command installed: ${setupStatus.commandInstalled ? 'yes' : 'no'}`);
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

  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start Layman server:', err);
    process.exit(1);
  }

  const port = server.getPort();

  // Write PID file
  writeFileSync(PID_FILE, String(process.pid));

  const url = `http://${config.host}:${port}`;

  console.log(`\nLayman v${VERSION} running at ${url}`);
  console.log(`Use /layman in your AI agent to activate monitoring for a session\n`);

  if (config.open) {
    void openBrowser(url);
  }

  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down Layman...');
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

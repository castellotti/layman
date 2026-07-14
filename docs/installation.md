# Installation & Operation

Full reference for running Layman. For the one-command start, see the [README](../README.md#quick-start).

Requires [Docker](https://docs.docker.com/get-started/get-docker/).

## Quick start

**macOS / Linux:**

```bash
mkdir -p ~/layman && curl -fsSL https://raw.githubusercontent.com/castellotti/layman/main/docker-compose.ghcr.yml -o ~/layman/docker-compose.yml && docker compose -f ~/layman/docker-compose.yml up -d
```

**Windows (PowerShell):**

```powershell
md -Force "$env:USERPROFILE\layman"; Invoke-WebRequest "https://raw.githubusercontent.com/castellotti/layman/main/docker-compose.ghcr.yml" -OutFile "$env:USERPROFILE\layman\docker-compose.yml"; $env:HOME=$env:USERPROFILE; docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" up -d
```

> **Windows / WSL2:** If you're running Docker from a WSL2 terminal, use the macOS/Linux command instead.

Then open **http://localhost:8880**. On first visit, a setup wizard lists any AI agent clients detected on your system - toggle the ones you want and click **Accept** to install hooks.

**If you've cloned the repo**, `make start` does the same thing (macOS/Linux).

## Updating

```bash
# macOS / Linux
docker compose -f ~/layman/docker-compose.yml pull && docker compose -f ~/layman/docker-compose.yml up -d
```

```powershell
# Windows (PowerShell)
$env:HOME=$env:USERPROFILE; docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" pull; docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" up -d
```

A banner appears in the dashboard if your hooks or commands are out of date after an update - click **Update** to refresh them.

## Stopping

```bash
# macOS / Linux
docker compose -f ~/layman/docker-compose.yml down
```

```powershell
# Windows (PowerShell)
docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" down
```

If you used `make start`, `make stop` also works.

## What gets mounted

Layman runs in Docker but needs read/write access to several directories on your host machine so it can install hooks and watch agent log files:

| Mount               | Purpose                                                                       |
|---------------------|-------------------------------------------------------------------------------|
| `~/.claude`         | Read/write Claude Code hooks, slash commands, and the StatusLine relay script |
| `~/.config`         | Detect and write commands for XDG-based clients (e.g. OpenCode)               |
| `~/.vibe`           | Detect Mistral Vibe and tail its session log files for passive monitoring     |
| `~/Documents/Cline` | Detect Cline and write hook scripts to `~/Documents/Cline/Hooks/`             |
| `~/.codex`          | Detect Codex and write hook scripts and `~/.codex/hooks.json` entries         |

Layman only writes inside these directories when you explicitly click **Install** in Settings. Nothing is written automatically on startup.

## Port binding

The default config binds to `127.0.0.1:8880`, so the dashboard is only reachable from your local machine. Do not change this to `0.0.0.0` unless you have a specific reason and understand the implications - Layman has no authentication.

## AI analysis (optional)

Layman can use an AI model to classify the risk level of each action and explain it in plain language. To enable this, pass your API key when starting the container:

```bash
ANTHROPIC_API_KEY=your-key-here docker compose -f ~/layman/docker-compose.yml up -d
```

Supports Anthropic, OpenAI-compatible APIs, and LiteLLM. Auto-analysis and auto-explain can be configured independently in **Settings -> Automation**, with severity thresholds (All / Medium+ / High only) and detail level (Quick / Detailed). The analysis model can also be overridden per-panel from the Investigation panel's model selector.

## Compose file reference

The compose file downloaded by the Quick Start command is [`docker-compose.ghcr.yml`](../docker-compose.ghcr.yml) from this repo. You can review it before running, or substitute any fields (e.g. a pinned image tag instead of `latest`).

> **Windows:** The compose file uses `${HOME}` for volume paths. The PowerShell Quick Start command sets `$env:HOME=$env:USERPROFILE` so Docker Compose resolves these correctly - no manual editing needed. If you run docker compose commands later, prefix them with `$env:HOME=$env:USERPROFILE;` or set `HOME` persistently in your system environment variables.

## Adding a new AI client

If you install a supported client after Layman is already running:

1. Install the client as normal.
2. Open the Layman dashboard at http://localhost:8880.
3. Go to **Settings** (gear icon) -> **Connection**.
4. Click **Install** next to the newly detected client - Layman writes its hooks and commands.

No container restart required.

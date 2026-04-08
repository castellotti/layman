# Layman

*Agentic Insight and Oversight*

* Monitor your AI assistants
* Explain their actions in Layman's Terms
* Analyze for risk, security, and safety automatically
* Evaluate "Drift" from user directives and `CLAUDE.md` (or `AGENTS.md`) instructions
* Visualize and explore live activity in a dashboard, logs, or flowchart
* Record and Bookmark sessions including user prompts and agent responses
  * Opt-in required
  * PII filtered by default

When AI coding assistants like Claude Code, Codex, OpenCode, Mistral Vibe, or Cline help you build software, they do it by reading your files, writing code, and performing dozens of actions per session.

Layman is a dashboard that explains exactly what your AI assistants are doing, in plain language, in your web browser. Understand and remember every file AI reads, every change AI makes, every command AI runs.

---

### Supported Harnesses
- [Claude Code](https://github.com/anthropics/claude-code)
- OpenAI [Codex](https://github.com/openai/codex)
- Mistral [Vibe](https://github.com/mistralai/mistral-vibe)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Cline](https://github.com/cline/cline)

---

## Screenshot

<img width="1412" height="860" alt="layman_screenshot" src="https://github.com/user-attachments/assets/2b0294bc-b889-4a4c-a42f-2f25fc1aff0f" />

---

## Features

### Drift monitoring

Layman continuously monitors AI agent sessions for two kinds of drift:

- **Session goal drift** - detects when the agent strays from what you asked it to do (scope creep, phantom file references, pattern breaks).
- **Rules drift** - detects when the agent violates rules defined in your project's `CLAUDE.md` files (wrong commands, forbidden actions, convention breaks). `AGENTS.md` files are also supported for harnesses besides Claude Code.

Drift scores are EMA-smoothed (alpha 0.3) to avoid reacting to one-off spikes. Scores map to four color levels (green → yellow → orange → red) with configurable thresholds. At **orange** the agent gets an in-context reminder; at **red** Layman can pause the agent entirely and require your approval to continue. Individual drift findings can be dismissed as false positives - dismissed items are fed back into the LLM prompt so they won't be re-flagged.

<img width="366" height="435" alt="Screenshot 2026-04-07 at 6 15 50 PM" src="https://github.com/user-attachments/assets/df4bb03a-89e1-4b7d-a5f8-ee92a64d1878" />

<img width="249" height="153" alt="Screenshot 2026-04-07 at 8 01 28 PM" src="https://github.com/user-attachments/assets/3d6792c1-496e-47a7-acc0-2cb114f293f6" />

<img width="833" height="385" alt="Screenshot 2026-04-06 at 11 46 38 PM" src="https://github.com/user-attachments/assets/e4054dc2-c05b-4b35-9bce-c287714a7004" />

### AI analysis

Layman can use an AI model to classify the risk level of each action, explain what it means in plain language, and flag anything that looks risky.

<img width="635" height="613" alt="Screenshot 2026-04-07 at 11 15 12 PM" src="https://github.com/user-attachments/assets/e9bdec54-c883-425e-9cbe-d429cafcb230" />

![layman-demo-flowchart-analysis](https://github.com/user-attachments/assets/3a71177e-41be-4920-97e6-6005354c169d)

### Flowchart view

Toggle between the event timeline and an interactive directed graph that shows how tool calls, agent responses, and user prompts connect. Pan and zoom with the mouse or keyboard, and click any node to open the Investigation panel for that event. Available for both live and historical sessions.

<img width="1266" height="473" alt="Screenshot 2026-04-07 at 7 58 46 PM" src="https://github.com/user-attachments/assets/9f72ed19-a7f1-4fb4-ad61-aeb5c97fe11d" />

![layman-demo-dashboard-flowchart-zoom](https://github.com/user-attachments/assets/bbb1534a-8d05-49b2-a9b9-aa8eced0d8f8)

### Session summary

Each session header shows an AI-generated plain-English summary of what the agent did, updated live as the session progresses and available in history. Click the summary to see previous versions and timestamps.

<img width="403" height="294" alt="Screenshot 2026-04-07 at 11 17 40 PM" src="https://github.com/user-attachments/assets/4ab329e6-3e17-4028-a8c2-9fcfd3052320" />

### Session metrics

When connected to Claude Code, the dashboard shows a live metrics bar with model name, context window usage, cumulative session cost, token counts, lines changed, and rate limit warnings.

<img width="553" height="28" alt="Screenshot 2026-04-07 at 11 39 20 PM" src="https://github.com/user-attachments/assets/1d1ce557-e0ef-4dd3-9d3b-384d753c0bd2" />

### Tool approval

For Claude Code and Cline, Layman can intercept tool calls before they execute and ask for your approval.

<img width="981" height="419" alt="Screenshot 2026-03-18 at 12 04 50 AM" src="https://github.com/user-attachments/assets/c103aeac-ce58-4180-b939-e64c52759023" />

### File and URL access tracking

Layman tracks every file the agent reads or writes and every URL it fetches during a session, surfacing them in a dedicated access panel so you can see exactly what was touched.

<img width="689" height="378" alt="Screenshot 2026-04-07 at 11 29 55 PM" src="https://github.com/user-attachments/assets/8aed7008-188a-4bea-9490-c81f695dfd67" />

### PII filter

All logged events are automatically scanned for personally identifiable information (email addresses, API keys, passwords, credit card numbers, etc.) and redacted before storage. Toggle in **Settings → Session Recording → PII Filter**.

<img width="460" height="343" alt="Screenshot 2026-04-07 at 6 07 32 PM" src="https://github.com/user-attachments/assets/215e8672-c105-4354-a0df-406eb0532c5a" />

### Setup Wizard

Intial setup is aided by a complete setup wizard to walk through some available configuration options.

![layman_setup_wizard](https://github.com/user-attachments/assets/c2be7511-6bc2-4514-8b56-4c66660c7ce9)

---

## Dashboard Icons

| Icon | Meaning                                                  |
|------|----------------------------------------------------------|
| ⚡    | Tool call pending approval                               |
| ✅    | Tool call approved                                       |
| ❌    | Tool call denied                                         |
| ⏭    | Tool call delegated (auto-allowed)                       |
| ✓    | Tool call completed                                      |
| ✗    | Tool call failed                                         |
| 🔐   | Permission request (Claude asking for explicit approval) |
| 💬   | User prompt                                              |
| 🤖   | Agent response                                           |
| -    | Agent stopped                                            |
| 🟢   | Session started                                          |
| ⬜    | Session ended                                            |
| 🔔   | Notification                                             |
| 🔀   | Subagent started / stopped                               |
| ⚠    | Stop failure                                             |
| 📦   | Context compacted                                        |
| 📋   | Elicitation (structured input request)                   |
| 🔍   | Analysis result                                          |
| 📐   | Drift check completed                                    |
| 🚨   | Drift alert (level changed)                              |

Agent badges in session cards:
* **CC** = Claude Code
* **CX** = Codex
* **OC** = OpenCode
* **MV** = Mistral Vibe
* **CL** = Cline

---

## Setup

Requires [Docker](https://docs.docker.com/get-started/get-docker/).

### Quick Start

**macOS / Linux** - one command downloads the config and starts Layman:

```bash
mkdir -p ~/layman && curl -fsSL https://raw.githubusercontent.com/castellotti/layman/main/docker-compose.ghcr.yml -o ~/layman/docker-compose.yml && docker compose -f ~/layman/docker-compose.yml up -d
```

**Windows (PowerShell):**

```powershell
md -Force "$env:USERPROFILE\layman"; Invoke-WebRequest "https://raw.githubusercontent.com/castellotti/layman/main/docker-compose.ghcr.yml" -OutFile "$env:USERPROFILE\layman\docker-compose.yml"; $env:HOME=$env:USERPROFILE; docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" up -d
```

> **Windows / WSL2:** If you're running Docker from a WSL2 terminal, use the macOS/Linux command above instead.

Then open **http://localhost:8880**. On first visit, a modal lists any AI agent clients detected on your system - toggle the ones you want and click **Accept** to install hooks.

**If you've cloned the repo**, `make start` does the same thing (macOS/Linux).

To update to the latest image:

```bash
# macOS / Linux
docker compose -f ~/layman/docker-compose.yml pull && docker compose -f ~/layman/docker-compose.yml up -d
```

```powershell
# Windows (PowerShell)
$env:HOME=$env:USERPROFILE; docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" pull; docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" up -d
```

To stop:

```bash
# macOS / Linux
docker compose -f ~/layman/docker-compose.yml down
```

```powershell
# Windows (PowerShell)
docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" down
```

A banner will appear in the dashboard if your hooks or commands are out of date after an update - click **Update** to refresh them.

---

### Full Details

#### What gets mounted

Layman runs in Docker but needs read/write access to several directories on your host machine so it can install hooks and watch agent log files:

| Mount               | Purpose                                                                       |
|---------------------|-------------------------------------------------------------------------------|
| `~/.claude`         | Read/write Claude Code hooks, slash commands, and the StatusLine relay script |
| `~/.config`         | Detect and write commands for XDG-based clients (e.g. OpenCode)               |
| `~/.vibe`           | Detect Mistral Vibe and tail its session log files for passive monitoring     |
| `~/Documents/Cline` | Detect Cline and write hook scripts to `~/Documents/Cline/Hooks/`             |
| `~/.codex`          | Detect Codex and write hook scripts and `~/.codex/hooks.json` entries         |

Layman only writes inside these directories when you explicitly click **Install** in Settings. Nothing is written automatically on startup.

#### Port binding

The default config binds to `127.0.0.1:8880`, so the dashboard is only reachable from your local machine. Do not change this to `0.0.0.0` unless you have a specific reason and understand the implications - Layman has no authentication.

#### AI analysis (optional)

Layman can use an AI model to classify the risk level of each action and explain it in plain language. To enable this, pass your API key when starting the container:

```bash
ANTHROPIC_API_KEY=your-key-here docker compose -f ~/layman/docker-compose.yml up -d
```

Supports Anthropic, OpenAI-compatible APIs, and LiteLLM. Auto-analysis and auto-explain can be configured independently in **Settings → Analysis**, with severity thresholds (All / Medium+ / High only) and detail level (Quick / Detailed).

#### Compose file reference

The compose file downloaded by the Quick Start command is [`docker-compose.ghcr.yml`](docker-compose.ghcr.yml) from this repo. You can review it before running, or substitute any fields (e.g. a pinned image tag instead of `latest`).

> **Windows:** The compose file uses `${HOME}` for volume paths. The PowerShell Quick Start command sets `$env:HOME=$env:USERPROFILE` so Docker Compose resolves these correctly - no manual editing needed. If you run docker compose commands later, prefix them with `$env:HOME=$env:USERPROFILE;` or set `HOME` persistently in your system environment variables.

---

## Usage by agent

### Claude Code

Sessions are **not** recorded by default. To opt a session in:

1. Start Claude Code in any project directory:
   ```bash
   claude
   ```

2. Type `/layman` inside the Claude Code session.

3. Claude runs an activation command. From that point on, all events flow to the dashboard.

You can activate multiple sessions across different projects - they all appear in the same dashboard.

**Auto-activate:** To skip the `/layman` step, go to **Settings → Client Setup** and toggle **Auto-activate sessions** on the Claude Code row. All new Claude Code sessions will be monitored automatically.

---

### Codex

Codex uses shell-script hooks that Layman installs to `~/.codex/hooks/layman/` and registers in `~/.codex/hooks.json`. Sessions are activated per-session by typing `@layman` in Codex.

**Installation** (first time or after a Layman update):

1. Ensure Codex is installed (`codex` binary on PATH or at `/opt/homebrew/bin/codex`).
2. Open the Layman dashboard → **Settings → Client Setup** → click **Install** next to Codex.
3. Layman writes hook scripts to `~/.codex/hooks/layman/`, adds entries to `~/.codex/hooks.json`, and enables the `codex_hooks` feature flag in `~/.codex/config.toml` (required - hooks are disabled by default in Codex).

**Usage:**

1. Start Codex in any project directory:
   ```bash
   codex
   ```

2. Type `@layman` to activate monitoring for the session. Events will appear in the Layman dashboard.

**Notes:**
- Codex's hook system is an under-development feature. The installer enables it automatically via `codex_hooks = true` in `~/.codex/config.toml`. You can also enable it manually with `codex features enable codex_hooks`.
- Codex supports 5 hook events: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`. Features that require `PermissionRequest` or subagent hooks are not available.
- Tool approval/denial from the Layman UI is supported for `PreToolUse` events.
- Prompt submission from the Layman UI is not yet supported for Codex sessions.
- The hook scripts require `jq` on the host (`/usr/bin/jq` works); a `sed` fallback is used if `jq` is not available.

---

### OpenCode

OpenCode requires a one-time plugin registration before first use.

1. Register the Layman plugin in your OpenCode config (`~/.config/opencode/opencode.json`):

   ```json
   {
     "plugin": [
       "file:///absolute/path/to/layman/packages/opencode-plugin"
     ]
   }
   ```

2. Open the Layman dashboard → **Settings → Client Setup** → click **Install** next to OpenCode to install the `/layman` command for it.

3. Start OpenCode and type `/layman` to activate monitoring for the current session.

You can also send prompts and respond to questions directly from the Layman UI when an OpenCode session is active.

---

### Mistral Vibe

Vibe has no hook or plugin system, so Layman monitors it passively by watching Vibe's session log files.

**No activation step is needed.** When the Layman server is running, any active Vibe session is automatically monitored. Events appear in the dashboard within a few seconds of each turn.

- Layman watches `~/.vibe/logs/session/` for new `JSONL` messages
- Sessions that started within the last 5 minutes are replayed from the beginning
- Sessions idle for more than 15 minutes are treated as ended

The `/layman` skill file is installed to `~/.vibe/skills/layman/` for informational purposes (it tells Vibe that Layman is watching), but invoking it is optional.

---

### Cline (VS Code / IntelliJ)

Cline uses shell-script hooks that Layman installs to `~/Documents/Cline/Hooks/`. After installation, sessions are **not** monitored by default - you activate per session using the `/layman` workflow.

**Installation** (first time or after a Layman update):

1. Ensure Cline is installed in VS Code or IntelliJ.
2. Open the Layman dashboard → **Settings → Client Setup** → click **Install** next to Cline.
3. Layman writes hook scripts to `~/Documents/Cline/Hooks/` and a workflow file to `~/Documents/Cline/Workflows/layman.md`.

**Activating a session:**

1. Open Cline in VS Code or IntelliJ and start a task.
2. Make sure you are in **Act mode** (not Plan mode) - the activation requires running a shell command.
3. Type `/layman` (or `/layman.md`) in the Cline chat.
4. Cline runs `echo "layman:activate"` and confirms activation.

From that point on, all tool calls in that workspace are monitored. If you switch between Plan and Act modes, monitoring automatically resumes when you return to Act mode - you do not need to run `/layman` again.

**Notes:**
- Tool approval/denial from the Layman UI is supported - Cline will pause and wait up to 25 seconds for your decision before auto-allowing.
- Prompt submission from the Layman UI is not supported (Cline has no inbound HTTP API).
- Agent responses are captured when Cline uses `attempt_completion`; purely conversational inline replies may not appear.

---

## Adding a new AI client

If you install a supported client after Layman is already running:

1. Install the client as normal.
2. Open the Layman dashboard at http://localhost:8880.
3. Go to **Settings** (gear icon) → **Client Setup**.
4. Click **Install** next to the newly detected client - Layman writes its hooks and commands.

No container restart required.

---

## Stopping Layman

```bash
# macOS / Linux
docker compose -f ~/layman/docker-compose.yml down
```

```powershell
# Windows (PowerShell)
docker compose -f "$env:USERPROFILE\layman\docker-compose.yml" down
```

If you used `make start`, you can also run `make stop`.

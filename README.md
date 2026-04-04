# Layman

"*Catch vibes.*"

* Monitor your AI assistants
* Explain their actions in Layman's Terms
* Analyze for risk, security, and safety automatically
* Record and Bookmark sessions including user prompts and agent responses
  * Opt-in required (per session)
  * PII filtered by default

When AI coding assistants like Claude Code, Codex, OpenCode, Mistral Vibe, or Cline help you build software, they do it by reading your files, writing code, and performing dozens of actions per session.

Layman is a dashboard that explains exactly what your AI assistants are doing, in plain language, in your web browser. Understand and remember every file AI reads, every change AI makes, every command AI runs.

---

### Supported Agents
- [Claude Code](https://github.com/anthropics/claude-code)
- OpenAI [Codex](https://github.com/openai/codex)
- Mistral [Vibe](https://github.com/mistralai/mistral-vibe)
- [OpenCode](https://github.com/anomalyco/opencode)
- [Cline](https://github.com/cline/cline)

---

## Screenshots

<img width="1280" height="939" alt="Screenshot 2026-03-21 at 22-50-36 Layman" src="https://github.com/user-attachments/assets/c286b021-1ecc-4ab3-9043-d47a28d11c93" />

<img width="1280" height="939" alt="Screenshot 2026-03-22 at 05-05-05 Layman" src="https://github.com/user-attachments/assets/48800a9c-d790-4265-a615-5947744f014f" />

---

## Features

### Tool approval

For Claude Code and Cline, Layman can intercept tool calls before they execute and ask for your approval. Enable this in **Settings → Auto-approve** to control which tools require a human decision.

### AI analysis (optional)

Layman can use an AI model to explain what each action means and flag anything that looks risky. Add your API key when starting the container:

```bash
ANTHROPIC_API_KEY=your-key-here docker compose -f ~/layman/docker-compose.yml up -d
```

Supports Anthropic, OpenAI-compatible APIs, and LiteLLM.

### Session metrics

When connected to Claude Code, the dashboard shows a live metrics bar with model name, context window usage, cumulative session cost, token counts, lines changed, and rate limit warnings. This data comes from claude-code's StatusLine channel — a relay script installed alongside the hooks.

Past sessions are recorded to a local SQLite database. Open the **Sessions** panel (clock icon) to browse history, search across all sessions with full-text search, and filter by event type. Search supports `+required`, `-excluded`, and `"quoted phrases"`.

### PII filter

All logged events are automatically scanned for personally identifiable information (email addresses, API keys, passwords, credit card numbers, etc.) and redacted before storage. Toggle in **Settings → Session Recording → PII Filter**.

### Session export

Export a session as a PDF transcript using the print button in the session view.

---

## Setup

**Start the Layman server** (one instance handles all your projects):

```bash
docker compose -f ~/layman/docker-compose.yml up -d
```

**Open the dashboard:**

http://localhost:8880

On first visit, a modal lists every AI agent client detected on your system. Toggle on the clients you want to integrate, then click **Accept**. Layman writes hooks and slash commands only for the clients you selected. Clients you leave off are remembered and won't be offered again — you can install them any time from **Settings → Client Setup**.

After a Layman update, a banner appears if your hooks or commands are out of date. Click **Update** to refresh them.

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

You can activate multiple sessions across different projects — they all appear in the same dashboard.

**Auto-activate:** To skip the `/layman` step, go to **Settings → Client Setup** and toggle **Auto-activate sessions** on the Claude Code row. All new Claude Code sessions will be monitored automatically.

---

### Codex

Codex uses shell-script hooks that Layman installs to `~/.codex/hooks/layman/` and registers in `~/.codex/hooks.json`. Sessions are activated per-session by typing `@layman` in Codex.

**Installation** (first time or after a Layman update):

1. Ensure Codex is installed (`codex` binary on PATH or at `/opt/homebrew/bin/codex`).
2. Open the Layman dashboard → **Settings → Client Setup** → click **Install** next to Codex.
3. Layman writes hook scripts to `~/.codex/hooks/layman/`, adds entries to `~/.codex/hooks.json`, and enables the `codex_hooks` feature flag in `~/.codex/config.toml` (required — hooks are disabled by default in Codex).

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

- Layman watches `~/.vibe/logs/session/` for new JSONL messages
- Sessions that started within the last 5 minutes are replayed from the beginning
- Sessions idle for more than 15 minutes are treated as ended

The `/layman` skill file is installed to `~/.vibe/skills/layman/` for informational purposes (it tells Vibe that Layman is watching), but invoking it is optional.

---

### Cline (VS Code / IntelliJ)

Cline uses shell-script hooks that Layman installs to `~/Documents/Cline/Hooks/`. After installation, sessions are **not** monitored by default — you activate per session using the `/layman` workflow.

**Installation** (first time or after a Layman update):

1. Ensure Cline is installed in VS Code or IntelliJ.
2. Open the Layman dashboard → **Settings → Client Setup** → click **Install** next to Cline.
3. Layman writes hook scripts to `~/Documents/Cline/Hooks/` and a workflow file to `~/Documents/Cline/Workflows/layman.md`.

**Activating a session:**

1. Open Cline in VS Code or IntelliJ and start a task.
2. Make sure you are in **Act mode** (not Plan mode) — the activation requires running a shell command.
3. Type `/layman` (or `/layman.md`) in the Cline chat.
4. Cline runs `echo "layman:activate"` and confirms activation.

From that point on, all tool calls in that workspace are monitored. If you switch between Plan and Act modes, monitoring automatically resumes when you return to Act mode — you do not need to run `/layman` again.

**Notes:**
- Tool approval/denial from the Layman UI is supported — Cline will pause and wait up to 25 seconds for your decision before auto-allowing.
- Prompt submission from the Layman UI is not supported (Cline has no inbound HTTP API).
- Agent responses are captured when Cline uses `attempt_completion`; purely conversational inline replies may not appear.

---

## Adding a new AI client

If you install a supported client after Layman is already running:

1. Install the client as normal.
2. Open the Layman dashboard at http://localhost:8880.
3. Go to **Settings** (gear icon) → **Client Setup**.
4. Click **Install** next to the newly detected client — Layman writes its hooks and commands.

No container restart required.

---

## Stopping Layman

```bash
docker compose -f ~/layman/docker-compose.yml down
```

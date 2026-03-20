# Layman

When AI coding assistants like Claude Code or OpenCode help you build software, they do it by reading your files, writing code, and running commands on your computer — often dozens of actions per session, faster than any person could follow.

Layman is a dashboard that shows you exactly what your AI assistant is doing, in plain language, in your web browser. Think of it like a window into what the AI is actually doing on your machine: every file it reads, every change it makes, every command it runs.

---

## Setup

**Start the Layman server** (one instance handles all your projects):

```bash
docker compose -f ~/layman/docker-compose.yml up -d
```

**Open the dashboard:**

http://localhost:8880

On first visit, a banner prompts you to click **Install**. This writes the global hooks and `/layman` slash command into `~/.claude/` so Claude Code can report to the dashboard. It also installs the `/layman` command for any other supported clients it detects (e.g. OpenCode). You only need to do this once — or again after a Layman update.

---

## Usage

### Claude Code

Sessions are **not** monitored by default. To opt a session in:

1. Start Claude Code in any project directory:
   ```bash
   claude
   ```

2. Type `/layman` inside the Claude Code session.

3. Claude runs a curl command to activate the session. From that point on, all events flow to the dashboard.

You can activate multiple sessions across different projects — they all appear in the same dashboard.

### OpenCode

1. Register the Layman plugin in your OpenCode config (`~/.config/opencode/opencode.json`):

   ```json
   {
     "plugin": [
       "file:///absolute/path/to/layman/packages/opencode-plugin"
     ]
   }
   ```

2. Open the Layman dashboard, go to **Settings → Client Setup**, and click **Reinstall** so Layman detects OpenCode and installs the `/layman` command for it.

3. Start OpenCode and type `/layman` to activate monitoring.

---

## Adding a new AI client

If you install a new supported AI client after Layman is already running:

1. Install the client as normal.
2. Open the Layman dashboard at http://localhost:8880.
3. Go to **Settings** (gear icon) → **Client Setup**.
4. Click **Reinstall** — Layman will detect the new client and install the `/layman` command for it.

No container restart required.

---

## AI analysis (optional)

Layman can use an AI model to explain what each action means and flag anything that looks risky. Add your API key when starting the container:

```bash
ANTHROPIC_API_KEY=your-key-here docker compose -f ~/layman/docker-compose.yml up -d
```

---

## Stopping Layman

```bash
docker compose -f ~/layman/docker-compose.yml down
```

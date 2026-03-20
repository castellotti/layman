# Layman

When AI coding assistants like Claude Code or OpenCode help you build software, they do it by reading your files, writing code, and running commands on your computer — often dozens of actions per session, faster than any person could follow.

Layman is a dashboard that shows you exactly what your AI assistant is doing, in plain language, in your web browser. Think of it like a window into what the AI is actually doing on your machine: every file it reads, every change it makes, every command it runs.

---

## Setup

**Clone Layman once** to a permanent location on your machine:

```bash
git clone https://github.com/castellotti/layman.git ~/layman
```

**Start the Layman server** (one instance for all your projects):

```bash
docker compose -f ~/layman/docker-compose.yml up -d
```

**Open the dashboard:**

http://localhost:8090

On first visit, the dashboard shows a setup banner. Click **Install** to write the global hooks and `/layman` slash command into `~/.claude/`. This only needs to be done once (or after a Layman update).

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

2. Start OpenCode and type `/layman` to activate monitoring.

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

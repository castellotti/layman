# Layman

When AI coding assistants like Claude Code or OpenCode help you build software, they do it by reading your files, writing code, and running commands on your computer — often dozens of actions per session, faster than any person could follow.

Layman is a dashboard that shows you exactly what your AI assistant is doing, in plain language, in your web browser. Think of it like a window into what the AI is actually doing on your machine: every file it reads, every change it makes, every command it runs.

---

## Setup

**Clone Layman once** to a permanent location on your machine:

```bash
git clone https://github.com/castellotti/layman.git ~/layman
```

---

## Claude Code

**1. Go to your project directory and start Layman:**

```bash
cd ~/my-project
docker compose -f ~/layman/docker-compose.yml up -d
```

Layman automatically configures Claude Code to report its activity. No other setup needed.

**2. Open the dashboard:**

http://localhost:8090

**3. Start Claude Code as normal:**

```bash
claude
```

Everything Claude does will appear in your browser as it happens.

**To stop Layman:**

```bash
docker compose -f ~/layman/docker-compose.yml down
```

---

## OpenCode

Complete the Claude Code setup above first, then:

**1. Register the Layman plugin** in your OpenCode config.

For global use, edit `~/.config/opencode/opencode.json` (create it if it doesn't exist):

```json
{
  "plugin": [
    "file:///absolute/path/to/layman/packages/opencode-plugin"
  ]
}
```

Replace `/absolute/path/to/layman` with wherever you cloned the repo (e.g. `file:///Users/you/layman/packages/opencode-plugin`). If you already have other plugins listed, add the entry to the existing array.

For a single project only, create `.opencode/opencode.json` in that project instead.

**2. Start OpenCode as normal:**

```bash
opencode
```

OpenCode activity will appear in the same dashboard alongside Claude Code.

---

## AI analysis (optional)

Layman can use an AI model to explain what each action means and flag anything that looks risky. Add your API key to the docker compose command:

```bash
ANTHROPIC_API_KEY=your-key-here docker compose -f ~/layman/docker-compose.yml up -d
```

---

## Monitoring multiple projects

Layman watches one project at a time by default — whichever directory you ran `docker compose` from. To switch projects, stop and restart from the new directory:

```bash
docker compose -f ~/layman/docker-compose.yml down
cd ~/other-project
docker compose -f ~/layman/docker-compose.yml up -d
```

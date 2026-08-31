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

Note that your **project directories are not mounted**. The container can reach `~/.claude` but not `<your-project>/.claude`, which is why the repair command below runs on the host rather than through the web UI.

## Troubleshooting: every event recorded twice

If sessions show each prompt, tool call, and response twice, you likely have Layman hooks in a project-level settings file as well as the global one. Claude Code merges `<project>/.claude/settings.local.json` **on top of** `~/.claude/settings.json`, so both copies fire.

This affects installs that predate Layman moving to a global-only install; the project-level file was left behind and nothing has cleaned it up since.

Check and fix from the project directory, on the host (not inside the container):

```bash
layman repair-hooks --dry-run   # report what would be removed
layman repair-hooks             # remove them
```

The repair only removes hook entries that match Layman's own URL shape (`{origin}/hooks/{EventName}`). Your `permissions` and any other settings are written back untouched, hooks belonging to other tools are preserved - including ones sharing a matcher with a Layman hook - and the settings file is never deleted. Pass a directory to check a different project: `layman repair-hooks ~/code/other-project`.

Recent Layman versions also prevent this from recurring: installing hooks now replaces any existing Layman hooks regardless of the URL they point at, so changing the port or `--hook-url` no longer appends a second set.

Already-recorded duplicate events stay in the database; the fix stops new ones. You should not see the effects of the old ones any more: Layman treats two identical prompts recorded within a second of each other as one prompt when it builds a session's turns, so historical sessions no longer show empty duplicate exchanges that appear to have stolen the previous answer. A genuine re-send of the same text - typing it again a minute later - is still two separate turns.

## Sharing a link to a session, a turn, or an event

Every session, turn, event and highlight has its own URL, and the link buttons next to them copy it:

```
http://localhost:8880/s/{sessionId}                        a session transcript
http://localhost:8880/s/{sessionId}/t/{promptEventId}       one prompt and its answer
http://localhost:8880/s/{sessionId}/e/{eventId}             one event
http://localhost:8880/h/{highlightId}                       a saved highlight
```

Opening one restores that exact view. Add `?view=logs` (or `dashboard`, `prompts`, `flow`, `sessions`) to open it in a different surface. Ids can be shortened to any unambiguous prefix of 8 or more characters, which keeps links readable when you paste them into notes.

If a link opens on **"Not found on this instance"**, the id is not in this Layman's database. Usually that means the link came from a different machine, or the session was deleted or purged here. The panel names the instance it checked and offers a search box so you can look for the session by name or content.

Links are built from the `publicUrl` setting when you set one, and otherwise from whatever address you are browsing. Set `publicUrl` in `~/.local/share/layman/layman.json` if you want copied links to use a hostname other people can reach - otherwise a link copied from `localhost` only works on your own machine.

## Reading responses aloud (optional)

Layman can speak the agent's replies through [speaches](https://github.com/speaches-ai/speaches), a
local text-to-speech server. Nothing is sent to a cloud service and no audio is stored.

**1. Start speaches and download a voice model.** Models are not bundled, and until one is installed
nothing can speak:

```bash
git clone https://github.com/speaches-ai/speaches && cd speaches
docker compose -f compose.cpu.yaml up -d
curl -X POST http://localhost:8000/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

**2. Turn it on** in Layman under **Settings → Data → Text to speech**, then click **Test
connection**. On success it reports the synthesis time; on failure it shows what speaches said.

You then get a speaker button on every turn, every agent response and every highlight. **Auto-speak**
reads replies as they arrive: *Final only* waits for a two-second pause so you hear the answer rather
than every progress message, and *Every message* reads all of them in order. Speech never overlaps -
it queues, and the status bar shows what is playing with skip, stop and mute.

**Speed vs playback rate.** These are different knobs. *Speed* is applied by speaches and changes
tempo while keeping the voice sounding the same. *Playback rate* is applied afterwards in the
browser, and if you also turn off *Preserve pitch* it raises the pitch too - the sped-up-tape sound.

### If speech does not work

| Symptom | Cause |
|---|---|
| **"Enable audio" appears in the status bar** | Not a fault. Browsers refuse to play audio until you have clicked something on the page. Click it once and the queued response plays; it will not ask again for that tab. This is common when you open a `?play=1` link in a new tab. |
| **Speaker buttons are missing** | Speech is off. Settings → Data → Text to speech → Enable speech. |
| **"speaches has no models installed"** | Run the `curl -X POST …/v1/models/…` command above. |
| **Test connection fails with a connection error** | speaches is not running, or not on port 8000. Check with `curl http://localhost:8000/v1/models`. |
| **Nothing happens for 30-60 seconds after clicking a speaker** | A long reply is several minutes of audio and takes real time to synthesise. The status bar shows `◌` while it works. Lower *Max characters* if you want it to start sooner. |
| **"Speed must be between 0.5 and 2.0"** | Only reachable by hand-editing `~/.local/share/layman/layman.json`; the slider is already limited to what speaches accepts. |

If Layman runs in Docker and speaches runs on your machine, leave the endpoint as
`http://localhost:8000` - Layman rewrites it to reach the host automatically.

### Sharing a link that speaks itself

Add `?play=1` to a turn link and it reads the answer aloud on arrival:

```
http://localhost:8880/s/{sessionId}/t/{promptEventId}?play=1
```

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

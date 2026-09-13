# Mistral Vibe

Vibe has no hook or plugin system, so Layman monitors it passively by watching Vibe's session log files.

**No activation step is needed.** When the Layman server is running, any active Vibe session is automatically monitored. Events appear in the dashboard within a few seconds of each turn.

## How it works

- Layman watches `~/.vibe/logs/session/` for new `JSONL` messages.
- Sessions that started within the last 5 minutes are replayed from the beginning.
- Sessions idle for more than 15 minutes are treated as ended.
- Early detection: a placeholder session is created as soon as a `vibe` process is detected, before you type anything.
- **Past sessions can be backfilled** from **Settings → Data → Import session history**, which parses every discoverable `messages.jsonl` (native and, when enabled, glove-sandboxed) that wasn't already recorded live.

The `/layman` skill file is installed to `~/.vibe/skills/layman/` for informational purposes (it tells Vibe that Layman is watching), but invoking it is optional.

## Limitations

- Monitoring is passive - tool approval and prompt submission from the Layman UI are not available.

## Architecture & implementation notes

> Moved here from the root `CLAUDE.md` to keep it under its size limit.

The watcher (`packages/server/src/vibe/watcher.ts`) polls `<root>/<dir>/messages.jsonl` every 2
seconds from a tracked byte offset. It translates Vibe's JSONL message format to Layman events.
Sessions require `/layman` activation; sessions idle for 15+ minutes are treated as ended. Sessions
within a 5-minute replay window are read from the beginning. The watch roots are not hardcoded — they
come from a list of `MonitorSource`s (see the root `CLAUDE.md` "Monitor sources" note and
`docs/extensions/glove.md`), re-queried on every scan tick, so several roots are watched at once and
each session inherits its root's agent type and optional sandbox label.

- **Vibe session end detection.** Vibe sets `end_time` on every `save_interaction()` call (not just
  on close), so `end_time` is not a reliable signal. Sessions are instead considered ended after 15
  minutes of log file inactivity.

- **The 1-hour "recent enough to track" gate keys off log activity, not `start_time`.** A native
  `vibe` launch mints a fresh session directory per run, so its `start_time` tracks liveness — but
  glove reuses one persistent env home (`~/.glove/envs/<env-id>/home/`) across `glove vibe`
  invocations, freezing `start_time` at the env's first launch while the same session keeps producing
  turns. `tryAddSession()` therefore admits a session whose `messages.jsonl` was written within the
  last hour even if its `start_time` is days old; without that, an actively-used but long-lived gloved
  Vibe session is silently never tracked. It still tails from EOF (the 5-minute replay window is
  unchanged), so no stale history is replayed live — that is what the history importer is for.

- **History import (`transcript-vibe.ts`).** A whole-file replay of `messages.jsonl` mirroring the
  live watcher's `processMessage()`. Because Vibe messages carry no per-message timestamp, the
  importer reads each session's span from `meta.json` at discovery and spreads events across it so an
  imported session sorts onto the day it ran. Registered in `recovery.ts`'s `TRANSCRIPT_SOURCES`;
  glove roots flow through `discoverGloveVibeSessions()`. A session already recorded live
  (`source === 'live'`) is skipped, so importing never duplicates a watched session.

# Mistral Vibe

Vibe has no hook or plugin system, so Layman monitors it passively by watching Vibe's session log files.

**No activation step is needed.** When the Layman server is running, any active Vibe session is automatically monitored. Events appear in the dashboard within a few seconds of each turn.

## How it works

- Layman watches `~/.vibe/logs/session/` for new `JSONL` messages.
- Sessions that started within the last 5 minutes are replayed from the beginning.
- Sessions idle for more than 15 minutes are treated as ended.
- Early detection: a placeholder session is created as soon as a `vibe` process is detected, before you type anything.

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

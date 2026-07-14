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

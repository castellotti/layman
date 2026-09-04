# Codex

Codex uses shell-script hooks that Layman installs to `~/.codex/hooks/layman/` and registers in `~/.codex/hooks.json`. Sessions are activated per-session by typing `$layman` in Codex.

## Installation

First time or after a Layman update:

1. Ensure Codex is installed (`codex` binary on PATH or at `/opt/homebrew/bin/codex`).
2. Open the Layman dashboard -> **Settings -> Harness** -> click **Install** next to Codex.
3. Layman writes hook scripts to `~/.codex/hooks/layman/`, adds entries to `~/.codex/hooks.json`, and enables the `codex_hooks` feature flag in `~/.codex/config.toml` (required - hooks are disabled by default in Codex).

## Usage

1. Start Codex in any project directory:
   ```bash
   codex
   ```
2. Type `$layman` to activate monitoring for the session. Events will appear in the Layman dashboard.

## Notes

- Codex's hook system is an under-development feature. The installer enables it automatically via `codex_hooks = true` in `~/.codex/config.toml`. You can also enable it manually with `codex features enable codex_hooks`.
- Codex supports 5 hook events: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, and `Stop`. Features that require `PermissionRequest` or subagent hooks are not available.
- Tool approval/denial from the Layman UI is supported for `PreToolUse` events.
- Prompt submission from the Layman UI is not yet supported for Codex sessions.
- The hook scripts require `jq` on the host (`/usr/bin/jq` works); a `sed` fallback is used if `jq` is not available.

## Architecture & implementation notes

> Moved here from the root `CLAUDE.md` to keep it under its size limit.

Codex reads hook config from `~/.codex/hooks.json` and runs shell scripts from
`~/.codex/hooks/layman/` (`packages/server/hooks/codex/`). These scripts read hook JSON from stdin,
inject `agent_type: "codex"`, and POST to the existing `/hooks/:eventName` handler via curl. The hook
format is Claude Code-compatible — same field names and event names — so no separate handler is
needed. `PreToolUse` blocks for up to 58 seconds. The `Stop` hook payload includes
`last_assistant_message` which the handler uses to emit the agent's final response. Sessions activate
when the user types `@layman` — detected via `UserPromptSubmit` hook before the gate check. Codex
supports 5 hook events: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`.
Async hooks are not supported by Codex.

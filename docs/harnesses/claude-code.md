# Claude Code

Full hook coverage (26 event types), StatusLine metrics relay, and tool approval from the Layman UI.

Hooks are installed to `~/.claude` by the setup wizard or **Settings -> Harness -> Install**.

## Activating a session

Sessions are **not** recorded by default. To opt a session in:

1. Start Claude Code in any project directory:
   ```bash
   claude
   ```
2. Type `/layman` inside the Claude Code session.
3. Claude runs an activation command. From that point on, all events flow to the dashboard.

You can activate multiple sessions across different projects - they all appear in the same dashboard.

**Auto-activate:** To skip the `/layman` step, go to **Settings -> Harness** and toggle **Auto-activate sessions** on the Claude Code row. All new Claude Code sessions will be monitored automatically.

## Capabilities

- Tool approval/denial from the Layman UI, including blocking `PreToolUse` and `PermissionRequest` hooks that suspend the agent until you decide.
- Live session metrics via the StatusLine relay: model, context %, cost, tokens, rate limits.
- Historical import: past sessions can be imported from JSONL transcripts in `~/.claude/projects/` - see **Settings -> Data** ([details](../features.md#historical-session-import)).

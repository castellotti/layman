# Cline (VS Code / IntelliJ)

Cline uses shell-script hooks that Layman installs to `~/Documents/Cline/Hooks/`. After installation, sessions are **not** monitored by default - you activate per session using the `/layman` workflow.

## Installation

First time or after a Layman update:

1. Ensure Cline is installed in VS Code or IntelliJ.
2. Open the Layman dashboard -> **Settings -> Harness** -> click **Install** next to Cline.
3. Layman writes hook scripts to `~/Documents/Cline/Hooks/` and a workflow file to `~/Documents/Cline/Workflows/layman.md`.

## Activating a session

1. Open Cline in VS Code or IntelliJ and start a task.
2. Make sure you are in **Act mode** (not Plan mode) - the activation requires running a shell command.
3. Type `/layman` (or `/layman.md`) in the Cline chat.
4. Cline runs `echo "layman:activate"` and confirms activation.

From that point on, all tool calls in that workspace are monitored. If you switch between Plan and Act modes, monitoring automatically resumes when you return to Act mode - you do not need to run `/layman` again.

## Notes

- Tool approval/denial from the Layman UI is supported - Cline will pause and wait up to 25 seconds for your decision before auto-allowing.
- Prompt submission from the Layman UI is not supported (Cline has no inbound HTTP API).
- Agent responses are captured when Cline uses `attempt_completion`; purely conversational inline replies may not appear.

## Architecture & implementation notes

> Moved here from the root `CLAUDE.md` to keep it under its size limit.

Cline runs bash scripts from `~/Documents/Cline/Hooks/` that pipe JSON stdin to
`POST /hooks/cline/:hookName`. The Cline handler (`packages/server/src/cline/handler.ts`) translates
Cline's field/tool-name format to Layman's internal types via a translator (`translator.ts`), then
reuses the same event pipeline. `PreToolUse` blocks for up to 25 seconds (Cline's hardcoded limit is
30s). Sessions require `/layman` activation, tracked by workspace directory (cwd) so activation
survives Plan/Act mode switches.

- **Cline cwd-keyed activation.** Cline may change its `taskId` when switching Plan/Act modes while
  keeping the same workspace. Layman tracks activated workspace directories (`activatedCwds` Set in
  `cline/handler.ts`) so new taskIds in an already-activated workspace auto-activate without requiring
  `/layman` again.
- **Cline agent responses.** Cline routes all final AI responses through the `attempt_completion`
  tool. Layman captures the `result` parameter from `PostToolUse(attempt_completion)` and emits it as
  an `agent_response` event.

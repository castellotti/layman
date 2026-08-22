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

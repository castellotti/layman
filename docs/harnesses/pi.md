# pi

[pi](https://pi.dev) is integrated through a TypeScript **extension** rather than shell hooks:
pi auto-discovers `~/.pi/agent/extensions/*/index.ts` and loads it with jiti, so there is no
config file to edit and no build step. The one thing to know up front: pi is the only harness
where Layman does **not** ask you to approve tool calls by default — pi's design position is that
a coding agent should not impose permission popups, so blocking is a toggle you turn on.

## Installation

1. Ensure pi has been run at least once, so `~/.pi/agent/` exists.
2. Open the Layman dashboard -> **Settings -> Harness** -> click **Install** next to **pi**.
   Layman writes a single file, `~/.pi/agent/extensions/layman/index.ts`, with your Layman URL
   and approval timeout baked in.
3. Restart pi (or run `/reload`) so it picks the extension up.

Reinstall after a Layman update — the row shows **Update** when the installed extension is stale,
which includes when you change Layman's URL or hook timeout, since both are compiled into the file.
**Uninstall** deletes that one file and nothing else.

## Activating a session

Type `/layman` in pi. You should see *"Layman is now monitoring this session"* and the session
appears in the dashboard immediately.

Unlike the other harnesses, `/layman` does **not** show up in the transcript: pi dispatches
extension commands before the prompt reaches the model, so it never becomes a turn.

To skip the step entirely, turn on **Auto-activate sessions** on the pi row in
**Settings -> Harness**.

## Capabilities

- **Live token streaming**, the highest fidelity of any supported harness. Response text and
  reasoning stream to the dashboard separately as they are generated, because pi separates them
  at the protocol level — no `<thinking>`-tag parsing is involved.
- **Reasoning captured separately** from the response on committed turns, for the same reason.
- **Tool approval from the Layman UI**, off by default. Turn on *"Require approval for tool calls"*
  on the pi row to have Layman suspend pi until you Approve or Deny; a Deny reason is shown in pi.
  Takes effect on the next tool call — no pi restart needed. Pressing Esc in pi cancels a pending
  approval cleanly.
- **Prompt submission from the Layman UI**, delivered when pi is next idle.
- **Session metrics**: model, cumulative tokens, context-window fill, and the current reasoning
  level. Cost is shown only when it is non-zero, so a locally hosted model does not display a
  permanent `$0.00`.
- **Compaction, model changes and reasoning-level changes** are all recorded.

## Limitations

- **No sub-agents.** pi has none by design, so `subagent_start` / `subagent_stop` events never
  fire and anything built on them is empty for pi sessions.
- **No pre-activation history.** Layman only parses claude-code's transcript format, so events
  from before `/layman` are not recovered. Importing pi's session JSONL is a separate feature.
- **Killing pi with Ctrl+C may not end the session immediately.** pi does not always run its
  shutdown handler on an abrupt signal. A stale live-generation row is swept within about a minute.
- **`PermissionRequest` has no pi equivalent.** Tool approval goes through `tool_call` only.

## Notes

- Requires pi 0.84.2 or later.
- If Layman is stopped or unreachable, pi keeps working normally — every call is fire-and-forget
  with a timeout, and nothing is recorded until Layman returns.
- Design rationale, including why this is an extension rather than shell hooks and why approvals
  are opt-in, is in `docs/plans/plan-pi-harness-support.md`.

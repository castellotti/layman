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

## Architecture & implementation notes

> Moved here from the root `CLAUDE.md` to keep it under its size limit. This is the mechanism and
> the design rationale, not usage — the sections above are what a user needs.

### Hooks

Claude Code fires HTTP POSTs to `/hooks/:eventName`. Layman registers for 26 claude-code hook
events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`,
`SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`,
`StopFailure`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `Setup`,
`ConfigChange`, `InstructionsLoaded`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`,
`WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged`. (`PermissionDenied` requires
claude-code ≥ 2.1.89 and is not yet registered.) The hook handler in
`packages/server/src/hooks/handler.ts` processes each event type, calls `EventStore.add()`, and for
blocking hooks (`PreToolUse`, `PermissionRequest`) calls `PendingApprovalManager.createAndWait()`
which suspends until the user decides. Claude Code's blocking-hook timeout is 300s (configurable).

### StatusLine

A separate data channel from hooks. Layman installs a relay script
(`~/.claude/hooks/layman/statusline.sh`) that receives JSON on stdin after every assistant turn
(debounced 300ms by claude-code) and POSTs it to `/hooks/StatusLine`. This carries session metrics
unavailable through hooks: cumulative cost, token counts, context window fill %, rate limits, model
info, and lines changed. The handler creates `session_metrics` events which are stored in a
dedicated per-session map (not the timeline) and displayed in the `SessionMetricsBar` component. If
the user has an existing `statusLine` command, the relay script chains to it (preserving their
status bar text).

- **`session_metrics` events fire after every assistant turn (high frequency).** They are routed to
  a dedicated `sessionMetrics: Map<sessionId, SessionMetrics>` in the Zustand store rather than the
  timeline events array, to avoid flooding the timeline. The `SessionMetricsBar` component reads
  this map.
- **StatusLine is a single slot.** Claude-code's `statusLine` config accepts exactly one command. If
  the user already has a custom statusLine, the installer composes by setting
  `LAYMAN_ORIGINAL_STATUSLINE` in the relay script and piping input to both. Uninstall restores the
  original command.
- **A partial `StatusLine` payload blanks the metrics bar.** `handleStatusLine` builds a
  `session_metrics` event from whatever arrives and the client *replaces* its map entry rather than
  merging, so posting one field clears every other. (pi's `session_info_changed` therefore sends the
  whole payload with the name substituted — see `pi.md`.) Any future partial-update source needs the
  same treatment or a merging store.

### Hook installation & identity

- **Hook identity is structural, not tagged.** `buildLaymanHooks()` writes `_layman: true`, but
  claude-code strips unknown keys when it rewrites `settings.json`, so the tag does not survive and
  cannot be relied on. `isLaymanHook()` therefore matches on URL *shape* — any
  `{origin}/hooks/{KnownLaymanEvent}` — rather than on the tag or on the configured `serverUrl`. This
  matters because matching `serverUrl` alone meant that any URL change (port, `--hook-url`,
  `localhost` vs `host.docker.internal`) stopped matching the old entries and **appended a duplicate
  hook set**, causing every event to fire twice. Structural matching makes `install()` idempotent and
  self-healing across URL changes.
- **Hook removal filters within matchers.** `stripLaymanHooks()` removes individual hook entries
  rather than dropping whole matcher objects, so a matcher holding both a Layman hook and a user's
  own hook does not take the user's hook down with it.
- **Project-level hooks are orphans.** Layman has installed globally (`~/.claude/settings.json`) since
  the multi-project change; claude-code merges any project-level `.claude/settings.local.json` hooks
  *on top of* the global set, so leftovers from before that change double every event.
  `findOrphanedProjectHooks()` / `repairOrphanedProjectHooks()` detect and remove them, scoped
  strictly to a named directory. Exposed as **`layman repair-hooks [dir] [--dry-run]`** — a CLI
  command rather than an HTTP route, because the Docker container mounts only `~/.claude` and friends
  and cannot see a project's `.claude` directory. The `GET /api/setup/orphaned-hooks` /
  `POST /api/setup/repair-hooks` routes exist for native (non-Docker) installs and are restricted to
  directories Layman is actively tracking.

### History recovery

- **A transcript is identified by the session id in its contents, not its filename**
  (`recovery.ts`, `TranscriptSource.resolveSessionId`). Claude Code writes a resume/fork transcript
  as `<new-uuid>.jsonl` but stamps every line with the *original* `sessionId`. Keying by filename
  minted a phantom session whose deterministic event ids all collided (`INSERT OR IGNORE`) with the
  original that already owned them — a 0-event row whose `MAX(timestamp)` was 0, so every subsequent
  scan re-parsed the whole file and "enriched" the same colliding events forever (reported as
  `enriched N` with 0 discovered, in a loop). `importHistoricalSessions()` now resolves each file's
  session id from its lines (`resolveSessionId`, implemented for claude-code, absent for pi whose
  filenames already match), so a resume file resolves to its real session and is skipped by the same
  `parseAfter` cutoff / live-skip that protects any already-recorded session. Two consequences worth
  keeping: the pre-loop `existingSessions` snapshot is updated after a discover so a same-scan sibling
  file (the resume and its original both present) enriches rather than re-imports; and a one-time
  `DELETE` at the start of each scan removes existing 0-event `imported` phantoms (reported as
  `removedPhantoms`) — safe because `importSession()` returns early on empty input, so a 0-event
  `imported` row can only be such a phantom.

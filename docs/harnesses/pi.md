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
- **No live pre-activation recovery.** Running `/layman` mid-session does not backfill everything
  said before it, the way claude-code's transcript-path recovery does - pi sends no
  `transcript_path` in its hook payloads (deliberately; see the root `CLAUDE.md`). Past sessions
  can still be recovered after the fact through **Settings -> Data -> Import session history**,
  which reads pi's own session JSONL directly.
- **Killing pi with Ctrl+C may not end the session immediately.** pi does not always run its
  shutdown handler on an abrupt signal. A stale live-generation row is swept within about a minute.
  Quitting normally closes the row at once, from the server side.
- **`PermissionRequest` has no pi equivalent.** Tool approval goes through `tool_call` only.
- **Drift reminders appear in pi's notification area, not in the agent's context.** At amber level
  Layman returns the reminder alongside its allow decision, and the extension shows it to you. pi
  gives an extension no way to inject text into the model's context on an allowed tool call, so
  unlike claude-code the agent itself does not see it.

## Historical session import

**Settings -> Data -> Import session history** discovers pi sessions from `~/.pi/agent/sessions/`
alongside Claude Code's and imports the ones Layman never monitored live. pi's files are
format-version-3 JSONL trees rather than a flat log - branching in place on `/fork` instead of
starting a new file - so import walks from the latest-timestamp leaf back to the root and imports
only that path, leaving abandoned branches out. A session already recorded live is enriched rather
than duplicated. Files from an unmigrated pre-v3 session (pi migrates on load, so this only happens
if pi hasn't opened the file since upgrading) are skipped rather than guessed at.

## Notes

- Requires pi 0.84.2 or later.
- If Layman is stopped or unreachable, pi keeps working normally — every call is fire-and-forget
  with a timeout, and nothing is recorded until Layman returns.
- Design rationale, including why this is an extension rather than shell hooks and why approvals
  are opt-in, is in the "Architecture & implementation notes" section below.

## Architecture & implementation notes

> Moved here from the root `CLAUDE.md` to keep it under its size limit. pi is the richest and most
> subtle source Layman has; most of these notes exist because getting one of them wrong fails
> *quietly*.

### The extension (`packages/pi-extension`)

A single TypeScript file that the installer copies verbatim to
`~/.pi/agent/extensions/layman/index.ts`, where pi auto-discovers it and loads it through jiti — no
build step, no `node_modules` beside it. It translates pi's event API to the same `/hooks/:eventName`
payloads every other client posts (`agent_type: "pi"`), so no separate handler is needed. It is
bidirectional: it polls `/api/prompts/pending` and injects via `pi.sendUserMessage()`. It is also the
richest source Layman has — pi separates reasoning from response text at the protocol level, so
`data.thinking` is populated directly, and `message_update` feeds the live token channel. `/layman`
calls `POST /api/activate` directly rather than smuggling an `echo layman:activate` through a bash
tool call, because pi dispatches extension commands before the prompt reaches the model.

- **pi gets a TypeScript extension, not shell hooks.** Codex and Cline get `curl`-in-`bash` scripts
  because that is the only surface those harnesses expose. pi exposes a first-class typed event API
  and explicitly positions itself as "aggressively extensible so it doesn't have to dictate your
  workflow"; writing shell hooks against it would be writing *against* pi rather than with it. The
  extension is deliberately **one file with no imports at all** — not even `import type`. jiti erases
  type imports, so they would work at runtime, but they would also make `pnpm -r typecheck` depend on
  `@earendil-works/pi-coding-agent`, a package this repo has no other reason to install. The pi API
  surface is instead restated structurally at the top of the file. The cost is that pi API drift
  shows up in manual testing rather than at compile time; the benefit is that the installed file has
  no resolution requirements whatsoever. One file (rather than a directory) is what lets it reuse
  `installOptionalClientCommands`' content-hash machinery, which gives install / update-available /
  uninstall detection for free.
- **The pi extension awaits exactly two things.** Everything is fire-and-forget so a dead or slow
  Layman degrades to "pi works, nothing is recorded" rather than a stalled TUI. The exceptions are
  `tool_call`, whose response can block, and `session_shutdown` — where the process exits before an
  un-awaited `fetch` is ever flushed, losing `SessionEnd` entirely. The shutdown post therefore has
  its own much shorter timeout (800 ms): a delayed exit is a worse failure than a missing end event.

### Live streaming

- **pi brackets a live stream on `message_start`/`message_end`, not on `assistantMessageEvent`'s
  `start`/`done`.** Those two variants exist in pi's stream protocol type, which makes them look like
  the obvious choice, but the agent core consumes them to emit the `message_start` and `message_end`
  extension events and does not forward them: subscribing to `message_update` on pi 0.84.2 yields only
  `{thinking,text,toolcall}_{start,delta,end}`. Getting this wrong fails *quietly* — deltas still
  accumulate and text still appears — but the buffer never resets between the several assistant
  messages in one turn and the live row only clears via the 60 s idle sweep.
- **`session_info_changed` sends the whole status-line payload, not a name-only body.** It fires
  shortly after the first turn, just as the metrics bar fills; because `handleStatusLine` *replaces*
  its map entry rather than merging, a name-only body would clear every other field (see
  `claude-code.md`).

### Blocking

- **Tool-call blocking is opt-in for pi, and gated server-side.** pi's documented position is "no
  permission popups — run in a container, or build your own confirmation flow with extensions".
  Blocking pi by default would override that on the user's behalf; offering it as a toggle is a
  faithful reading of the same position. `OPT_IN_BLOCKING_CLIENTS` in `handler.ts` names the harnesses
  this applies to, mirrored by `OPT_IN_APPROVAL_CLIENTS` in `HarnessSection.tsx` so only those grow a
  toggle. The decision is evaluated **per tool call on the server**, not cached and not told to the
  extension at startup, which is what makes flipping the toggle take effect without restarting pi.
  Note the drift monitor's red-level block goes through `PendingApprovalManager` too and is gated by
  the same check — otherwise it would suspend pi through a second door while the approvals toggle read
  "off". (See the "Cannot block is a kind of auto-allow" note in the root `CLAUDE.md` for how orange
  reminders and red blocks are demoted when Layman may not block.)

### Passive watcher (`packages/server/src/pi/watcher.ts`)

Tails pi's format-version-3 JSONL transcripts for glove-sandboxed pi (which cannot reach Layman over
the network) and native pi with no live extension. Unlike Vibe (`<root>/<dir>/messages.jsonl`,
byte-appended), pi writes `<root>/<encoded-cwd>/<ts>_<sessionId>.jsonl` — one level deeper, and a
*tree* re-parsed on each poll via the shared `parsePiTranscript()` rather than a flat log. So it is a
sibling class, not a shared base: a session is a file not a dir, there is no local process to detect
(a gloved pi runs in a container), and incremental emission is by *committed event id*, not byte
offset. It deliberately **never emits a trailing `tool_call_pending`** while tailing — an in-flight
tool becomes `tool_call_completed` once its result lands, and a pending shares its deterministic id
with the completion that replaces it. Emission dedupes on that id (a `Set` per session, not a running
count), so a pending is simply withheld until it completes, and a re-parse that reorders
already-committed events — as parallel tool calls finishing out of order can — can neither duplicate
nor drop one. (Keying by array position would; that was the original approach.) It uses the store's
live path (`add()`, fresh id) exactly as the Vibe watcher does, so a passively-tailed session is a
`live` source and history import won't double-record it.

The reliability patterns are reused verbatim from the Vibe watcher: scan-tick reconciliation
(fs.watch is unreliable on Docker bind mounts, and pi's files sit below the watched root anyway), the
recent/idle windows, replay-from-start for young sessions, and **resurrection of a tombstoned
session** — an idle-timed-out session left in the map with no poll timer is revived by
`cleanupEndedSessions` (via `tryResumeSession`) the moment its transcript grows again, emitting a
`resumed` session_start before catch-up. `scanExistingSessions` skips paths already in the map, so
this is the *only* path back for a resumed session.

- **`NativePiSource` yields no root when the pi extension is installed** (`monitor/sources.ts`).
  Native pi is the one passively-watched harness that *also* has a live integration — the pi
  extension, which records the same session over hooks. If both ran, every native pi turn would be
  recorded twice: the passive path mints fresh ids (like the Vibe watcher), so the `source === 'live'`
  dedupe that protects history import can't collapse two live producers. The guard is structural, not
  a runtime session check: `NativePiSource` looks for the extension file
  (`~/.pi/agent/extensions/layman/index.ts`, Docker `/root/...` first) and returns `[]` when present,
  so the extension owns native pi and the watcher only tails native pi *without* it. Glove pi is
  unaffected — those roots come from `GloveSource` (`docs/extensions/glove.md`), a sandbox never runs
  the host's extension, and a sandboxed pi can't reach Layman over the network anyway, which is the
  whole reason it must be tailed.

The tree-walk import behaviour is covered under "Historical session import" above; glove-sandboxed pi
sessions are importable the same way (see `docs/extensions/glove.md`).

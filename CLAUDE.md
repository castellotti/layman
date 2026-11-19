# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build both packages
pnpm build              # or: make build

# Local development (hot reload, runs both packages in parallel)
pnpm --parallel -r dev  # or: make dev

# Type check
pnpm -r typecheck       # or: make typecheck

# Run tests
pnpm -r test            # or: make test

# Run a single test file
cd packages/server && pnpm test -- src/events/classifier.test.ts

# Container workflow (primary way to run Layman against a real session)
make docker-stop docker-build docker-run   # rebuild and restart
make docker-logs                           # follow container logs
make docker-status                         # check container state
```

These targets drive Docker or Podman: `CONTAINER_ENGINE` auto-detects (Docker preferred when
both are installed, Podman otherwise) and is overridable, e.g. `make docker-run CONTAINER_ENGINE=podman`.
See `docs/development.md` → Container engine.

After any server or web change, you must rebuild the container image for changes to take effect — the container runs from built artifacts, not source.

## Architecture

Layman is a pnpm monorepo with two packages:

- **`packages/server`** — Fastify HTTP + WebSocket server (Node.js, TypeScript, compiled to ESM via tsup)
- **`packages/web`** — React SPA (Vite, Tailwind, Zustand)
- **`web-dist/`** — Vite output; server serves it as static files at `/`

### Supported agents

| Agent | Integration mechanism | Activation |
|---|---|---|
| Claude Code | HTTP hook POSTs to `/hooks/:eventName` + StatusLine relay | `/layman` slash command or auto-activate |
| Codex | Shell-script hooks via `~/.codex/hooks.json` | `@layman` skill |
| OpenCode | Bidirectional plugin (`packages/opencode-plugin`) | `/layman` slash command |
| Mistral Vibe | Passive file watcher on `~/.vibe/logs/session/` | `/layman` slash command |
| Cline | Shell-script hooks in `~/Documents/Cline/Hooks/` | `/layman` workflow in Cline |
| pi | TypeScript extension at `~/.pi/agent/extensions/layman/index.ts` | `/layman` slash command or auto-activate |

Per-harness installation, activation, capabilities, and the architecture/implementation detail are
in **`docs/harnesses/<harness>.md`** (each has an "Architecture & implementation notes" section that
holds the deep detail this file used to carry). The passive **glove** sandbox monitor — a read-only
extension, not a harness — is documented in **`docs/extensions/glove.md`**, and the **Styx** Matrix
views (an extension too, drawing the destinations a session reached) in **`docs/extensions/styx.md`**. Keep harness- and
glove-specific detail in those files; this file keeps only the shared pipeline and cross-cutting
decisions, with pointers.

### How data flows

Each harness reaches Layman by a different mechanism. The summaries below are the shared pipeline;
per-harness event lists, blocking timeouts, and implementation/design notes are in the harness docs
linked above.

1. **Claude Code** (`docs/harnesses/claude-code.md`): HTTP POSTs to `/hooks/:eventName` (24
   registered event types) plus a StatusLine relay for session metrics. The hook handler in
   `packages/server/src/hooks/handler.ts` processes each event, calls `EventStore.add()`, and for
   blocking hooks (`PreToolUse`, `PermissionRequest`) calls `PendingApprovalManager.createAndWait()`
   which suspends until the user decides.

2. **Codex** (`docs/harnesses/codex.md`): shell-script hooks (`packages/server/hooks/codex/`,
   installed to `~/.codex/hooks/layman/`) that inject `agent_type: "codex"` and POST
   Claude-Code-compatible payloads to the same `/hooks/:eventName` handler — no separate handler
   needed.

3. **Cline** (`docs/harnesses/cline.md`): bash hooks POST to `POST /hooks/cline/:hookName`; the
   handler and translator in `packages/server/src/cline/` map Cline's format to Layman's internal
   types, then reuse the same pipeline.

4. **Mistral Vibe** (`docs/harnesses/vibe.md`): passive watcher (`packages/server/src/vibe/watcher.ts`)
   polling Vibe's session JSONL. Watch roots come from `MonitorSource`s (item 4b), not hardcoded.

4b. **Monitor sources** (`packages/server/src/monitor/sources.ts`): a `MonitorSource` enumerates
   `WatchRoot`s (a harness log dir plus the agent type and an optional sandbox `label`) for the
   passive watchers, on demand, separating *where* to watch (a source) from *how* to parse (a
   per-format watcher). `NativeVibeSource`, `NativePiSource`, and `GloveSource` implement it; each
   passive watcher (`VibeSessionWatcher`, `PiSessionWatcher`, `ClaudeCodeSessionWatcher`) filters
   `roots()` down to the agent type it parses, so the single shared `GloveSource` instance feeds all
   three. Claude Code has **no native source** (hooks record native Claude Code; a native root would
   record it twice): `claude/watcher.ts` tails only glove-exported transcripts, read-only. A future passive
   harness adds a source plus a watcher and nothing else changes. Glove specifics:
   `docs/extensions/glove.md`.

   **glove v3 only** (`packages/server/src/glove/registry.ts`): the one reader of glove's home
   (`glove.home`, default `~/.glove`) for both `GloveSource` and the network views. A glove session is a
   directory the user chose; Layman reads only what its per-session **grants** export: **observe** →
   `observe/<id>/net/` and `observe/<id>/transcripts/` (the harness's transcript dir itself, harness taken
   from the registry row or `session.json`, never the layout); **filter** → `control/<id>/rules.json`,
   the one file Layman may write. The id (`<dirname>-<6 hex>`, glove's `ID_RE`) is the token everywhere,
   and `rules.json`'s `env` and `session` are both the id (schema still v1). `registry.json` is
   `{"v": 2, "sessions": [...]}`; a v1 array is a glove v2 home and is reported ("upgrade glove"), never
   read. A revoked filter grant leaves no trace on disk, so Layman remembers the last grant it saw
   (`net_sessions.filter_since`, migration 4, local only) — don't drop that column as unused. Orphans
   follow glove's `gc` rule, but a containerized Layman cannot see session directories, so it never
   claims "missing" for one it cannot stat.

4c. **pi passive watcher** (`packages/server/src/pi/watcher.ts`): tails pi's format-version-3 JSONL
   transcripts for glove-sandboxed pi (which cannot reach Layman over the network) and native pi with
   no live extension. Events go through the live path (read-time `timestamp`), so it also keeps the
   transcript's own times as `data.transcriptAt` / `data.transcriptCompletedAt`, and the parser's id as
   `data.transcriptEventId`, which is how a restart's replay skips what is already recorded (live ids are
   random, so without it every restart recorded a young session again). It also turns each message's
   `usage` into `session_metrics` (tokens by kind, and `ctx %` from glove's `session.json` `models`),
   once per batch that changed them. Design and reliability notes (why it never emits a trailing `tool_call_pending`,
   dedupe by committed id, tombstone resurrection) are in `docs/harnesses/pi.md`.

4d. **Network observability (glove)** (`packages/server/src/netobs/`, design
   in `docs/extensions/glove.md` → Network): tails each gloved session's `net/` (flows, exit, status) into a
   dedicated `NetStore` and `net:*` frames — **never `EventStore`** (same reason as live streaming).
   Rotated files are identified by content, not inode (Docker Desktop's bind mount changes inodes on
   rename). **Never make a network call keyed on gloved flow data**; tests in both packages enforce it (the web one also covers the Activity map's files, and `getJson` refuses anything but a `/api/` path when it runs).
   Client: data in `stores/netStore.ts` (never `sessionStore`, which must not re-render per delta);
   the selection (`netToken`, `netDest`) in `sessionStore` because the URL reads it. Which flows a
   dead gate left open is glove's rule (`ended_runs`, glove v3 `extensions/observe/netview.py`), ported in `NetStore` and held to it
   by a cross-check that runs glove's own function — change both or neither. State labels, colours and
   toggles come from one legend table (`NET_LEGEND` in `lib/net-format.ts`) that every view reads.
   `scope: lan` is not only the LLM (glove's ssh relay uses it too): name it by its tool
   (`isInferenceScope`), and Cut all covers what rides `lan`/`cloud` by `tool: llm` (both legs of an
   llm-auth call) and `tool: ssh`, never by scope, which no rule may name. A hop to a sidecar that goes
   on through another gate (`FlowFlags.hop`, the `llm` hop to llm-auth) is a local link whose bytes
   count once, at the next leg (design: glove.md → "llm-auth, the relays and downloads").
   glove's `scope: direct` is not always a leak: a flow through a corporate egress, or to a host in
   `glove.network.vpnDomains`, is a known VPN route (`FlowFlags.vpn`, set when a view is built, never
   stored or counted; `scope` stays glove's, so rules still match it). The web raises the untunnelled
   alarm only through `isUntunnelled` / `untunnelledFlows` (`lib/net-vpn.ts`), never `scope === 'direct'`
   (design: glove.md → "Known VPN routes").
   Rules: `netobs/rules.ts` is a port of glove's `policy.py` validator/evaluator (v3: `extensions/gate/netgate/`) and of its built-in
   `guard.check` (which refuses non-public proxy destinations by host shape and by in-tunnel IP before
   any rule, so a prediction must go through `predict()`, never `evaluate()` alone), held to both by a
   cross-check test that runs glove's own code; a write is confirmed only by glove's **hash rule**
   (`status.json` `rules.sha256` / `rules.last_rejected.sha256`), never by timestamps, and toggles show
   what the gate *enforces*, not what Layman wrote. The Map is fully offline: bundled Natural Earth land
   (lazy chunk) and geolocation only from a local MMDB file the user supplies (`netobs/geo.ts`), looking
   up only in-tunnel/literal destination IPs; the running-app check asserts every request goes to Layman.
   Geometry is pure and tested, components only draw: the Map's in `lib/net-geo.ts`, the Topology
   diagram's (columns, bands, the policy wall, the selected path's hops) in `lib/net-topology.ts`, and
   what Details says about any other box in `lib/net-topology-box.ts`.
   Trace joins a turn's tool calls to its flows in `netobs/correlate.ts` (pure; host + time, nearest
   start, search → fan-out, else Unattributed — never guessed; a kept-alive connection a later call
   rides is named in `openIds`, never claimed). Its Layman sessions are those whose
   `sessionName` is the glove session id. Call times come from the transcript (`data.transcriptAt` /
   `transcriptCompletedAt`, kept by the pi watcher) because a passive watcher's `timestamp` is when it
   *read* the call; without them a call joins by host only and is shown as approximate.
   Totals survive restarts as SQLite rollups (`netobs/persist.ts`, `history.ts`), written every 30 s
   while recording is on. They are kept with a watermark and a small carry list, and on restart the
   store subtracts what the re-read files already account for, so nothing is counted twice and
   traffic from deleted files is kept. A glove session whose files are gone is listed, history only.
   Change the counting only with `history.test.ts`, which restarts at every record.
   A **time range** (`net:subscribe { token, range }`, `netobs/range.ts`) is built on the server from
   glove's files into a fresh `NetStore`, never filtered from the live view or on the client: memory
   holds only the newest records, and the rollups' time axis (`net_hours`) is per hour and holds no
   flows. Keep it that way so a range and
   All records are counted by the same code. The only addition is the clip (a flow's bytes in a range
   are what moved during it), and `range.test.ts` holds a range around everything equal to All records.
   The part glove's files no longer hold is answered from `net_hours`, fed into that same store as kept
   history, up to a hand-over hour that is never in the future; move the hand-over only with the
   `range.test.ts` cases that fail when it is an hour off either way.
   A turn as a range ("Network for this turn") is one rule in two copies, like the turn rule: `turnSpan`
   (`lib/turn-range.ts`, the transcript and Prompts) and `turnEnd` (`netobs/trace.ts`, Trace's
   `TraceTurn.endedAt`). Change both or neither; on both sides "still running" means the glove gate is
   live, never the Layman session. The glove picker's order (`netPickerOrder`) must never depend on a
   session's latest record: a live gate writes records while idle, and the list reordered under the pointer.
   Design and rules: `docs/extensions/glove.md` → Network.

5. **OpenCode plugin** (`docs/harnesses/opencode.md`): a bidirectional plugin (`packages/opencode-plugin`)
   that receives events from OpenCode and can send prompts back, registered in
   `~/.config/opencode/opencode.json`.

5b. **pi extension** (`docs/harnesses/pi.md`): a single TypeScript file
   (`packages/pi-extension`) pi auto-discovers at `~/.pi/agent/extensions/layman/index.ts` and loads
   through jiti. It posts the same `/hooks/:eventName` payloads (`agent_type: "pi"`), is bidirectional,
   and is Layman's richest source (reasoning separated at the protocol level, live token streaming).

6. **EventStore** (`packages/server/src/events/store.ts`) — in-memory, max 10,000 events, emits `event:new` / `event:update` / `sessions:changed`. Also tracks active sessions (sessionId → cwd) via `trackSession()`. Events passing through the store are automatically scanned by the PII filter before storage.

7. **Session recording** (`packages/server/src/db/`) — SQLite database (`~/.local/share/layman/layman.db`, see `db/database.ts` and `config/paths.ts`) records all events for history and full-text search. Search uses SQLite FTS5 with a custom query parser supporting `+required`, `-excluded`, and `"quoted phrases"` operators.

8. **WebSocket** (`/ws`): On connect, server replays the last 100 events, all pending approvals, config, and current sessions list. After that, all changes are pushed as typed `ServerMessage` frames. The protocol is defined in `packages/server/src/types/index.ts` (server) and mirrored in `packages/web/src/lib/ws-protocol.ts` (client) — keep these in sync when adding message types.

9. **Analysis engine** (`packages/server/src/analysis/engine.ts`) — wraps Anthropic or OpenAI-compatible providers, supports `analyze()` (structured JSON → `AnalysisResult`) and `ask()` (free-form Q&A). Both return `{ text/result, tokens: { input, output }, latencyMs, model }`. Max 3 concurrent requests with a queue.

10. **PII filter** (`packages/server/src/pii/filter.ts`) — regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.). Applied at the EventStore level so all live events are covered regardless of source. Events that reach SQLite *without* the store — history import (`SessionRecorder.importSession()`) and the JSON file import — get the same filter through `SessionRecorder.setImportFilter()` (`filterEventPii`), keyed on the same gloved mark as the store (history import calls `markGloved` for a transcript from a glove root, so there is one source of truth); any new write path that bypasses the store needs it too. The store passes each event's session to its filters, which is how `glove.showIpAddresses` keeps IPv4/IPv6 in gloved sessions only (those a passive watcher marked with `markGloved` from a glove root, never "has a session name", which a renamed Claude Code session also has); a kept category's matches are parked behind placeholders while the other patterns run, because the phone pattern otherwise eats part of an IPv4 address.

11. **Client state** — Zustand store in `packages/web/src/stores/sessionStore.ts` holds all events, pending approvals, sessions list, active session filter, and investigation state. The `useEventStore()` hook at `packages/web/src/hooks/useEventStore.ts` applies session + UI filters on top.

12. **Drift monitoring** (`packages/server/src/drift/`) — Tracks two drift dimensions per session: *session goal drift* (is the agent still doing what the user asked?) and *rules drift* (is the agent following CLAUDE.md / AGENTS.md rules?). `DriftMonitor` accumulates user prompts and tool calls in a ring buffer, periodically sends them to the analysis engine (`assessDrift`), and EMA-smooths the returned percentage (alpha 0.3). Results map to four color levels via configurable thresholds (green/yellow/orange/red). At orange, `checkPreToolUse()` returns a reminder injected into the agent context; at red it can block via `PendingApprovalManager`. Individual drift findings can be dismissed as false positives — dismissed items are injected back into the LLM prompt to prevent re-flagging. State is broadcast to the web client via `drift:update` WebSocket messages and displayed in `DriftMonitorPanel` (dashboard) and `DriftBlockDialog` (blocking modal). Rules drift reads both `CLAUDE.md` (Claude Code / Cline) and `AGENTS.md` (other harnesses) via the `InstructionsLoaded` hook.

### Turns and addressable URLs

A **turn** is one `user_prompt` plus every event it owns up to (but not including) the next
`user_prompt`, and its response is the last `agent_response` in that window *that said something* —
an agent emits several interstitial messages between tool calls, and the final one is the answer.
The "said something" qualifier is not pedantry: a reasoning model emits one assistant message per
tool-calling step and pi records those for their reasoning alone (empty text, `thinking` set), so
taking the last one unconditionally let a trailing reasoning-only message blank out the answer in
the transcript, the export and TTS at once. A reasoning-only message is still used when the turn
produced nothing else, so an aborted turn keeps its reasoning.

The rule lives in **one place per package** and must stay in sync:
- `packages/server/src/turns/extract.ts` (server)
- `packages/web/src/lib/turns.ts` (client) — `pairFor()` in `event-pairing.ts` delegates to it

`TurnStore` (`packages/server/src/turns/store.ts`) reads recorded events from SQLite (the
in-memory `EventStore` caps at 10,000 and long sessions exceed it), falling back to the live
store for unrecorded sessions, and memoizes per session until a new event arrives.

**URL grammar** — `packages/server/src/export/urls.ts`, mirrored in `packages/web/src/lib/layman-url.ts`:

```
/                                    dashboard
/s/{sessionId}                       session transcript
/s/{sessionId}/t/{promptEventId}     a turn  ◀ the primary addressable form
/s/{sessionId}/e/{eventId}           a single event
/h/{id}  /b/{id}  /f/{id}            highlight / bookmark / bookmark folder
?view=dashboard|logs|prompts|flow|activity|sessions   ?play=1   ?t=<ms>
?view=network|map|topology|trace&glove=<token>&dest=<host>   glove network views
  &from=<iso>&to=<iso|now>           …and their time range (pushes: Back returns to the previous one)
?view=matrix|matrix2d|matrix3d       Styx (Matrix views; matrix is the Godot frame), session views: /s/<id>?view=matrix2d
?view=gibson|gibson2d|gibson3d       Styx (Gibson views), session views too: /s/<id>?view=gibson2d
```

Ids may be given as an unambiguous prefix of ≥8 characters; ambiguous prefixes return 409 with
the candidate list rather than guessing. Round-trip tests (`parsePath(buildPath(x)) === x`) in
both packages are what keep the two copies from drifting.

Read API (`packages/server/src/routes/turns.ts`, registered by one call from `server.ts`):
- `GET /api/sessions/:sessionId/turns` — turn list, text truncated at 2 KB
- `GET /api/turns/:sessionId/:promptEventId` — one turn; `?format=md` for markdown
- `GET /api/sessions/:sessionId/export` — `?format=md` or JSON; **the JSON shape is exactly what
  `POST /api/bookmarks/sessions/import` accepts**, so export→import round-trips
- `GET /api/resolve?id=` — resolves an id or prefix to its entity kind. Also returns `sessionId`
  for events/bookmarks/highlights and `promptEventId` for highlights, so `/b/` and `/h/` links
  become navigable in one request

Markdown serialization is shared by the API and any exporter: `packages/server/src/export/markdown.ts`
(pure, filesystem-free). `publicUrl` config (falling back to `hookUrl`, then `host:port`) is the
base for all generated links — never hardcode `localhost` in generated artifacts.

The SPA fallback in `registerPlugins()` serves `index.html` for any unmatched GET that isn't
`/api/*`, `/hooks/*` or `/ws`; without it, reloading a deep link 404s.

**Client-side routing** — `packages/web/src/hooks/useLaymanRoute.ts`, called once from `App.tsx`.
Two deliberately asymmetric directions:

- *inbound*, on mount and on `popstate`: `parsePath()` → `sessionStore.hydrateFromRoute()`.
- *outbound*, on every store change: `routeForState()` → `history.pushState`/`replaceState`.

`replaceState` is used when the addressed entity is unchanged (a view toggle) and `pushState` when
it changes (opening a session, selecting a turn), so Back leaves a session rather than unwinding
panel toggles. A module-level `applyingRoute` flag stops the outbound half from overwriting a URL
the inbound half is still reading — without it, the default store state races hydration and
rewrites a deep link to `/` on mount.

`hydrateFromRoute` is the only place a route becomes view state, and `routeForState` the only place
the reverse happens. Anything hydration sets must be readable back out or a deep link decays on the
first re-render: that is why `selectedTurnPromptEventId` and `selectedHighlightId` live in the store
rather than in component state. `?play=1` and `?t=` are arrival-only and deliberately never
re-emitted. `?view=` maps to the internal `ViewMode` through the two tables in `sessionStore.ts`
(`viewNameForMode` / `viewModeForName`) — the only place the URL vocabulary and `ViewMode` meet.

### Live token streaming

Partial assistant output — text and reasoning, separately — pushed to the dashboard as it is
generated, plus a running token counter.

```
packages/server/src/stream/live.ts        LiveStreamStore: accumulate, redact, sweep
packages/server/src/hooks/handler.ts      POST /hooks/StreamDelta (fast path in the existing switch)
packages/web/src/components/logs/LiveStreamRow.tsx   the row pinned to the stream tail
```

**This deliberately bypasses `EventStore`.** Everything added via `EventStore.add()` is PII-scanned,
pushed onto a 10,000-entry ring, recorded into SQLite and broadcast — right for a tool call, ruinous
for a token delta, of which a local model produces thousands per turn. `session_metrics` set the
precedent: high-frequency data gets a dedicated map and a dedicated WebSocket message
(`stream:update` / `stream:end`), never the timeline. `/hooks/StreamDelta` still lives inside the
`/hooks/:eventName` switch so it inherits session tracking, agent-type resolution and the
activation gate — it just never calls `eventStore.add()`.

Three consequences worth knowing:

- **PII is applied to the accumulated buffer, not to each delta.** A secret routinely straddles a
  delta boundary — neither half matches on its own — so per-delta filtering would leak it whole.
  This is the same class of hole documented for `attachLaymans()` under `EventStore.setStringFilter()`.
- **Coalescing happens twice**: the producer batches at 100 ms / 256 chars, and the server coalesces
  per session at ~10 Hz before broadcasting. One fast producer must not saturate every connected
  dashboard, and the server must not re-amplify what the producer already batched.
- **`liveTokens.enabled: false` drops deltas at ingest, server-side**, and `showThinking: false`
  suppresses reasoning before it enters the buffer. A user who turns the feature off should stop
  paying for it, not merely stop seeing it.

The client clears a session's buffer both on `stream:end` *and* when the committed `agent_response`
arrives. Those are separate WebSocket frames with no ordering guarantee between them, so relying on
`stream:end` alone can render the partial and the finished text at once.

Three more things a live row must never do, each of which produced a stuck row before it was fixed:

- **A closed message stays closed.** A producer's final delta flush and its `done` flush are
  *independent* posts with no ordering guarantee — pi's `message_end` fires both back to back — and
  when `done` wins the race, the straggler looks exactly like the first delta of a new message.
  `LiveStreamStore` remembers closed messages for the length of the idle sweep and drops deltas for
  them. Without that, an assistant message consisting only of tool calls leaves a phantom row: no
  committed `agent_response` ever follows to clear it. The record is keyed by session **and**
  message, not one entry per session — a turn holds several assistant messages, and with only the
  latest remembered a straggler for A arriving after B had opened and closed sailed through the
  guard. A `done` naming a message other than the one currently streaming closes both.
- **`SessionEnd` closes the stream, server-side.** The extension's own closing flush rides the
  fire-and-forget path and is dropped by the exiting process — which is the whole reason `SessionEnd`
  is the one post it awaits. Trusting the delta means a harness quit mid-generation shows
  "responding…" with a blinking caret for up to 60 s.
- **The token counter is an estimate, and says so.** No harness reports usage *during* generation:
  pi and OpenCode both attach it to the finished message, by which point the row is gone. The count
  is derived from the accumulated output (4 chars/token) and rendered `~1.2k out`; `tokensEstimated`
  is cleared for good the moment a producer sends a real `tokens.output`. It is counted from a
  running character total, not from the buffers, which are tail-truncated at 32 KB.

Fidelity is not uniform, and the four harnesses with no streaming hook must render as **no live row
at all** — never an empty or stuck one:

| Harness | Mechanism | Live text | Live thinking | Live tokens |
|---|---|---|---|---|
| pi | `message_update` / `AssistantMessageEvent` | token-level | token-level, separate stream | estimated live counter; exact per-turn `usage` after |
| OpenCode | `message.part.updated` | token-level (cumulative → diffed) | `reasoning` parts | estimated live counter; exact post-turn |
| Claude Code | StatusLine relay, 300 ms debounce | ✗ | ✗ | post-turn counter |
| Codex | 5 hooks, no streaming | ✗ | ✗ | post-turn only |
| Cline | shell hooks | ✗ | ✗ | post-turn only |
| Mistral Vibe | 2 s log poll | ✗ | ✗ | post-turn only |

### Activity map

**Stations** (the kind of work a tool call is) are **derived at read time, never stored**:
`stationOf(toolName, toolInput)` is a pure function of recorded fields, so it covers all history, needs
no migration and no `SYNC_ENTITIES` entry, and improves without a backfill. It lives twice,
**byte-identical**: `packages/server/src/events/station.ts` and `packages/web/src/lib/station.ts`
(no imports, so the copies can match), held to one fixture both suites read
(`packages/server/src/events/station-fixture.json`); the web suite fails if the files differ. Shell
lines are scanned (quotes, heredocs, `$(…)`, redirections, wrappers, `bash -c`), never split on
operators: a quoted `|` or a heredoc body read as commands misfiled most of a real history. A new
harness tool name goes in the fixture with its harness. The **Guard** station is Layman's own
decisions (approval, denial, drift reminder/block), not a tool.
**Memory** is Claude Code's `~/.claude/projects/*/memory/` for everyone, plus `activity.memoryPaths`
and `activity.memoryServers` (config, deep-merged); `instructions_loaded` is memory *pushed* into the
context (`isPushedMemory`), counted apart from memory the model asked for. `eventStation()` is the
one place a recorded event gets its station.
`safeLabel()` (same file) is the names-only label: a name, never content (no command line, query,
prompt, search pattern or path beyond its last two parts); `hostOf()` is its URL rule. Add a case to
the fixture's `labels`/`hosts` with any change.
The **board** (`packages/web/src/lib/activity-board.ts`, pure) reduces one session's events to counts
per station, faults since the last prompt (the turn rule's duplicate-prompt window, from `lib/turns.ts`),
running calls, live subagents and the route. A call is counted once: the second event of a call recorded
in two (a hooks failure; Vibe's approved-then-completed, the only harness whose `tool_call_completed` is
a separate event) closes the open call with the same tool **and input**, never another: everywhere else
a completed event *is* the call, and letting it close a sibling hid running calls. A decision adds a
Guard entry beside the call. A call still open at the next prompt or the session's end is `unended`,
never a fault, and stays claimable, so a late result closes it without counting twice. Its input is the
whole recording (`?lean=1`, without outputs) joined with the live store and with `lateUpdates`
(`useSessionTimeline`), never the live store alone, which holds the WebSocket's last 100 events and what
arrived since; `lateUpdates` keeps the WebSocket's updates to events the store does not hold, or a
recorded call that finishes later would run on the board forever.
The map's geometry is pure (`lib/activity-map.ts`, as for Map and Topology): any number of stations on
an ellipse, the first at the top, labels outside the ring tested not to overlap a label or node for 2–16 stations at the least size; spokes worn by the log of the count (full at 2,047); route legs that curve between the
core and the ring (tests sample every leg of every pair and fail if one cuts the core or leaves the ring,
where the labels are); lanes for pulses that share a spoke.
The view (`components/activity/`, the **Activity** tab, `ViewMode` `'activity'`, `?view=activity`) only
draws: what it follows and shows (the session, the pulses in flight, a feed row's words) is pure in
`lib/activity-view.ts`. Its animation is in `components/activity/activity.css` (not `index.css`), scaled
by `--motion`, none under reduced motion or in print. The map's box never sizes itself from its content
(it is absolutely placed in its pane), or a growing feed beside it grows it without end; in print the
pane gets its own height (`activity.css`), and feed rows are not buttons, which print hides. Motion
honours Settings → Motion (`data-motion` on `<html>`) as well as the OS setting. A row clicked open
loads the session's full recording into `historicalEvents` first when the store lacks the event:
the board reads the lean one, which Investigation cannot show. `isSessionView` / `isExclusiveView`
(`sessionStore.ts`) list the views; a new one goes there. The map is the Activity tab's only: the
Dashboard has none (a small one per pane was tried and removed). The map reads its live events from one
split of the store by session (`bySession` in `useActivityBoard.ts`, cached per event list, because the
selector runs at every store change, not only when events arrive), and `useSessionTimeline` keeps the
last two lean recordings (each can be tens of MB) so switching back to a session does not download it
again; it refetches only when the recording is missing or the live slice no longer reaches back to it.
A gloved session's glove gates stand after the stations (`lib/activity-glove.ts`, pure), and its network calls
are drawn on them: each `BoardEntry` has `on`, the map station it is drawn at (its station, or a gate), set by
`BoardOptions.place` (`placeCalls`); counts, faults, the route, running calls and the fold are keyed by `on`.
A `network` call goes to the first gate its flows went through (Trace's join), else to the gate glove declared
for its tool (`WebFetch` → `web_fetch`), else stays on **Network, which is shown only while some call joined no
gate**. Only a `network` call moves (an install that downloads stays Shell's). Which gates: `fromSandbox` services
that are not the model's link. A service owns its own bytes first, then those of the gates it goes on through by
`next`. A `flags.hop` destination is counted once, at the next leg, and one reached by several gates counts at
each (the aggregate does not say how much each carried, so it is never split by a guess). Browser bytes wear
Browser. Gates of one name are one, and past `MAX_GATES` the quietest fold into "Other gates". A direct gate is red
only for `isUntunnelled` flows, never by its route alone.
They are read from Layman's `/api/net/sessions/:token/gates` (`useGloveMap`), never the network tabs' single
subscription, which they own. Params: `since` (ms; drops destinations last reached before it, so an earlier run
does not wear the map), `session` (a Layman session id: its calls joined to their flows by `sessionJoins`, built
from `trace.ts`'s `turnsOf`/`joinTurn`, which Trace also uses, plus the last `LOOSE_FLOW_MS` of flows no call
claimed), and `from`/`to` (a turn's span: destinations are then that span's flows, `trafficOf`, never the
glove-session totals). The response (`GatesView`) carries the exit's kind, place and health **without its
address**. A refused call's pulse is red; Tool egress (`egress`, SearXNG's fan-out) and unattributed flows are
hollow pulses. The **exit ring** is the map's frame, solid for a verified tunnel, dashed when unverified, red only
through `isUntunnelled` (`exitRing`). **This turn** (map header) draws one turn: the one of the feed row last
opened (`selectedEventId`), else the last; `mapTurn` and `turnSpan` are the same rule as the turn rule, and
an ended turn's gates are read once. Everything here is a read of Layman's own records: never a network call keyed
on flow data.

**Background tasks and model changes (round 4).** A call that asked to run in the background records
`data.backgroundTaskId` (`backgroundTaskIdOf`, parsed at ingest from the response's prose: `agentId:` /
`with ID:`), and the board keeps it running, across prompts, until its end arrives. That arrives as a
`UserPromptSubmit` whose text starts `<task-notification>` (observed, undocumented; `task-notification.ts`,
**byte-identical** in `packages/server/src/events/` and `packages/web/src/lib/`, a web test holds them). It
is the harness, not the person: it opens no turn (`isTaskNotification` in **both** turn-rule copies, which
must agree), adds no `you` entry on the board, and never reaches the drift monitor. History has no task id,
so an old background call finishes at once. `model_change` (`fromModel`, `toModel`) comes from
`PostModelSwitch` and from the Stop-time transcript reader (`transcriptModels`), once between them; it sets
the board's `model` and is not work. Steps are not events.

### Styx (Matrix views)

An optional extension (`styx.enabled`, off by default; user doc `docs/extensions/styx.md`). Off: no tabs, and
the whole `/api/styx/` prefix answers 404, checked per request because the setting changes at runtime. It
adds no table and syncs nothing: the feed is computed on request from Layman's own records.

```
packages/server/src/styx/matrix.ts      pure: rows from flows / glove totals / tool calls, merge, sort, cap
packages/server/src/styx/routes.ts      GET /api/styx/v1/matrix (the styx-os /v1/matrix shape, plus blocked, untunnelled) and the Gibson routes below
packages/server/src/styx/gibson.ts      pure: hosts / links / log rows (the styx-os /v1/hosts, /links, /flows shapes) from flows, glove totals, tool calls
packages/web/src/lib/matrix-feed.ts     the row type (mirror), the windows, the feed URL
packages/web/src/lib/matrix-rain.ts     pure, shared by every renderer: what falls, where, how fast, what is new
packages/web/src/lib/matrix-gpu.ts      pure, 3D only: glyph order, the two data textures' packing, the layers' transform, picking
packages/web/src/hooks/useMatrixFeed.ts  the poll
packages/web/src/components/matrix/     MatrixView (bar + the tab's renderer), MatrixCanvas2D, MatrixCanvas3D (+ matrix3d-gl, matrix3d-shaders), GodotFrame (both Godot tabs), StreamCard
packages/server/src/styx/godot.ts       the Godot tab's build: resolveGodotFile, godotBuildStatus, GODOT_CSP
packages/web/src/lib/matrix-godot.ts    pure: the frame's src, godotTabState (insecure / no build / motion off / run)
packages/server/src/styx/gibson.ts      pure: host / link / log rows from flows, glove totals and tool calls (the Gibson feed)
packages/web/src/lib/gibson-feed.ts     the row types (mirror), the feed URLs (`feedQuery` in matrix-feed.ts is the shared query rule)
packages/web/src/lib/gibson-city.ts     pure, the model every Gibson renderer shares: slots, placement, towers, routes, pages, menu, traffic
packages/web/src/lib/gibson-schemes.ts  the colour schemes: the only file besides themes.ts that may hold colour literals
packages/web/src/hooks/useGibsonFeed.ts  the polls: hosts and links together, and one tower's log
packages/web/src/lib/gibson-2d.ts       pure: the 2D projection (project / unproject), fitCam, zoomAt, draw order, silhouette, pickTower
packages/web/src/lib/open-network.ts    openNetwork(token, address): the Matrix cards and the Gibson panel both open Network through it
packages/web/src/components/gibson/    GibsonView (bar, pickers, owns the selection), GibsonCanvas2D (state + pointer), gibson2d-draw.ts (what is painted), GibsonPanel (the menu as HTML), GibsonHostList (the screen-reader list)
packages/web/src/hooks/useGibsonCity.ts  the city both renderers draw: placement, the fresh set, traffic, arrivals (reset with the session or window)
packages/web/src/lib/gibson-gpu.ts      pure, 3D only: matrices, the fly camera, ray picking, the tour, packTowers / packPages, cityKey, labelsOf
packages/web/src/components/gibson/    GibsonCanvas3D (state, camera, input, labels), gibson3d-gl.ts (createScene, the passes), gibson3d-shaders.ts (GLSL)
```

Rules of the feed that must not be changed casually:

- **A hop (`flags.hop`) is never a destination**, and a null-host aggregate (a service endpoint) is skipped:
  hop bytes are counted at the next leg (4d above). `blocked` counts the states in `REFUSED`, exported from
  `netobs/trace.ts` and shared with Trace, never a second list. `untunnelled` is
  `scope === 'direct' && !flags.vpn`, the web's `isUntunnelled`; `flags.vpn` is already set on what `NetStore`
  returns (`withVpn`), so the feed adds no VPN rule of its own.
- **Sorted by `count` descending, then `address` ascending, and cut at 256 after sorting** (`mergeRows`, the one
  place that does it).
- **A standard session's address takes its URL's port, or its scheme's (443, 80)** (`TraceCall.targets[].scheme`,
  read only by Styx; the Trace join ignores it), so a row says whether HTTP or HTTPS was used. A call counts
  once per address.
- **The route is polled every 2 s per open tab, so it must stay cheap.** A gloved answer is `NetStore`
  (memory). A standard session's is the in-memory `EventStore` (`memory()`, with `since`, the time from which
  memory holds all of the session's events: server start, or the oldest held once the ring is full); only a
  window reaching before `since`, or the whole record, reads the session's recording, cached 30 s **by session
  alone** (`since` moves once the ring is full, so keying on it would read the recording at every poll), and
  merged with memory, which wins by event id. What is new always comes from memory, so the cache never delays a
  new host. Never call `turnStore.eventsFor` per poll.
- **No network call keyed on what it shows, no lookup of a host**: the server's no-network test covers `styx/`
  (in `netobs/index.test.ts`) and the web one `components/matrix/`, `lib/matrix-*` and `hooks/useMatrix*` (and, for Gibson, `components/gibson/`, `lib/gibson-*` and `hooks/useGibson*`).
- A host reached now must fall within about two seconds: the 2 s poll, plus a refetch 150 ms after an event for
  the session reaches the page (`useLiveEventCount`). The hook never runs two requests at once.

The Gibson feed (`GET /api/styx/v1/hosts`, `/links`, `/flows`, `styx/gibson.ts`, user doc `docs/extensions/styx.md` →
"The Gibson feed"; the row types are mirrored by hand in `packages/web/src/lib/gibson-feed.ts`) follows the same rules,
and they are not to be redone per route: **all four routes choose their data in one `select()`** in `routes.ts`
(validation, 400/404, the 15-minute default, which sources), so a rule changed for one is changed for all; a hop and a
null-host flow are skipped; `REFUSED` is the matrix's; a poll answers from memory (`NetStore`, `standardCalls`), and
**links and the log always come from `flowsBetween` (also for the whole record: glove's totals do not say which client
reached a host)**, so they reach back only as far as memory does. Ages are seconds to the server's now, never
timestamps, because a viewer's clock and a Pi's rarely agree.

The Gibson web side. **Placement is remembered, and `place` is the only thing that changes it** (`gibson-city.ts`):
a tower that stays in the answer never moves, so a refresh adds and removes and never reshuffles; the component holds
the last `Placement` in a ref and resets it with the session or window. Everything else in the city model is a pure
function of the answer, shared by Gibson 2D now and 3D later, so a rule (size, tone, route, a page's lines) is changed
there and nowhere else. A car's direction comes from `hash01` of the link and its number, never a random call, so a
still frame repeats. **`gibson-schemes.ts` holds the one set of colour literals outside `themes.ts`** (the four film
schemes are fixed looks that must not follow the theme; `theme-literals.test.ts` lists it in `ALLOWED`); State reads
theme tokens through a function handed in, so it follows the theme and the file never touches the DOM. The Gibson
views are a second tab group beside the Matrix's, behind the same `styx.enabled`.

Gibson 2D (`GibsonCanvas2D.tsx`, `gibson2d-draw.ts`, `GibsonPanel.tsx`). **The city canvas is never redrawn per
frame**: it is redrawn when the city, the camera, the size, the scheme or theme, the selection or the selected
tower's log changed, and at a 100 ms beat only while a tower is rising, fresh or brightening from a car's arrival
(the clocks that have no data); the traffic canvas above it is the only thing drawn every frame, and only while
motion is full. The projection, the camera and the picking are pure (`lib/gibson-2d.ts`, tested); the draw file
decides only how it looks and holds no colour literal (everything is the `Palette`). The component keeps, in
refs and reset with the session or window, the `Placement`, the set of hosts known (`null` until the first
answer, so nothing is fresh on the first draw), when each fresh host appeared, and the `Traffic`; the camera is
fitted once to the first city and to a resize, and after that only the user's (a city that grew must not move
the picture), until the session or window changes or **Fit** is pressed. A face's text appears only where a cell
is at least 3 px high (so at the default fit a face is plain glass; zooming in brings the text),
except Night, whose lit windows stand in for it at any zoom. State's text on a light board is the glass toward
black, because white on pale glass vanishes. **The panel is the accessible form of the scene's menu**: it is HTML in
theme tokens in every scheme (never the picture's colours), a listbox with Up and Down, and the canvas has a
hidden list of the hosts and their state in words. The selection lives in `GibsonView` and is cleared when the
session or window changes or the host leaves the answer; the log is polled only for the selected tower. The pointer's
hover test must not read the `hover` state to decide whether to clear it (two moves can arrive before a render and
the stale value left the card behind).

Gibson 3D (`GibsonCanvas3D.tsx`, `gibson3d-gl.ts`, `gibson3d-shaders.ts`, `lib/gibson-gpu.ts`). **`gibson-city.ts` is shared by both renderers and
the drawing must never fork its rules** (the city, traffic and pages come from `useGibsonCity` in both). Raw WebGL2, the house
style of `MatrixCanvas3D`: **no colour literal in GLSL** (every colour is a uniform or instance attribute from the `Palette`;
`gibson3d-shaders.test.ts` fails on a `vec3` of numbers beyond 0 and 1), **`createScene` creates every GL object** so a lost context
is rebuilt by one call, a framebuffer's texture is upside down against `vUv` (post passes read it through `tuv()`), shader times
are seconds since the renderer was made. **The instance buffer and the page texture are rewritten only when `cityKey` or
the page text changes**, never per frame or per beat; a frame uploads the camera, the clock, the arrivals (up to 16 pairs of tower
index and start time) and the cars. A tower is 16 floats (`packTowers`: x, z, side, height | glass, brightness | text, page |
cap, flags, page rows, riseAt); a tower's rise and an open link's pulse and an arrival's glow come from the clock in the shader.
The page texture is one R8 texture of 16 x 16 pages of 24 x 64 glyph indices (384 x 1024), a tower's page repeated down its faces
(`row % rows`). **The tower pass is additive** (`ONE, ONE`, depth tested, not written, no culling) **except on a light board**
(`palette.light`), where it covers with alpha, writes depth and culls back faces and the glow is skipped. Face glyphs are sampled
with `textureGrad` from the continuous cell coordinate's derivatives taken before any floor or branch; beyond 40-70 units they fade
into bars, and into the row's average under a few pixels a row, so nothing shimmers. Traces and decoration are dimmed by how much
narrower than a pixel they are, or they pile into a white band at the horizon. The fly keys (`W A S D Q E`, arrows) stop propagation
only while the canvas has focus, because the header's shortcuts listen on the window. Labels are a pool of DOM elements moved
imperatively each frame, never React state. The camera's motions other than the user's (a fly-to, the idle tour) are in a
ref and end on any input; with motion not full there is no loop, a selection jumps, and the board shows dashed routes. A wheel is
normalised by `deltaMode` (Firefox reports lines).

The renderers. `matrix-rain.ts` is pure and shared (the 3D renderer uses it too): a stream's head is at row
`(now - startAt) x speed`, so a refresh of the data never restarts a stream and a redraw puts it back. A new
address (not in `known`) starts at once, `fresh`, drawn in `--accent-hot` for that one fall; `known` is null
until the first answer for a session and window, or the whole screen would flash. `MatrixCanvas2D` draws on a
fixed 50 ms step: fade the canvas a little (the trails), draw only each stream's new head cell. Its cost is by
columns, not cells; if it ever draws every cell, fix that rather than slowing the step. Colours are read with
`readToken` and redrawn on `useThemeVersion`; with motion not full it draws one still frame.

`MatrixCanvas3D` is raw WebGL2: one full-screen triangle, the picture computed in the fragment shader from two
textures, a column texture (`RGBA32F`: start, rows/s, length, tone + 4 x fresh + weight / 2) and a text texture
(`R8` glyph indices) that are **rewritten only when `planStreams` changes the set of streams** (`streamsKey`),
never per frame: a stream's head is computed in the shader from time, so a frame is a few uniforms. Times are
seconds since the renderer was made (a float32 cannot hold `Date.now()`). `layerCell` (`matrix-gpu.ts`) and the
shader's layer transform (`matrix3d-shaders.ts`) are **one rule in two copies**: change both or neither
(`matrix-gpu.test.ts` holds the TS one to hand-computed cells, and the per-layer grid, `gridOf`, is computed in
TS and passed as a uniform so the two cannot disagree on a rounding). The atlas is sampled with `textureGrad`
from the cell coordinate's derivatives taken before any branch, or a glyph takes its mip level from a
neighbour. A light background draws by cover (`uLight`) instead of adding. **No colour literal in GLSL**: every
colour is a theme token read with `readToken`, parsed by `rgbOf` and passed as a uniform; only `vec3(0.0)` and
`vec3(1.0)` appear. Creation is one function (`createScene`), so a lost context is rebuilt by one call.
Depth: four layers (`LAYER_SPECS`), data on the near two. `assignLayers` puts a fresh row near, keeps a falling
stream on its plane (a refresh must not move it), and splits the rest by reach; `planStreams` runs once per data
plane with `visibleRowsFor(layer)`, because a slow plane's streams last longer than `planStreams` thinks. After the
scene, `createScene` runs bright pass, two blurs (half size) and a composite with the vignette; a light
background skips the glow. **A framebuffer's texture is upside down against `vUv`** (clip space's bottom is row 0):
every post pass reads it through `tuv()`, and forgetting that mirrors the whole picture.

**The Matrix (Godot) and Gibson (Godot) tabs** run a web export of styx-godot that the user makes (`make styx-godot-build`) in an
iframe (one build, one component, `GodotFrame`; the view is chosen by `viz`, and the Matrix's address is unchanged); **the build is never committed or shipped** (styx-godot's shaders are partly CC BY-NC-SA; Layman is MIT),
and Layman serves a folder (`styx.godotDir`, default `<data dir>/styx/godot`, the only place a Docker Layman
sees; a configured one is read, never created) under `/styx/godot/`. Rules: **the CSP is the enforcement of "every
request goes to Layman"**: `connect-src 'self'` and `default-src 'self'` must not be loosened (loosen only the
one directive a start-up failure names, and say why in `godot.ts`); **`resolveGodotFile` is the only path from a
URL to a file**; the SPA fallback in `server.ts` excludes `/styx/`, or a missing `index.wasm` would be answered
with Layman's HTML and a 200; files carry `Last-Modified` (304) because the `.wasm` is 35 MB. The web decides
what the tab shows in `godotTabState` (a non-secure page cannot start Godot's shell, so it says so and offers
2D/3D; Reduced/Off motion does not start the engine without **Run anyway**) and the frame is removed on leaving
the tab (never kept alive hidden). The engine takes focus when it *starts*, seconds after the frame's `load`,
which silences Layman's shortcuts: `MatrixGodot` hands focus back until the pointer enters the frame.

A build from before styx-godot knew Gibson ignores `viz` and shows the Matrix without saying so, which is why the Gibson tab
asks the page `window.styxViews` (same origin, polled after `load`, `godotViewState`, 15 s) and notes a build without the view.
Changing the Gibson scheme restarts the engine: the build reads it at start-up only.

**Licence: neither renderer may be derived from styx-godot's shaders.** Two of them (the background and 3D
rain) are Shadertoy ports under CC BY-NC-SA 3.0; Layman is MIT. They are not to be copied, ported or consulted
for the 2D and 3D renderers.

### Text to speech

Reads agent responses aloud through a [speaches](https://github.com/speaches-ai/speaches) server
(OpenAI-compatible, default port 8000). Off by default; Settings → Data → Text to speech.

```
packages/server/src/routes/tts.ts     proxy: /api/tts/{speech,voices,models,test}
packages/web/src/lib/tts-text.ts      markdown → speakable prose
packages/web/src/lib/tts.ts           TtsPlayer singleton: queue, LRU blob cache, playback
packages/web/src/hooks/useTTS.ts      auto-speak: watches the event stream
packages/web/src/components/tts/      SpeakButton, TTSBar
```

Three trigger paths: the **speaker button** on turn headers, agent-response log rows and highlight
detail; **auto-speak** (`none` | `final` | `all`); and **`?play=1`** on a `/t/` or `/h/` URL,
consumed once in `useLaymanRoute`'s inbound half and never re-emitted.

`TtsPlayer` is a module-level singleton, not store state — there is one pair of speakers, and speech
must outlive the component that started it. It exposes a `useSyncExternalStore`-compatible
`subscribe`/`getState`. Its audio layer is injected (`TtsRuntime`) so the queue semantics can be
tested in node, where there is no `Audio` and no `URL.createObjectURL`.

### Multi-host sync

A **central** instance collects recorded data from many **remote** instances; each remote keeps
recording locally and pushes to central, optionally **mirroring** (pulling) everything else back.
`sync.role` is `standalone` (default) | `central` | `remote`. The design is in this section;
user-facing summary in [`docs/features.md`](docs/features.md#multi-host-sync). The pieces live in `packages/server/src/sync/`
(`identity`, `state`, `entities`, `journal`, `tokens`, `applier`, `pusher`, `puller`, `presence`,
`stats`, `routes`, `protocol`), wired from `server.ts` by `reconcileSync()` on config change.

Four rules that must not be relaxed casually:

- **The journal is written by SQLite triggers, never by application code** (migration 2 in
  `db/database.ts`). Every recorded-data write — the recorder, bookmark/highlight stores, the raw
  `UPDATE`s in `server.ts` and `pii/purge.ts` — is captured into `sync_log` by `AFTER
  INSERT/UPDATE/DELETE` triggers. A new recorded-data write site therefore needs no instrumentation,
  but a new *table* worth syncing needs a trigger plus a `SYNC_ENTITIES` entry. A session delete
  journals one cascade row, not one per event.

- **Remote data never goes through `EventStore`**. `SyncApplier` writes straight through the
  entity tables; feeding remote rows through `EventStore.add()` would re-record them and a historical
  backfill would evict every live event. Live remote presence rides `RemoteSessionRegistry` +
  ordinary `event:new` frames, not the store.

- **Origin ownership.** A row's `host_id` is its origin. Sessions/events/qa are edited only by their
  origin; curation (bookmarks, folders, highlights) is editable only on the host that created it and
  read-only elsewhere (server returns 403, client hides affordances). Push forces the authenticated
  pusher's origin; **pull passes `trustRowOrigin` so a mirrored row keeps its true origin** — do not
  drop that flag or central becomes the apparent author of everyone's data.

- **Identity is established before any recorded-data write** (`ensureHostIdentity` after
  `openDatabase`), because the triggers read `sync_state.hostId`. `sync.hostId` is deep-merged in
  `config.ts` so a partial Settings update can never blank it and orphan every row.

- **The glove network rollups are deliberately not synced** (`net_sessions`, `net_destinations`,
  migration 3; their time axis `net_hours` and `net_runs`, migration 6; `netobs/persist.ts`). No triggers, no `SYNC_ENTITIES` entry. They record where one
  host's sandboxes browsed, and syncing them would ship that to a central instance. Do not "fix" this
  by adding them to the journal.

- **IP addresses kept by `glove.showIpAddresses` never cross hosts**, for the same reason. With the
  PII filter on, every outbound sync path (push, `/api/sync/snapshot`, `/api/sync/changes`) redacts
  event rows in full. Central cannot tell a gloved session from a renamed one, so "keep what the
  origin recorded" is not an option. The redaction lives in the entity readers an outbound path must
  use (`loadOutbound`, `page`, `pageExcludingOrigin` in `sync/entities.ts`, each taking a required
  `piiFilter`), so a new path cannot forget it; plain `load` is for local reads only.

### Key design decisions

- **An expanded Logs row has one Copy, and what it copies is `eventCopyText()`** (`lib/event-copy.ts`): the body's sections in the order shown, whole, as source text (a new body section goes there too). Its text is unboxed so the first line carries the actions and the body repeats nothing: `PlainBlock`, and `flat` on `CommandBlock` / `DiffBlock` (the Investigation panel keeps the boxed forms). Anything cut behind "show more" uses `usePrintExpandable()`, since print hides the button.

- **Dashboard panes live in the store, not the Dashboard** (`dashboardOpenPanes` /
  `dashboardSettledPanes` in `sessionStore.ts`): the Dashboard unmounts whenever another view is
  shown, and with the panes in component state every session was new again on the way back, so a
  closed pane reopened. A pane opens by itself once (`panesToOpen` in `lib/session-state.ts`); after
  that it is the user's. A **quiet** session (`SessionInfo.quiet`: only `events/quiet.ts` types,
  e.g. `instructions_loaded`, `config_change`) is held unsettled while `dashboardHoldQuiet` is on and
  opens when its first real event clears the flag. The flag is the server's (`EventStore`), seeded
  for a session first seen after a restart from its recording (`recordedActivityProbe`), because the
  client holds only the last 100 events and would call a busy session quiet.

- **Subagent events are tagged at ingest** (`subagentScoped` in `hooks/handler.ts`, from the
  `agent_id` Claude Code puts on every hook fired inside a subagent). The old time-window tagging at
  `SubagentStop` stays only as a fallback: it also caught the parent's own calls whenever a
  background agent ran beside it. A subagent's number (`data.subagentN`, which its chip and colour
  follow) is stamped by `EventStore`, never counted by a view: each view holds a different window
  of a long session. Detail in `docs/harnesses/claude-code.md` → Hooks.

- **Blocking hooks**: `PreToolUse` and `PermissionRequest` (Claude Code) and `PreToolUse` (Cline) suspend the agent process until `PendingApprovalManager.resolveApproval()` is called. Claude Code's timeout is 300s (configurable); Cline's is 25s (Cline hardcodes 30s).

- **`permission_request` vs `tool_call_pending`**: Both create pending approvals server-side (needed for blocking), but `usePendingApprovals` filters out `PermissionRequest` from the UI count since the browser can't act on them — the user must respond in their terminal.

- **Session tracking**: Sessions are derived from `trackSession(sessionId, cwd)` called on every incoming hook. If the sessions map is empty on connect (server just started), `getSessions()` falls back to scanning event history for unique sessionIds (cwd will be empty until the next hook fires).

- **Type duplication**: `EventData`, `TimelineEvent`, `AnalysisResult`, and the WebSocket protocol types exist in both the server (`packages/server/src/`) and the client (`packages/web/src/lib/types.ts`, `ws-protocol.ts`). They must be kept in sync manually — there is no shared package.

- **`resolveId()` prefix matching is a range scan, not `LIKE`**: `TurnStore.lookup()` (`turns/store.ts`) resolves a prefix with `col >= prefix AND col < successor(prefix)` rather than `col LIKE 'prefix%'`. SQLite's LIKE-to-index-range-scan optimization is disabled by default whenever the pattern contains letters, because `LIKE` is case-insensitive by default and a BINARY-collated index can't satisfy that without `PRAGMA case_sensitive_like`. Since ids are opaque hex/uuid strings, a plain range comparison is both index-eligible unconditionally and the correct (case-sensitive) semantics — don't revert this to `LIKE` for readability.

- **`EventStore.setStringFilter()`**: `attachLaymans()` writes `event.laymans.explanation` directly, bypassing `EventData` and therefore the `dataFilter` PII redaction every other field gets. A separate `stringFilter` hook (wired in `server.ts` next to `setDataFilter`) redacts it at the same point. Any future field that rides outside `EventData` needs the same treatment — it will not be filtered by default.

- **Docker mounts**: The container mounts `${HOME}/.local/share/layman` (Layman's own data dir — `layman.db` and `layman.json`; see storage note below), `${HOME}/.claude` (Claude Code hooks/commands/StatusLine relay), `${HOME}/.config` (OpenCode detection/commands), `${HOME}/.vibe` (Vibe log watching), `${HOME}/Documents/Cline` (Cline hook script installation), `${HOME}/.codex` (Codex hook script installation and hooks.json), and `${HOME}/.pi` (pi extension installation). The `HookInstaller` runs inside the container and writes through these mounts to the host filesystem. **glove is not mounted by `docker-compose.yml`**: Layman and glove are independent projects that meet only when the glove extension is enabled, and someone who only uses Layman must never get a `~/.glove` folder (Docker creates a missing bind source). The glove mounts are opt-in overlays the Makefile adds only when glove's own folders already exist: `docker-compose.glove.yml` mounts `${HOME}/.glove` **read-only** for `GloveSource` and the network views, because writing into a sandbox is exactly what the feature must not do; `docker-compose.glove-control.yml` mounts `${HOME}/.glove/control` writable over it, only if it exists, so Layman can write a session's `rules.json` — and nothing else — by glove's ownership contract (`netobs/writer.ts`; never create the directory; Layman-only temp file, explicit `chmod 0644`, no chown, atomic rename). **Layman never creates, chmods or relabels anything under `~/.glove`**; anything glove needs there (folders, permissions, SELinux labels) is glove's to do, and is asked of glove through a plan in its `docs/planning/`. SELinux-enforcing hosts are unsupported for the glove integration (glove itself does not run there yet); never add `z`/`Z` to the glove mounts. The whole `~/.glove` is mounted (not just `observe/`) so Layman can read `~/.glove/registry.json` — glove's list of sessions and their grants — alongside the observe exports; session directories themselves are never mounted (see `docs/extensions/glove.md`).

- **Storage is harness-agnostic, not inside `~/.claude`** (`config/paths.ts`). Layman's SQLite
  database and runtime config are its own data, not Claude Code's — a user may run only Codex, Vibe,
  or pi and never install Claude Code. They live in an XDG data dir resolved as
  `$LAYMAN_DATA_DIR` → `$XDG_DATA_HOME/layman` → `~/.local/share/layman`. In the Linux container this
  resolves to `/root/.local/share/layman`, which docker-compose bind-mounts to the host's
  `${HOME}/.local/share/layman` — still a **host** file, never a Docker volume, so the DELETE
  journal-mode reasoning is unchanged. Historically both files lived in `~/.claude/`;
  `migrateLegacyData()` (run before `loadConfig`/`openDatabase` in `index.ts`) **copies** them to the
  new location on first launch when the new file is absent — non-destructive (originals kept as a
  backup), idempotent, and doubling as a restore path (dropping a backed-up `~/.claude/layman.db` in
  place is adopted on next launch). All recorded events are keyed by harness (`agent_type`) but never
  depend on that harness still being installed: history for a removed harness is preserved, and the
  setup-status route surfaces it as "N recorded sessions kept" via `countRecordedSessionsByAgentType`.

- **`handler.ts`'s agent-type allow-list is a required edit for every new harness.**
  `handler.ts:96-107` resolves `agent_type` through a hardcoded chain that falls through to
  `'claude-code'`. An unrecognised value is **not** an error: sessions appear, events flow, and
  everything looks fine — but the harness attribution, the auto-activate toggle and the per-client
  approval setting all quietly target the wrong client. There is no registry to add to and nothing
  fails loudly, so this is the single easiest thing to miss when adding a harness. It is the reason
  `handler.pi.test.ts` asserts `agent_type: 'pi'` resolves to `'pi'` and not to `'claude-code'`.

- **pi-specific design decisions live in `docs/harnesses/pi.md`** — why pi gets a TypeScript
  extension rather than shell hooks, why `NativePiSource` yields no root when the extension is
  installed, why tool-call blocking is opt-in and server-gated, how the live stream is bracketed,
  and what the extension awaits. The drift/blocking interaction below is the one piece that stays
  here because it is cross-cutting.

- **"Cannot block" is a kind of auto-allow, and must be handled as one everywhere.** The orange-level
  drift reminder rides back on `permissionDecisionReason`, which is only ever set on a branch that
  returns a decision. The `!canBlock` check therefore belongs in `handlePreToolUse`'s *drift* branch
  as well as in the auto-allow check below it: with it only below, a harness Layman may not block
  fell past the drift branch and returned a bare `{}`, silently discarding the reminder for exactly
  the configuration that has no other channel for it — pi with approvals off, its default. The
  extension correspondingly surfaces an allow-*with*-reason through `ctx.ui.notify` rather than
  looking only at `permissionDecision === 'deny'`.

  The same applies to a **red** level, and less obviously: `DriftMonitor.checkPreToolUse()` returns
  `shouldBlock` and `shouldRemind` as mutually exclusive *alternatives* — the red branch returns
  before the orange one is reached — so a red result on a harness Layman may not suspend matched
  neither branch and fell through to the bare auto-allow. That inverted the severity ordering: pi
  got a reminder at orange and silence at red. `handlePreToolUse` therefore demotes an unhonourable
  block to a reminder explicitly, recording the `drift_alert` the block branch would have. Losing
  the block is the point of the toggle; losing the signal never was.

- **Export to PDF is the browser's print, restyled** (`@media print` in `packages/web/src/index.css`).
  It prints light by redefining every colour token with the print theme's values (`PRINT_THEME`,
  Daylight, in `lib/themes.ts`), which `appearanceCss()` writes as an `@media print` block next to
  the screen theme: there is no second palette in `index.css`, and neither the screen theme nor
  the user's overrides reach the page. It is written by script, which is fine: without the app's script there
  is no transcript to print. A component prints correctly only if its colours come from
  `var(--…)`. A hex literal stays dark on white paper, which is how the export used to print as
  black bars (`theme-literals.test.ts` now forbids them). Two more traps: the stream's
  ancestors are made `overflow: visible` so the whole transcript prints, which requires
  `min-width: 0` on them too, or one unbreakable line widens the page to 27,000 px and it is
  clipped; and Tailwind 3 drops opacity modifiers on arbitrary variables (`bg-[var(--ok)]/10` emits
  nothing), so for a theme token use its Tailwind colour (`bg-ok/10`, see "Themes are data"), and for
  anything else `bg-[color-mix(in_srgb,var(--x)_10%,transparent)]`.
  Print layout is driven by data attributes, not body classes: `data-print-hide`, `data-print-stream`
  (the Logs transcript), `data-print-tail` / `data-print-pane` (Dashboard panes; `RecentTail` keeps
  each to its last 20 rows while printing) and `data-print-stack` (side-by-side panels print one after
  another). Print hides every button, so content collapsed behind one (a `maxLines` code block or diff,
  a Thinking block) must render in full while printing: hold a disclosure toggle in
  `usePrintExpandable()` rather than `useState(false)` (`hooks/usePrinting.ts`, which also exports
  `usePrinting()`), or the export silently truncates.

- **Themes are data** (`packages/web/src/lib/themes.ts`, pure; DOM side in `lib/theme-runtime.ts`).
  Each theme defines every colour token components use as `var(--…)`; `applyTheme()` writes the
  resolved one as an `@media screen` stylesheet, never an inline style on `<html>`, which would beat
  the print palette. `themeProblems()` is the one rule check (tests run it on every theme;
  Settings uses `themeProblemsWith`, which lays the user's overrides on the theme and drops a
  `KNOWN_PROBLEMS` exception once either of its colours is the user's): WCAG AA for text/body/muted and the status colours used as text on
  bg/raised/card, 3:1 for network colours, and `--accent`/`--accent-hot` ≥ 0.12 OKLab ΔE from that
  theme's `ok`, `warn`, `error` and severities (`--warn` means MEDIUM risk, so an accent near it
  misleads). Exceptions are named in `KNOWN_PROBLEMS` and a test fails when one goes stale. Stored
  appearance goes through `normalizeAppearance()`, so a stale config can never blank the page. Classic must equal the
  `:root` block in `index.css`; change both or neither. A canvas/SVG view that reads colours once
  depends on `useThemeVersion()` to redraw (`theme-literals.test.ts` allows reading a colour value, `readToken` or
  `getComputedStyle`, only in a component or hook that puts `useThemeVersion()` in a dependency array); an SVG or xyflow view drawn with `var(--…)` needs nothing. A new token goes in `TOKENS`, every theme and `:root`.
  Tailwind's colours are generated from `TOKENS` (`lib/tokens.ts`, import-free because the
  Tailwind config loads it in Node): each is its `var(--…)`, and at an opacity a `color-mix`, so
  `bg-ok/10` and `bg-ok/[35%]` work, unlike `bg-[var(--ok)]/10`, which Tailwind 3 drops (a test
  fails on that form). `font-sans`, `font-ui` and `font-mono` follow `--font-ui` / `--font-mono`.
  Mind the names: `bg-bg-code` is the code background, `bg-code` paints with the code *text* colour.
  No component, `lib` file or stylesheet holds a colour literal (`theme-literals.test.ts` fails on
  any hex or non-black `rgb()` outside `themes.ts` and `index.css`'s `:root` blocks; black stays
  allowed for shadows and scrims). In a style, an SVG attribute or a table, use `var(--…)` or
  `tokenColor(token, '15%')` (`lib/tokens.ts`, the same helper the Tailwind config uses); colour
  tables such as `lib/event-styles.ts` hold token names. A canvas cannot read `var()`: resolve with
  `readToken()` and redraw on `useThemeVersion()` (the Minimap does). A shade between two tokens is
  a `color-mix` of them (the network alarm's `ALARM` mixes `--error` with `--text`, and
  `alarm.test.ts` holds it to AA in every theme), never a new hex. A hover on a filled button mixes
  the fill toward `--text` (`hover:bg-[color-mix(in_srgb,var(--ok)_85%,var(--text))]`), never
  `/85`, which lightens it under `--text-on-fill` in a light theme.
  The choice is the config's `appearance` block (`AppearanceSchema` in the server's
  `config/schema.ts`; it replaced the old top-level `theme`, which `migrateTheme` reads once:
  dark → classic, light → daylight). The server mirrors the theme ids, choices and defaults, and a
  web test (`appearance-config.test.ts`) fails when the copies differ: a new theme goes in both. A
  stored value the server does not know falls back to its default field by field (a stale
  `layman.json` must never stop startup), but an *update* holding one is dropped
  (`validAppearanceUpdate`), keeping the current choice. `appearance` is deep-merged like `sync`,
  except `overrides`, which is kept per theme (`{ classic: { bg: … }, daylight: { … } }`) so a colour
  chosen for one theme never lands on another (under Follow the OS both halves show). An update
  replaces each theme it names whole, so one colour can be removed and `{}` clears the theme; a
  theme's map with any bad entry is dropped whole (keeping that theme's current map), or it would
  wipe the others. Config sources (`mergeAppearance`) take `overrides` whole from the highest that holds
  an overrides object, even `{}`, never per theme, or colours cleared in Settings would return from a
  lower source. Rule breaks in overrides are listed in Settings (`themeProblems`), never refused. Updates are never migrated: a
  stale tab sending its old config (`theme: 'dark'`) must not overwrite the choice. `useAppearance()` applies
  it on every `session:config` and remembers it in `localStorage`, which `main.tsx` applies at load
  so a non-default theme does not flash Classic first. Settings → Appearance (`AppearanceSection`) only sends config updates; it never
  applies a theme itself, so every tab changes from the same `session:config`. Each stylesheet block
  sets its theme's `color-scheme`. Motion is applied as `html[data-motion]` (`index.css`), already
  capped by the OS's reduced-motion setting; code that animates itself (eased scrolling,
  `scrollIntoView`) asks `motionIsFull()` / `scrollBehavior()` (`theme-runtime.ts`), never
  `prefers-reduced-motion`, or Off would not stop it. Spacing, corners and lines follow
  the appearance: Tailwind's padding/margin/gap/space and `rounded*` scales and `border` width are
  scaled in `tailwind.config.ts`, and an inline style writes `sp(8)` / `sp('4px 8px')` and `rad(6)`
  (`lib/density.ts`) and `var(--stroke)` for a 1px line, never a bare px value
  (`density-literals.test.ts` fails on one). The numbers in the code are the Compact design (the
  default, `--density: 1`; Comfortable is 1.3) and Classic's 6px corners (`--radius-scale` is the
  theme's radius over 6). Not yet covered: px values in component `.css` files, SVG geometry.

- **One tab order, one arrow-key rule.** `headerTabs()` (`lib/header-tabs.ts`, pure) is the only list of header tabs: the Header renders it and ←/→ walk it (`currentTabIndex`, `neighbourTab`), so they cannot disagree. `arrowKeysFree()` (`lib/arrow-keys.ts`) is the only rule for when a global arrow handler may act (not while typing, not with a modifier, not in a dialog, not inside `[data-own-arrows]` or an ARIA widget role); a component that uses arrows while it has focus marks itself `data-own-arrows`. Logs moved from ←/→ to ↑/↓ for this reason.

- **Auto-activate**: The `autoActivateClients` config array (in `~/.local/share/layman/layman.json`) lists client agent types (e.g. `'claude-code'`) whose sessions should auto-activate without requiring `/layman`. When a hook event arrives from a matching agent, `handler.ts` calls `gate.activate()` before the gate check, so events flow immediately. The toggle is in Settings → Client Setup on each client's row. Off by default.

- **Duplicate prompts are collapsed at extraction time, not deleted from the DB**: the hook
  double-registration bug (below) recorded ~800 `user_prompt` rows twice, and those rows are still
  in `layman.db`. `extractTurns()` treats a `user_prompt` whose trimmed text matches the
  open turn's and lands within `DUPLICATE_PROMPT_WINDOW_MS` (1 s) as the same prompt, absorbing it
  into that turn. The window is measured, not guessed: 741 same-text pairs are <100 ms apart, 794
  within 1 s, and then nothing until 1 s+ (20 in 1 s–1 min, 34 beyond) which are genuine re-sends.
  Without this, each duplicate opens a phantom empty turn that owns the *previous* turn's trailing
  `agent_response` — the `Stop` hook races the next `UserPromptSubmit` — which mis-pairs the
  transcript, exports and TTS alike. Collapsing rather than backfilling keeps history intact and
  fixes every consumer at once. **The window must stay identical in `extract.ts` and `turns.ts`** or
  client and server disagree about how many turns a session has. `extractTurn()` / `TurnStore.getTurn()`
  still resolve a collapsed duplicate's id to the surviving turn, so links minted before the fix work.

- **History enrichment must never touch a session recorded live** (`recovery.ts`). `importSession()`
  is idempotent only in the sense that `INSERT OR IGNORE` dedupes on *id*, and the two producers do
  not agree on ids: live events get `randomUUID()` (`events/store.ts`) while every transcript parser
  mints a deterministic id from the file. Re-parsing a live-recorded session therefore inserts a
  second full copy of it rather than enriching it. The harnesses with a `parseAfter` cutoff escape
  this only incidentally — the cutoff excludes what is already recorded — which is not a property to
  build on, so the whole-file fallback both skips `source === 'live'` sessions and filters against
  the recorded ids explicitly. A test that seeds "live" events using the *parser's* ids proves
  nothing; it hands the upsert something to collide with and hides the bug.

  Two harness-specific enrichment details moved out of this file: how a resume/fork transcript is
  keyed by the session id in its contents rather than its filename (claude-code) is in
  `docs/harnesses/claude-code.md`, and how history import discovers glove pi sessions is in
  `docs/extensions/glove.md`.

- **`toolFilePath()` takes an optional `toolName` because `path` is overloaded** (`events/tool-input.ts`,
  mirrored in the web copy). pi names its file argument `path`, and claude-code's `Grep`/`Glob` use
  the same key for the directory to *search*. With `path` outranking `pattern`, every search in a
  session summarised as the same repository root — in Logs rows, the dashboard tail, `EventCard` and
  the markdown export — and the `pattern` fallback below it was unreachable. Pass `toolName` at any
  call site that renders a summary. Access tracking does not need it: `extractAccess()` switches on
  the tool name and handles `Grep`/`Glob` explicitly.

- **Never register a claude-code hook that *replaces* harness behaviour.** `WorktreeCreate` and
  `WorktreeRemove` look like notifications but take over git worktree handling, so Layman's
  observe-only hooks broke worktree creation. They are in `RETIRED_HOOK_EVENTS` and removed on every
  server start; check the hook reference before adding any new event. Detail in
  `docs/harnesses/claude-code.md`.

- **Claude Code hook & StatusLine design decisions live in `docs/harnesses/claude-code.md`** —
  structural (not tagged) hook identity and self-healing idempotent install, per-matcher hook
  removal, orphaned project-level hooks (`layman repair-hooks`), the single-slot StatusLine
  composition, `session_metrics` routing, and partial-payload handling.

- **Drift monitoring design**: Drift scores use EMA smoothing (alpha 0.3) so a single LLM spike doesn't trigger alerts. Blocking at red level reuses `PendingApprovalManager` (same as tool approval). The two algorithms run in parallel via `Promise.all`. Cumulative prompt scope means every user message expands the session goal — only agent-initiated scope creep counts as drift. Per-item false-positive dismissals are injected into the LLM prompt to prevent re-flagging without resetting scores.

- **SQLite runs in `journal_mode = DELETE`, not WAL** (`db/database.ts`). `~/.local/share/layman/layman.db`
  is a *bind mount* into the container, and on macOS that is FUSE-backed (virtiofs / gRPC-FUSE). WAL needs
  an mmap-coordinated `-shm` file and correct cross-process advisory locks, neither of which such a
  mount reliably provides — it is a documented way to corrupt a database. This is not hypothetical:
  on 2026-08-05 the database was found malformed (`btreeInitPage()` error 11 on two `recorded_events`
  pages, three indexes with wrong entry counts) and was rebuilt with `sqlite3 .recover`, losing zero
  rows. DELETE mode costs write concurrency Layman does not use — one writer process, one small row
  per hook event. WAL would be safe and faster on a *native* install; detect that before switching
  back rather than assuming WAL is the better default.

- **TTS goes through a Layman proxy, not straight to speaches**: speaches only installs
  `CORSMiddleware` when `allow_origins` is configured (`main.py:182`), so a browser `fetch()` from
  the Layman origin to `http://localhost:8000/v1/audio/speech` is blocked out of the box. The proxy
  also keeps speaches' optional `api_key` out of client code. `tts.direct` bypasses it for users who
  have set `allow_origins` — that is the exception, not the default. Don't "simplify" this away.

- **Speech rate needs two controls because speaches has no pitch parameter**: its request body
  (`routers/speech.py:53`) accepts `speed` but nothing else rate-related. `speed` goes upstream and
  changes tempo with pitch preserved; `playbackRate` on the `HTMLAudioElement`, with
  `preservesPitch: false`, is the *only* way to pitch-shift. Both are exposed deliberately.
  The speed **slider** is capped at 0.5–2.0 (speaches rejects anything outside that with a 422)
  while the **schema** stays 0.25–4, since other backends differ.

- **The autoplay block is a state, not an error**: browsers refuse programmatic `play()` until the
  page has been interacted with, which is exactly how a `?play=1` link opened in a fresh tab
  arrives. `TtsPlayer` catches the rejection, sets `blocked`, and **keeps the utterance at the head
  of the queue** so `resume()` from a click plays it without re-synthesising. `error` stays null —
  it is a prompt ("Enable audio" in the TTS bar), not a failure.

- **Speech is strictly serial and deduplicated by event id**: two overlapping voices convey nothing.
  Everything queues FIFO, and the id doubles as the dedupe key so a re-render cannot double-queue.
  A `generation` counter guards the async gap: a `stop()` during synthesis must not produce a
  delayed utterance when the fetch finally resolves.

- **A reported speech error survives the next utterance starting.** `pump()` deliberately does not
  clear `error` — doing so erases the only report of why the last utterance failed, usually before
  it has been on screen long enough to read. It is cleared by `stop()`, `skip()`, `resume()`, or the
  bar's dismiss button.

- **`tts-text.ts` does not strip emoji or markdown emphasis**: speaches already runs
  `strip_emojis()` and `strip_markdown_emphasis()` on its input. Duplicating that here would be a
  second copy of someone else's rule that rots the moment they change theirs. What it *does* strip
  is the structural noise speaches leaves alone — fenced code, link URLs, headings, tables, HTML.

- **Auto-speak marks events seen even while it is switched off** (`useTTS.ts`). Otherwise enabling
  the toggle flushes every response accumulated since the page loaded — observed as a 12-utterance
  backlog before the fix. The `mountedAt` cutoff separately stops the WebSocket's 100-event replay
  from being read aloud on every page load.

- **`'final'` debounces rather than waiting for `Stop`**: an agent emits several interstitial
  messages between tool calls and only the last is the answer, but not every harness gives a
  reliable end-of-turn signal. A 2 s quiet period means the same thing and works across all five.

### Hook installer (`packages/server/src/hooks/installer.ts`)

Manages installation of hooks, slash commands, and the StatusLine relay for all supported clients. Key methods:
- `install()` — writes Claude Code global hooks and StatusLine relay to `~/.claude/settings.json`
- `installCommand()` — writes the `/layman` slash command to `~/.claude/commands/layman.md`
- `installStatusLine()` — writes the StatusLine relay script to `~/.claude/hooks/layman/statusline.sh` and sets `statusLine.command` in settings.json. If an existing statusLine command is present, composes with it (chains both).
- `uninstallStatusLine()` — removes the relay script and restores any previously configured statusLine command
- `installClient(id)` — installs a single client by id (`'claude-code'` | `'codex'` | `'opencode'` | `'mistral-vibe'` | `'cline'` | `'pi'`)
- `uninstallClient(id)` — removes integration files for a single client
- `installOptionalClientCommands(clientId?)` — installs the `/layman` command for detected optional clients; pass a `clientId` to restrict to one
- `installCodexHooks()` — writes bash hook scripts to `~/.codex/hooks/layman/` and merges entries into `~/.codex/hooks.json`
- `installClineHooks()` — writes bash hook scripts to `~/Documents/Cline/Hooks/` with `__LAYMAN_URL__` templated in
- `getStatus()` — returns installation state for all clients including StatusLine (used by the Settings UI); caller is responsible for merging `declinedClients` from config into the returned `SetupStatus`
- `uninstall()` — removes Claude Code hooks, command file, and StatusLine relay
- `isInstalled()` — returns true if Claude Code hooks are present

Each optional client has an `id` field (`'codex'`, `'opencode'`, `'mistral-vibe'`, `'cline'`, `'pi'`) used as the key in `declinedClients` config and in API routes. Optional clients are detected by checking whether their config directories exist on the host filesystem, plus a `signalFiles` check so an empty directory created by a Docker bind mount is not mistaken for an install.

Two `OptionalClient` fields exist for pi and are worth knowing before adding a client:
- `tagStyle: 'line'` — every installed file gets a trailing `layman:<hash>` version tag, normally an HTML comment. That is a **syntax error in a TypeScript file**, which pi's extension is, so those emit `// layman:<hash>` instead. `getStatus()` matches the substring and is indifferent to the wrapper.
- `getContent(options)` receives the installer options rather than nothing, so a client whose integration *embeds* configuration (pi bakes in both the server URL and the approval timeout) produces content that changes with it. That makes the content hash sensitive to those settings, so an install left pointing at an old URL reports as out of date instead of silently green.

**Installation is opt-in.** The server does not auto-install on startup. On first dashboard visit, a modal lists all detected-but-unintegrated clients with toggles (default off); the user selects which to install and clicks **Accept**. Toggled-off clients are saved as `declinedClients` in `~/.local/share/layman/layman.json` and won't be offered again until the user clicks **Install** from Settings. Install/Uninstall is also available per-client in **Settings → Client Setup**.

Setup API routes (all in `server.ts`):
- `GET /api/setup/status` — returns `SetupStatus` with per-client `declined` flags merged from config
- `POST /api/setup/install` — installs selected clients (`{ clients?: string[] }`); installs all if omitted
- `POST /api/setup/install/:client` — installs a single client, removes it from `declinedClients`
- `POST /api/setup/uninstall/:client` — uninstalls a single client
- `POST /api/setup/decline` — adds clients to `declinedClients` config (`{ clients: string[] }`)
- `POST /api/setup/undecline/:client` — removes a client from `declinedClients` without installing

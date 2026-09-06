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
extension, not a harness — is documented in **`docs/extensions/glove.md`**. Keep harness- and
glove-specific detail in those files; this file keeps only the shared pipeline and cross-cutting
decisions, with pointers.

### How data flows

Each harness reaches Layman by a different mechanism. The summaries below are the shared pipeline;
per-harness event lists, blocking timeouts, and implementation/design notes are in the harness docs
linked above.

1. **Claude Code** (`docs/harnesses/claude-code.md`): HTTP POSTs to `/hooks/:eventName` (26
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
   per-format watcher). `NativeVibeSource`, `NativePiSource`, and `GloveSource` implement it; each of
   the two passive watchers (`VibeSessionWatcher`, `PiSessionWatcher`) filters `roots()` down to the
   agent type it parses, so the single shared `GloveSource` instance feeds both. A future passive
   harness adds a source plus a watcher and nothing else changes. Glove specifics:
   `docs/extensions/glove.md`.

4c. **pi passive watcher** (`packages/server/src/pi/watcher.ts`): tails pi's format-version-3 JSONL
   transcripts for glove-sandboxed pi (which cannot reach Layman over the network) and native pi with
   no live extension. Design and reliability notes (why it never emits a trailing `tool_call_pending`,
   dedupe by committed id, tombstone resurrection) are in `docs/harnesses/pi.md`.

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

10. **PII filter** (`packages/server/src/pii/filter.ts`) — regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.). Applied at the EventStore level so all events are covered regardless of source.

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
?view=dashboard|logs|prompts|flow|sessions   ?play=1   ?t=<ms>
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
`sync.role` is `standalone` (default) | `central` | `remote`. Full design in
[`docs/planning/multi-host-sync.md`](docs/planning/multi-host-sync.md); user-facing summary in
[`docs/features.md`](docs/features.md#multi-host-sync). The pieces live in `packages/server/src/sync/`
(`identity`, `state`, `entities`, `journal`, `tokens`, `applier`, `pusher`, `puller`, `presence`,
`stats`, `routes`, `protocol`), wired from `server.ts` by `reconcileSync()` on config change.

Four rules that must not be relaxed casually:

- **The journal is written by SQLite triggers, never by application code** (§3.4, migration 2 in
  `db/database.ts`). Every recorded-data write — the recorder, bookmark/highlight stores, the raw
  `UPDATE`s in `server.ts` and `pii/purge.ts` — is captured into `sync_log` by `AFTER
  INSERT/UPDATE/DELETE` triggers. A new recorded-data write site therefore needs no instrumentation,
  but a new *table* worth syncing needs a trigger plus a `SYNC_ENTITIES` entry. A session delete
  journals one cascade row, not one per event.

- **Remote data never goes through `EventStore`** (§3.8). `SyncApplier` writes straight through the
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

### Key design decisions

- **Blocking hooks**: `PreToolUse` and `PermissionRequest` (Claude Code) and `PreToolUse` (Cline) suspend the agent process until `PendingApprovalManager.resolveApproval()` is called. Claude Code's timeout is 300s (configurable); Cline's is 25s (Cline hardcodes 30s).

- **`permission_request` vs `tool_call_pending`**: Both create pending approvals server-side (needed for blocking), but `usePendingApprovals` filters out `PermissionRequest` from the UI count since the browser can't act on them — the user must respond in their terminal.

- **Session tracking**: Sessions are derived from `trackSession(sessionId, cwd)` called on every incoming hook. If the sessions map is empty on connect (server just started), `getSessions()` falls back to scanning event history for unique sessionIds (cwd will be empty until the next hook fires).

- **Type duplication**: `EventData`, `TimelineEvent`, `AnalysisResult`, and the WebSocket protocol types exist in both the server (`packages/server/src/`) and the client (`packages/web/src/lib/types.ts`, `ws-protocol.ts`). They must be kept in sync manually — there is no shared package.

- **`resolveId()` prefix matching is a range scan, not `LIKE`**: `TurnStore.lookup()` (`turns/store.ts`) resolves a prefix with `col >= prefix AND col < successor(prefix)` rather than `col LIKE 'prefix%'`. SQLite's LIKE-to-index-range-scan optimization is disabled by default whenever the pattern contains letters, because `LIKE` is case-insensitive by default and a BINARY-collated index can't satisfy that without `PRAGMA case_sensitive_like`. Since ids are opaque hex/uuid strings, a plain range comparison is both index-eligible unconditionally and the correct (case-sensitive) semantics — don't revert this to `LIKE` for readability.

- **`EventStore.setStringFilter()`**: `attachLaymans()` writes `event.laymans.explanation` directly, bypassing `EventData` and therefore the `dataFilter` PII redaction every other field gets. A separate `stringFilter` hook (wired in `server.ts` next to `setDataFilter`) redacts it at the same point. Any future field that rides outside `EventData` needs the same treatment — it will not be filtered by default.

- **Docker mounts**: The container mounts `${HOME}/.local/share/layman` (Layman's own data dir — `layman.db` and `layman.json`; see storage note below), `${HOME}/.claude` (Claude Code hooks/commands/StatusLine relay), `${HOME}/.config` (OpenCode detection/commands), `${HOME}/.vibe` (Vibe log watching), `${HOME}/Documents/Cline` (Cline hook script installation), `${HOME}/.codex` (Codex hook script installation and hooks.json), and `${HOME}/.pi` (pi extension installation). The `HookInstaller` runs inside the container and writes through these mounts to the host filesystem. `${HOME}/.glove/envs` is also mounted **read-only** (`:ro`) for `GloveSource` — it is the one mount Layman only ever reads, never writes, because writing into a sandbox is exactly what the feature must not do.

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

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

# Docker workflow (primary way to run Layman against a real session)
make docker-stop docker-build docker-run   # rebuild and restart
make docker-logs                           # follow container logs
make docker-status                         # check container state
```

After any server or web change, you must rebuild the Docker image for changes to take effect — the container runs from built artifacts, not source.

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

### How data flows

1. **Claude Code hooks**: Claude Code fires HTTP POSTs to `/hooks/:eventName`. Layman registers for 26 claude-code hook events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `SessionStart`, `SessionEnd`, `Stop`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `StopFailure`, `PreCompact`, `PostCompact`, `Elicitation`, `ElicitationResult`, `Setup`, `ConfigChange`, `InstructionsLoaded`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `FileChanged`. (`PermissionDenied` requires claude-code ≥ 2.1.89 and is not yet registered.) The hook handler in `packages/server/src/hooks/handler.ts` processes each event type, calls `EventStore.add()`, and for blocking hooks (`PreToolUse`, `PermissionRequest`) calls `PendingApprovalManager.createAndWait()` which suspends until the user decides.

1b. **Claude Code StatusLine**: A separate data channel from hooks. Layman installs a relay script (`~/.claude/hooks/layman/statusline.sh`) that receives JSON on stdin after every assistant turn (debounced 300ms by claude-code) and POSTs it to `/hooks/StatusLine`. This carries session metrics unavailable through hooks: cumulative cost, token counts, context window fill %, rate limits, model info, and lines changed. The handler creates `session_metrics` events which are stored in a dedicated per-session map (not the timeline) and displayed in the `SessionMetricsBar` component. If the user has an existing `statusLine` command, the relay script chains to it (preserving their status bar text).

2. **Codex hooks** (`packages/server/hooks/codex/`): Codex reads hook config from `~/.codex/hooks.json` and runs shell scripts from `~/.codex/hooks/layman/`. These scripts read hook JSON from stdin, inject `agent_type: "codex"`, and POST to the existing `/hooks/:eventName` handler via curl. The hook format is Claude Code-compatible — same field names and event names — so no separate handler is needed. `PreToolUse` blocks for up to 58 seconds. The `Stop` hook payload includes `last_assistant_message` which the handler uses to emit the agent's final response. Sessions activate when the user types `@layman` — detected via `UserPromptSubmit` hook before the gate check. Codex supports 5 hook events: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`. Async hooks are not supported by Codex.

3. **Cline hooks** (`packages/server/src/cline/`): Cline runs bash scripts from `~/Documents/Cline/Hooks/` that pipe JSON stdin to `POST /hooks/cline/:hookName`. The Cline handler (`handler.ts`) translates Cline's field/tool-name format to Layman's internal types via a translator (`translator.ts`), then reuses the same event pipeline. PreToolUse blocks for up to 25 seconds (Cline's hardcoded limit is 30s). Sessions require `/layman` activation, tracked by workspace directory (cwd) so activation survives Plan/Act mode switches.

4. **Mistral Vibe watcher** (`packages/server/src/vibe/watcher.ts`): Polls `~/.vibe/logs/session/<dir>/messages.jsonl` every 2 seconds from a tracked byte offset. Translates Vibe's JSONL message format to Layman events. Sessions require `/layman` activation; sessions idle for 15+ minutes are treated as ended. Sessions within a 5-minute replay window are read from the beginning.

5. **OpenCode plugin** (`packages/opencode-plugin`): A bidirectional plugin that receives events from OpenCode and can send prompts back. Registered in `~/.config/opencode/opencode.json`.

6. **EventStore** (`packages/server/src/events/store.ts`) — in-memory, max 10,000 events, emits `event:new` / `event:update` / `sessions:changed`. Also tracks active sessions (sessionId → cwd) via `trackSession()`. Events passing through the store are automatically scanned by the PII filter before storage.

7. **Session recording** (`packages/server/src/db/`) — SQLite database (`~/.claude/layman.db`, see `db/database.ts`) records all events for history and full-text search. Search uses SQLite FTS5 with a custom query parser supporting `+required`, `-excluded`, and `"quoted phrases"` operators.

8. **WebSocket** (`/ws`): On connect, server replays the last 100 events, all pending approvals, config, and current sessions list. After that, all changes are pushed as typed `ServerMessage` frames. The protocol is defined in `packages/server/src/types/index.ts` (server) and mirrored in `packages/web/src/lib/ws-protocol.ts` (client) — keep these in sync when adding message types.

9. **Analysis engine** (`packages/server/src/analysis/engine.ts`) — wraps Anthropic or OpenAI-compatible providers, supports `analyze()` (structured JSON → `AnalysisResult`) and `ask()` (free-form Q&A). Both return `{ text/result, tokens: { input, output }, latencyMs, model }`. Max 3 concurrent requests with a queue.

10. **PII filter** (`packages/server/src/pii/filter.ts`) — regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.). Applied at the EventStore level so all events are covered regardless of source.

11. **Client state** — Zustand store in `packages/web/src/stores/sessionStore.ts` holds all events, pending approvals, sessions list, active session filter, and investigation state. The `useEventStore()` hook at `packages/web/src/hooks/useEventStore.ts` applies session + UI filters on top.

12. **Drift monitoring** (`packages/server/src/drift/`) — Tracks two drift dimensions per session: *session goal drift* (is the agent still doing what the user asked?) and *rules drift* (is the agent following CLAUDE.md / AGENTS.md rules?). `DriftMonitor` accumulates user prompts and tool calls in a ring buffer, periodically sends them to the analysis engine (`assessDrift`), and EMA-smooths the returned percentage (alpha 0.3). Results map to four color levels via configurable thresholds (green/yellow/orange/red). At orange, `checkPreToolUse()` returns a reminder injected into the agent context; at red it can block via `PendingApprovalManager`. Individual drift findings can be dismissed as false positives — dismissed items are injected back into the LLM prompt to prevent re-flagging. State is broadcast to the web client via `drift:update` WebSocket messages and displayed in `DriftMonitorPanel` (dashboard) and `DriftBlockDialog` (blocking modal). Rules drift reads both `CLAUDE.md` (Claude Code / Cline) and `AGENTS.md` (other harnesses) via the `InstructionsLoaded` hook.

### Turns and addressable URLs

A **turn** is one `user_prompt` plus every event it owns up to (but not including) the next
`user_prompt`, and its response is the *last* `agent_response` in that window — an agent emits
several interstitial messages between tool calls, and the final one is the answer.

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

### Key design decisions

- **Blocking hooks**: `PreToolUse` and `PermissionRequest` (Claude Code) and `PreToolUse` (Cline) suspend the agent process until `PendingApprovalManager.resolveApproval()` is called. Claude Code's timeout is 300s (configurable); Cline's is 25s (Cline hardcodes 30s).

- **`permission_request` vs `tool_call_pending`**: Both create pending approvals server-side (needed for blocking), but `usePendingApprovals` filters out `PermissionRequest` from the UI count since the browser can't act on them — the user must respond in their terminal.

- **Session tracking**: Sessions are derived from `trackSession(sessionId, cwd)` called on every incoming hook. If the sessions map is empty on connect (server just started), `getSessions()` falls back to scanning event history for unique sessionIds (cwd will be empty until the next hook fires).

- **Cline cwd-keyed activation**: Cline may change its `taskId` when switching Plan/Act modes while keeping the same workspace. Layman tracks activated workspace directories (`activatedCwds` Set in `cline/handler.ts`) so new taskIds in an already-activated workspace auto-activate without requiring `/layman` again.

- **Vibe session end detection**: Vibe sets `end_time` on every `save_interaction()` call (not just on close), so `end_time` is not a reliable signal. Sessions are instead considered ended after 15 minutes of log file inactivity.

- **Cline agent responses**: Cline routes all final AI responses through the `attempt_completion` tool. Layman captures the `result` parameter from `PostToolUse(attempt_completion)` and emits it as an `agent_response` event.

- **Type duplication**: `EventData`, `TimelineEvent`, `AnalysisResult`, and the WebSocket protocol types exist in both the server (`packages/server/src/`) and the client (`packages/web/src/lib/types.ts`, `ws-protocol.ts`). They must be kept in sync manually — there is no shared package.

- **Docker mounts**: The container mounts `${HOME}/.claude` (Claude Code hooks/commands/StatusLine relay), `${HOME}/.config` (OpenCode detection/commands), `${HOME}/.vibe` (Vibe log watching), `${HOME}/Documents/Cline` (Cline hook script installation), and `${HOME}/.codex` (Codex hook script installation and hooks.json). The `HookInstaller` runs inside the container and writes through these mounts to the host filesystem.

- **Auto-activate**: The `autoActivateClients` config array (in `~/.claude/layman.json`) lists client agent types (e.g. `'claude-code'`) whose sessions should auto-activate without requiring `/layman`. When a hook event arrives from a matching agent, `handler.ts` calls `gate.activate()` before the gate check, so events flow immediately. The toggle is in Settings → Client Setup on each client's row. Off by default.

- **Duplicate prompts are collapsed at extraction time, not deleted from the DB**: the hook
  double-registration bug (below) recorded ~800 `user_prompt` rows twice, and those rows are still
  in `~/.claude/layman.db`. `extractTurns()` treats a `user_prompt` whose trimmed text matches the
  open turn's and lands within `DUPLICATE_PROMPT_WINDOW_MS` (1 s) as the same prompt, absorbing it
  into that turn. The window is measured, not guessed: 741 same-text pairs are <100 ms apart, 794
  within 1 s, and then nothing until 1 s+ (20 in 1 s–1 min, 34 beyond) which are genuine re-sends.
  Without this, each duplicate opens a phantom empty turn that owns the *previous* turn's trailing
  `agent_response` — the `Stop` hook races the next `UserPromptSubmit` — which mis-pairs the
  transcript, exports and TTS alike. Collapsing rather than backfilling keeps history intact and
  fixes every consumer at once. **The window must stay identical in `extract.ts` and `turns.ts`** or
  client and server disagree about how many turns a session has. `extractTurn()` / `TurnStore.getTurn()`
  still resolve a collapsed duplicate's id to the surviving turn, so links minted before the fix work.

- **Hook identity is structural, not tagged**: `buildLaymanHooks()` writes `_layman: true`, but **claude-code strips unknown keys when it rewrites `settings.json`**, so the tag does not survive and cannot be relied on. `isLaymanHook()` therefore matches on URL *shape* — any `{origin}/hooks/{KnownLaymanEvent}` — rather than on the tag or on the configured `serverUrl`. This matters because matching `serverUrl` alone meant that any URL change (port, `--hook-url`, `localhost` vs `host.docker.internal`) stopped matching the old entries and **appended a duplicate hook set**, causing every event to fire twice. Structural matching makes `install()` idempotent and self-healing across URL changes.

- **Hook removal filters within matchers**: `stripLaymanHooks()` removes individual hook entries rather than dropping whole matcher objects, so a matcher holding both a Layman hook and a user's own hook does not take the user's hook down with it.

- **Project-level hooks are orphans**: Layman has installed globally (`~/.claude/settings.json`) since the multi-project change; claude-code merges any project-level `.claude/settings.local.json` hooks *on top of* the global set, so leftovers from before that change double every event. `findOrphanedProjectHooks()` / `repairOrphanedProjectHooks()` detect and remove them, scoped strictly to a named directory. Exposed as **`layman repair-hooks [dir] [--dry-run]`** — a CLI command rather than an HTTP route, because the Docker container mounts only `~/.claude` and friends and cannot see a project's `.claude` directory. The `GET /api/setup/orphaned-hooks` / `POST /api/setup/repair-hooks` routes exist for native (non-Docker) installs and are restricted to directories Layman is actively tracking.

- **StatusLine is a single slot**: Claude-code's `statusLine` config accepts exactly one command. If the user already has a custom statusLine, the installer composes by setting `LAYMAN_ORIGINAL_STATUSLINE` in the relay script and piping input to both. Uninstall restores the original command.

- **`session_metrics` events**: StatusLine events fire after every assistant turn (high frequency). They are routed to a dedicated `sessionMetrics: Map<sessionId, SessionMetrics>` in the Zustand store rather than the timeline events array, to avoid flooding the timeline. The `SessionMetricsBar` component reads this map.

- **Drift monitoring design**: Drift scores use EMA smoothing (alpha 0.3) so a single LLM spike doesn't trigger alerts. Blocking at red level reuses `PendingApprovalManager` (same as tool approval). The two algorithms run in parallel via `Promise.all`. Cumulative prompt scope means every user message expands the session goal — only agent-initiated scope creep counts as drift. Per-item false-positive dismissals are injected into the LLM prompt to prevent re-flagging without resetting scores.

- **SQLite runs in `journal_mode = DELETE`, not WAL** (`db/database.ts`). `~/.claude/layman.db` is a
  *bind mount* into the container, and on macOS that is FUSE-backed (virtiofs / gRPC-FUSE). WAL needs
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
- `installClient(id)` — installs a single client by id (`'claude-code'` | `'codex'` | `'opencode'` | `'mistral-vibe'` | `'cline'`)
- `uninstallClient(id)` — removes integration files for a single client
- `installOptionalClientCommands(clientId?)` — installs the `/layman` command for detected optional clients; pass a `clientId` to restrict to one
- `installCodexHooks()` — writes bash hook scripts to `~/.codex/hooks/layman/` and merges entries into `~/.codex/hooks.json`
- `installClineHooks()` — writes bash hook scripts to `~/Documents/Cline/Hooks/` with `__LAYMAN_URL__` templated in
- `getStatus()` — returns installation state for all clients including StatusLine (used by the Settings UI); caller is responsible for merging `declinedClients` from config into the returned `SetupStatus`
- `uninstall()` — removes Claude Code hooks, command file, and StatusLine relay
- `isInstalled()` — returns true if Claude Code hooks are present

Each optional client has an `id` field (`'codex'`, `'opencode'`, `'mistral-vibe'`, `'cline'`) used as the key in `declinedClients` config and in API routes. Optional clients are detected by checking whether their config directories exist on the host filesystem.

**Installation is opt-in.** The server does not auto-install on startup. On first dashboard visit, a modal lists all detected-but-unintegrated clients with toggles (default off); the user selects which to install and clicks **Accept**. Toggled-off clients are saved as `declinedClients` in `~/.claude/layman.json` and won't be offered again until the user clicks **Install** from Settings. Install/Uninstall is also available per-client in **Settings → Client Setup**.

Setup API routes (all in `server.ts`):
- `GET /api/setup/status` — returns `SetupStatus` with per-client `declined` flags merged from config
- `POST /api/setup/install` — installs selected clients (`{ clients?: string[] }`); installs all if omitted
- `POST /api/setup/install/:client` — installs a single client, removes it from `declinedClients`
- `POST /api/setup/uninstall/:client` — uninstalls a single client
- `POST /api/setup/decline` — adds clients to `declinedClients` config (`{ clients: string[] }`)
- `POST /api/setup/undecline/:client` — removes a client from `declinedClients` without installing

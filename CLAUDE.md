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

7. **Session recording** (`packages/server/src/db/`) — SQLite database (`~/.local/share/layman/layman.db`) records all events for history and full-text search. Search uses SQLite FTS5 with a custom query parser supporting `+required`, `-excluded`, and `"quoted phrases"` operators.

8. **WebSocket** (`/ws`): On connect, server replays the last 100 events, all pending approvals, config, and current sessions list. After that, all changes are pushed as typed `ServerMessage` frames. The protocol is defined in `packages/server/src/types/index.ts` (server) and mirrored in `packages/web/src/lib/ws-protocol.ts` (client) — keep these in sync when adding message types.

9. **Analysis engine** (`packages/server/src/analysis/engine.ts`) — wraps Anthropic or OpenAI-compatible providers, supports `analyze()` (structured JSON → `AnalysisResult`) and `ask()` (free-form Q&A). Both return `{ text/result, tokens: { input, output }, latencyMs, model }`. Max 3 concurrent requests with a queue.

10. **PII filter** (`packages/server/src/pii/filter.ts`) — regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.). Applied at the EventStore level so all events are covered regardless of source.

11. **Client state** — Zustand store in `packages/web/src/stores/sessionStore.ts` holds all events, pending approvals, sessions list, active session filter, and investigation state. The `useEventStore()` hook at `packages/web/src/hooks/useEventStore.ts` applies session + UI filters on top.

12. **Drift monitoring** (`packages/server/src/drift/`) — Tracks two drift dimensions per session: *session goal drift* (is the agent still doing what the user asked?) and *rules drift* (is the agent following CLAUDE.md rules?). `DriftMonitor` accumulates user prompts and tool calls in a ring buffer, periodically sends them to the analysis engine (`assessDrift`), and EMA-smooths the returned percentage (alpha 0.3). Results map to four color levels via configurable thresholds (green/yellow/orange/red). At orange, `checkPreToolUse()` returns a reminder injected into the agent context; at red it can block via `PendingApprovalManager`. Individual drift findings can be dismissed as false positives — dismissed items are injected back into the LLM prompt to prevent re-flagging. State is broadcast to the web client via `drift:update` WebSocket messages and displayed in `DriftMonitorPanel` (dashboard) and `DriftBlockDialog` (blocking modal).

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

- **StatusLine is a single slot**: Claude-code's `statusLine` config accepts exactly one command. If the user already has a custom statusLine, the installer composes by setting `LAYMAN_ORIGINAL_STATUSLINE` in the relay script and piping input to both. Uninstall restores the original command.

- **`session_metrics` events**: StatusLine events fire after every assistant turn (high frequency). They are routed to a dedicated `sessionMetrics: Map<sessionId, SessionMetrics>` in the Zustand store rather than the timeline events array, to avoid flooding the timeline. The `SessionMetricsBar` component reads this map.

- **Drift monitoring design**: Drift scores use EMA smoothing (alpha 0.3) so a single LLM spike doesn't trigger alerts. Blocking at red level reuses `PendingApprovalManager` (same as tool approval). The two algorithms run in parallel via `Promise.all`. Cumulative prompt scope means every user message expands the session goal — only agent-initiated scope creep counts as drift. Per-item false-positive dismissals are injected into the LLM prompt to prevent re-flagging without resetting scores.

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

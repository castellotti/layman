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
| Claude Code | HTTP hook POSTs to `/hooks/:eventName` | `/layman` slash command |
| OpenCode | Bidirectional plugin (`packages/opencode-plugin`) | `/layman` slash command |
| Mistral Vibe | Passive file watcher on `~/.vibe/logs/session/` | `/layman` slash command |
| Cline | Shell-script hooks in `~/Documents/Cline/Hooks/` | `/layman` workflow in Cline |

### How data flows

1. **Claude Code hooks**: Claude Code fires HTTP POSTs to `/hooks/:eventName` (e.g. `PreToolUse`, `PostToolUse`, `SessionStart`). The hook handler in `packages/server/src/hooks/handler.ts` processes each event type, calls `EventStore.add()`, and for blocking hooks (`PreToolUse`, `PermissionRequest`) calls `PendingApprovalManager.createAndWait()` which suspends until the user decides.

2. **Cline hooks** (`packages/server/src/cline/`): Cline runs bash scripts from `~/Documents/Cline/Hooks/` that pipe JSON stdin to `POST /hooks/cline/:hookName`. The Cline handler (`handler.ts`) translates Cline's field/tool-name format to Layman's internal types via a translator (`translator.ts`), then reuses the same event pipeline. PreToolUse blocks for up to 25 seconds (Cline's hardcoded limit is 30s). Sessions require `/layman` activation, tracked by workspace directory (cwd) so activation survives Plan/Act mode switches.

3. **Mistral Vibe watcher** (`packages/server/src/vibe/watcher.ts`): Polls `~/.vibe/logs/session/<dir>/messages.jsonl` every 2 seconds from a tracked byte offset. Translates Vibe's JSONL message format to Layman events. Sessions require `/layman` activation; sessions idle for 15+ minutes are treated as ended. Sessions within a 5-minute replay window are read from the beginning.

4. **OpenCode plugin** (`packages/opencode-plugin`): A bidirectional plugin that receives events from OpenCode and can send prompts back. Registered in `~/.config/opencode/opencode.json`.

5. **EventStore** (`packages/server/src/events/store.ts`) — in-memory, max 10,000 events, emits `event:new` / `event:update` / `sessions:changed`. Also tracks active sessions (sessionId → cwd) via `trackSession()`. Events passing through the store are automatically scanned by the PII filter before storage.

6. **Session recording** (`packages/server/src/db/`) — SQLite database (`~/.local/share/layman/layman.db`) records all events for history and full-text search. Search uses SQLite FTS5 with a custom query parser supporting `+required`, `-excluded`, and `"quoted phrases"` operators.

7. **WebSocket** (`/ws`): On connect, server replays the last 100 events, all pending approvals, config, and current sessions list. After that, all changes are pushed as typed `ServerMessage` frames. The protocol is defined in `packages/server/src/types/index.ts` (server) and mirrored in `packages/web/src/lib/ws-protocol.ts` (client) — keep these in sync when adding message types.

8. **Analysis engine** (`packages/server/src/analysis/engine.ts`) — wraps Anthropic or OpenAI-compatible providers, supports `analyze()` (structured JSON → `AnalysisResult`) and `ask()` (free-form Q&A). Both return `{ text/result, tokens: { input, output }, latencyMs, model }`. Max 3 concurrent requests with a queue.

9. **PII filter** (`packages/server/src/pii/filter.ts`) — regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.). Applied at the EventStore level so all events are covered regardless of source.

10. **Client state** — Zustand store in `packages/web/src/stores/sessionStore.ts` holds all events, pending approvals, sessions list, active session filter, and investigation state. The `useEventStore()` hook at `packages/web/src/hooks/useEventStore.ts` applies session + UI filters on top.

### Key design decisions

- **Blocking hooks**: `PreToolUse` and `PermissionRequest` (Claude Code) and `PreToolUse` (Cline) suspend the agent process until `PendingApprovalManager.resolveApproval()` is called. Claude Code's timeout is 300s (configurable); Cline's is 25s (Cline hardcodes 30s).

- **`permission_request` vs `tool_call_pending`**: Both create pending approvals server-side (needed for blocking), but `usePendingApprovals` filters out `PermissionRequest` from the UI count since the browser can't act on them — the user must respond in their terminal.

- **Session tracking**: Sessions are derived from `trackSession(sessionId, cwd)` called on every incoming hook. If the sessions map is empty on connect (server just started), `getSessions()` falls back to scanning event history for unique sessionIds (cwd will be empty until the next hook fires).

- **Cline cwd-keyed activation**: Cline may change its `taskId` when switching Plan/Act modes while keeping the same workspace. Layman tracks activated workspace directories (`activatedCwds` Set in `cline/handler.ts`) so new taskIds in an already-activated workspace auto-activate without requiring `/layman` again.

- **Vibe session end detection**: Vibe sets `end_time` on every `save_interaction()` call (not just on close), so `end_time` is not a reliable signal. Sessions are instead considered ended after 15 minutes of log file inactivity.

- **Cline agent responses**: Cline routes all final AI responses through the `attempt_completion` tool. Layman captures the `result` parameter from `PostToolUse(attempt_completion)` and emits it as an `agent_response` event.

- **Type duplication**: `EventData`, `TimelineEvent`, `AnalysisResult`, and the WebSocket protocol types exist in both the server (`packages/server/src/`) and the client (`packages/web/src/lib/types.ts`, `ws-protocol.ts`). They must be kept in sync manually — there is no shared package.

- **Docker mounts**: The container mounts `${HOME}/.claude` (Claude Code hooks/commands), `${HOME}/.config` (OpenCode detection/commands), `${HOME}/.vibe` (Vibe log watching), and `${HOME}/Documents/Cline` (Cline hook script installation). The `HookInstaller` runs inside the container and writes through these mounts to the host filesystem.

### Hook installer (`packages/server/src/hooks/installer.ts`)

Manages installation of hooks and slash commands for all supported clients. Key methods:
- `install()` — writes Claude Code global hooks and runs optional-client detection
- `installClineHooks()` — writes bash hook scripts to `~/Documents/Cline/Hooks/` with `__LAYMAN_URL__` templated in
- `getStatus()` — returns installation state for all clients (used by the Settings UI)
- `uninstall()` — removes all Layman-managed files

Optional clients (OpenCode, Mistral Vibe, Cline) are detected by checking whether their config directories exist on the host filesystem. If detected, the corresponding `/layman` command or workflow file is written.

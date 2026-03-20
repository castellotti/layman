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

# Docker workflow (primary way to run Layman against a real Claude Code session)
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

### How data flows

1. **Hooks**: Claude Code fires HTTP POSTs to `/hooks/:eventName` (e.g. `PreToolUse`, `PostToolUse`, `SessionStart`). The hook handler in `packages/server/src/hooks/handler.ts` processes each event type, calls `EventStore.add()`, and for blocking hooks (`PreToolUse`, `PermissionRequest`) calls `PendingApprovalManager.createAndWait()` which suspends until the user decides.

2. **EventStore** (`packages/server/src/events/store.ts`) — in-memory, max 10,000 events, emits `event:new` / `event:update` / `sessions:changed`. Also tracks active sessions (sessionId → cwd) via `trackSession()`.

3. **WebSocket** (`/ws`): On connect, server replays the last 100 events, all pending approvals, config, and current sessions list. After that, all changes are pushed as typed `ServerMessage` frames. The protocol is defined in `packages/server/src/types/index.ts` (server) and mirrored in `packages/web/src/lib/ws-protocol.ts` (client) — keep these in sync when adding message types.

4. **Analysis engine** (`packages/server/src/analysis/engine.ts`) — wraps Anthropic or OpenAI-compatible providers, supports `analyze()` (structured JSON → `AnalysisResult`) and `ask()` (free-form Q&A). Both return `{ text/result, tokens: { input, output }, latencyMs, model }`. Max 3 concurrent requests with a queue.

5. **Client state** — Zustand store in `packages/web/src/stores/sessionStore.ts` holds all events, pending approvals, sessions list, active session filter, and investigation state. The `useEventStore()` hook at `packages/web/src/hooks/useEventStore.ts` applies session + UI filters on top.

### Key design decisions

- **Blocking hooks**: `PreToolUse` and `PermissionRequest` suspend the Claude Code process until `PendingApprovalManager.resolveApproval()` is called. The hook timeout (default 300s) auto-resolves with `ask` if no decision arrives.

- **`permission_request` vs `tool_call_pending`**: Both create pending approvals server-side (needed for blocking), but `usePendingApprovals` filters out `PermissionRequest` from the UI count since the browser can't act on them — the user must respond in their terminal.

- **Session tracking**: Sessions are derived from `trackSession(sessionId, cwd)` called on every incoming hook. If the sessions map is empty on connect (server just started), `getSessions()` falls back to scanning event history for unique sessionIds (cwd will be empty until the next hook fires).

- **Type duplication**: `EventData`, `TimelineEvent`, `AnalysisResult`, and the WebSocket protocol types exist in both the server (`packages/server/src/`) and the client (`packages/web/src/lib/types.ts`, `ws-protocol.ts`). They must be kept in sync manually — there is no shared package.

- **Docker**: The container mounts `${HOME}/.claude` (for Claude Code hooks and commands) and `${HOME}/.config` (for detecting and writing commands to optional clients like OpenCode). The `HookInstaller` runs inside the container and writes through these mounts to the host filesystem. The `--hook-url http://localhost:8880` flag ensures hook URLs point to the host-mapped port, not the container's bind address.
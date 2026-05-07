# Changelog

## 0.5.1

- Fixed Open WebUI `agent_response` events not appearing — `outlet()` was missing the `__metadata__` parameter so `chat_id` always resolved to `""` and every POST was rejected 400 ([#64](https://github.com/castellotti/layman/pull/64))
- Fixed thinking blocks not captured for reasoning models — structured `"thinking"` content blocks were keyed incorrectly; plain-text reasoning models (Qwen3, DeepSeek-R1) now have `<details type="reasoning">` / `<think>` / `<thinking>` HTML extracted and displayed in a collapsible Thinking block ([#64](https://github.com/castellotti/layman/pull/64))
- Fixed Open WebUI Settings "update available" badge not clearing after a successful install — version hash was computed from the URL-substituted content instead of the template, causing a mismatch on subsequent checks ([#64](https://github.com/castellotti/layman/pull/64))
- Fixed Open WebUI install race condition — install endpoint now accepts URL and API key in the request body so the server doesn't rely on a WebSocket config round-trip completing first ([#64](https://github.com/castellotti/layman/pull/64))
- Improved Open WebUI Settings UX — Save and Install/Update consolidated into a single button that labels itself based on current state and closes on success ([#64](https://github.com/castellotti/layman/pull/64))
- Added client-side reasoning extraction — old `agent_response` events with raw `<details>` HTML in `data.prompt` are now rendered correctly without a database migration ([#64](https://github.com/castellotti/layman/pull/64))

## 0.5.0

- Added Open WebUI integration — filter plugin captures prompts and responses via inlet/outlet hooks, with server-side handler, translator, URL config, and auto-activation ([#63](https://github.com/castellotti/layman/pull/63))

## 0.4.2

- Added context/limits panel to the Dashboard showing per-session context window %, 5h rate limit, and 1w rate limit as color-coded mini-bars ([#61](https://github.com/castellotti/layman/pull/61))
- Added analysis priority queue so user-initiated LLM calls jump ahead of background auto-analysis and drift checks ([#61](https://github.com/castellotti/layman/pull/61))
- Added investigated session indicator — sessions where the user has manually triggered analysis show a ⊙ badge in Dashboard cards, the session dropdown, and Session History ([#61](https://github.com/castellotti/layman/pull/61))
- Added harness version, model, and Layman version to the status bar; harness name is clickable and opens a changelog modal with version-aware scrolling ([#59](https://github.com/castellotti/layman/pull/59))
- Added early Vibe session detection — creates a placeholder session as soon as a `vibe` process is detected, before the user types anything ([#58](https://github.com/castellotti/layman/pull/58))
- Improved GFM rendering — tables, strikethrough, and horizontal rules now render correctly in all markdown panels; user prompt preview in the Dashboard uses the same blue as the Logs view ([#60](https://github.com/castellotti/layman/pull/60))
- Refactored server and web hot paths — O(1) event lookup map, shared `isAutoAllowedByPattern()`, de-asynced handlers, and shared `MARKDOWN_PROSE`/`REMARK_PLUGINS` constants ([#62](https://github.com/castellotti/layman/pull/62))

## 0.4.1

- Fixed Token Usage chart including closed and inactive sessions ([#56](https://github.com/castellotti/layman/pull/56))
- Fixed session `×` close button not deactivating the session server-side, leaving it in Token Usage ([#56](https://github.com/castellotti/layman/pull/56))
- Fixed session active state not persisting across WebSocket reconnects, causing closed sessions to reappear on reload ([#56](https://github.com/castellotti/layman/pull/56))
- Added inline Allow/Deny/Defer approval bar to the Dashboard event feed for pending tool call approvals ([#57](https://github.com/castellotti/layman/pull/57))
- Improved 1–2 session cards to fill available vertical space with a scrollable event feed ([#57](https://github.com/castellotti/layman/pull/57))
- Improved 3-session layout to use a 2×2 grid with the focused (or first) session spanning full height on the left ([#57](https://github.com/castellotti/layman/pull/57))

## 0.4.0

- Added Setup Wizard for first-run onboarding and guided configuration ([#52](https://github.com/castellotti/layman/pull/52))
- Fixed session stats scoping, drift labels, auto-activate for all harnesses, and Settings layout ([#53](https://github.com/castellotti/layman/pull/53))

## 0.3.1

- Fixed AGENTS.md drift support, wider threshold inputs, `blockOnRed` default off, and closed sessions hidden from dashboard ([#51](https://github.com/castellotti/layman/pull/51))

## 0.3.0

- Added drift monitoring and alignment detection for long AI sessions with EMA-smoothed scoring, per-item false-positive dismissal, and configurable thresholds ([#50](https://github.com/castellotti/layman/pull/50))
- Fixed dynamic version display, tooltip clipping, model tracking, session rename, copy/markdown in Investigation panel, and heredoc access parsing ([#49](https://github.com/castellotti/layman/pull/49))

## 0.2.0

- Added Dashboard view with multi-session monitoring, UX polish, and auto-approve levels ([#42](https://github.com/castellotti/layman/pull/42))
- Added harness terminology, Dashboard UX improvements, and re-activation fix ([#45](https://github.com/castellotti/layman/pull/45))
- Added PII access log coverage, auto-analysis levels, and dashboard-to-logs navigation ([#46](https://github.com/castellotti/layman/pull/46))
- Added Dashboard session close button, Vibe auto-deactivate, and radar empty-state icon ([#47](https://github.com/castellotti/layman/pull/47))
- Added Dashboard event feed with Logs-style display, synced to activity chain width ([#48](https://github.com/castellotti/layman/pull/48))
- Added vertical layout for parallel tools, edge animations, and timeline view ([#40](https://github.com/castellotti/layman/pull/40))
- Fixed access log history, flowchart parallel layout, and bash file tracking ([#41](https://github.com/castellotti/layman/pull/41))
- Fixed Codex skill sigil updated to `$layman`, auto-activate toggle, and activation fix ([#44](https://github.com/castellotti/layman/pull/44))
- Updated README with ghcr.io setup and recent features ([#39](https://github.com/castellotti/layman/pull/39))
- Simplified README setup with Quick Start and Full Details sections ([#43](https://github.com/castellotti/layman/pull/43))

## 0.1.0

Initial release.

- Added core monitoring server — Fastify HTTP + WebSocket server with real-time event streaming
- Added React dashboard — single-page application with Vite, Tailwind, and Zustand
- Added Claude Code integration — full hook coverage (26 event types), StatusLine metrics relay, and auto-activate support ([#36](https://github.com/castellotti/layman/pull/36))
- Added OpenCode integration — bidirectional plugin with full session visibility and prompt submission from Layman UI ([#1](https://github.com/castellotti/layman/pull/1), [#8](https://github.com/castellotti/layman/pull/8))
- Added Codex integration — OpenAI Codex monitoring via shell-script hooks ([#27](https://github.com/castellotti/layman/pull/27))
- Added Cline integration — bash hook scripts with workspace-directory-keyed activation ([#19](https://github.com/castellotti/layman/pull/19))
- Added Mistral Vibe integration — passive file watcher on session log files ([#18](https://github.com/castellotti/layman/pull/18))
- Added multi-client install system — opt-in installation with detection and status UI ([#7](https://github.com/castellotti/layman/pull/7), [#29](https://github.com/castellotti/layman/pull/29))
- Added Docker support — containerized deployment with host filesystem mounts for hook installation
- Added `/layman` slash command — session activation command for supported agents
- Added on-demand session gating — sessions only monitored when explicitly activated ([#4](https://github.com/castellotti/layman/pull/4))
- Added multi-session support — track multiple concurrent agent sessions with per-session filtering
- Added Layman's Terms feature — AI-powered plain-language explanations of agent actions with configurable prompt ([#3](https://github.com/castellotti/layman/pull/3))
- Added Investigation panel — interactive Q&A about session events with per-question model selector ([#13](https://github.com/castellotti/layman/pull/13))
- Added analysis engine — Anthropic and OpenAI-compatible provider support with LiteLLM streaming ([#5](https://github.com/castellotti/layman/pull/5), [#6](https://github.com/castellotti/layman/pull/6))
- Added PII filter — regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.) ([#15](https://github.com/castellotti/layman/pull/15))
- Added session search — SQLite full-text search with `+required`, `-excluded`, and `"quoted phrases"` operators ([#14](https://github.com/castellotti/layman/pull/14))
- Added session recording — persistent SQLite storage with bookmarks UI ([#9](https://github.com/castellotti/layman/pull/9))
- Added session history — browse, search, and replay past sessions ([#10](https://github.com/castellotti/layman/pull/10))
- Added auto-recovery — restore sessions from Vibe and Claude Code history ([#23](https://github.com/castellotti/layman/pull/23))
- Added interactive flowchart view — visualize tool call chains with file/URL access tracking ([#35](https://github.com/castellotti/layman/pull/35))
- Added session time tracker — configurable idle threshold for accurate session duration ([#34](https://github.com/castellotti/layman/pull/34))
- Added blocking hooks — `PreToolUse` and `PermissionRequest` suspend the agent until user decides
- Added auto-approve levels — configure automatic approval behavior for tool calls
- Added auto-explain — automatic analysis for auto-approved events ([#22](https://github.com/castellotti/layman/pull/22))
- Added PDF export — export session transcripts as PDF ([#16](https://github.com/castellotti/layman/pull/16))
- Added GitHub Actions release workflow — automated CI/CD with deployment script ([#38](https://github.com/castellotti/layman/pull/38))
- Added MIT license ([2040cef](https://github.com/castellotti/layman/commit/2040cef))
- Fixed unsupported `PermissionDenied` hook removed (requires claude-code ≥ 2.1.85) ([#37](https://github.com/castellotti/layman/pull/37))
- Fixed TypeScript typecheck errors in recovery, Vibe watcher, and shared types ([#30](https://github.com/castellotti/layman/pull/30))
- Fixed installation detection and Docker native module build ([#31](https://github.com/castellotti/layman/pull/31))
- Fixed session activation and Docker bound to localhost only ([#32](https://github.com/castellotti/layman/pull/32))
- Fixed transcript timing and permission request detail display ([#17](https://github.com/castellotti/layman/pull/17))
- Fixed auto-scroll and activation optimization ([#16](https://github.com/castellotti/layman/pull/16))
- Fixed setup banner showing after rebuild when hooks are already installed

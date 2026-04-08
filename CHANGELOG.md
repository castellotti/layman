# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0](https://github.com/castellotti/layman/compare/v0.3.1...v0.4.0) - 2026-04-07

### Added

- Setup Wizard for first-run onboarding and guided configuration ([#52](https://github.com/castellotti/layman/pull/52))

### Fixed

- Session stats scoping, drift labels, auto-activate for all harnesses, Settings layout ([#53](https://github.com/castellotti/layman/pull/53))

## [0.3.1](https://github.com/castellotti/layman/compare/v0.3.0...v0.3.1) - 2026-04-07

### Fixed

- AGENTS.md drift support, wider threshold inputs, `blockOnRed` default off, hide closed sessions ([#51](https://github.com/castellotti/layman/pull/51))

## [0.3.0](https://github.com/castellotti/layman/compare/v0.2.0...v0.3.0) - 2026-04-07

### Added

- Drift monitoring / alignment detection for long AI sessions with EMA-smoothed scoring, per-item false-positive dismissal, and configurable thresholds ([#50](https://github.com/castellotti/layman/pull/50))

### Fixed

- Cleanup fixes: dynamic version display, tooltip clipping, model tracking, session rename, copy/markdown in Investigation panel, heredoc access parsing ([#49](https://github.com/castellotti/layman/pull/49))

## [0.2.0](https://github.com/castellotti/layman/compare/v0.1.0...v0.2.0) - 2026-04-06

### Added

- Dashboard view with multi-session monitoring, UX polish, and auto-approve levels ([#42](https://github.com/castellotti/layman/pull/42))
- Harness terminology, Dashboard UX improvements, and re-activation fix ([#45](https://github.com/castellotti/layman/pull/45))
- PII access log coverage, auto-analysis levels, dashboard-to-logs navigation ([#46](https://github.com/castellotti/layman/pull/46))
- Dashboard session close button, Vibe auto-deactivate, radar empty-state icon ([#47](https://github.com/castellotti/layman/pull/47))
- Dashboard event feed with Logs-style display, synced to activity chain width ([#48](https://github.com/castellotti/layman/pull/48))
- Vertical layout for parallel tools, edge animations, and timeline view ([#40](https://github.com/castellotti/layman/pull/40))

### Fixed

- Access log history, flowchart parallel layout, and bash file tracking ([#41](https://github.com/castellotti/layman/pull/41))
- Codex skill sigil updated to `$layman`, auto-activate toggle, activation fix ([#44](https://github.com/castellotti/layman/pull/44))

### Documentation

- Updated README with ghcr.io setup and recent features ([#39](https://github.com/castellotti/layman/pull/39))
- Simplified setup with Quick Start and Full Details sections ([#43](https://github.com/castellotti/layman/pull/43))

## [0.1.0](https://github.com/castellotti/layman/releases/tag/v0.1.0) - 2026-04-03

Initial release.

### Added

- **Core monitoring server** — Fastify HTTP + WebSocket server with real-time event streaming
- **React dashboard** — Single-page application with Vite, Tailwind, and Zustand
- **Claude Code integration** — Full hook coverage (26 event types), StatusLine metrics relay, and auto-activate support ([#36](https://github.com/castellotti/layman/pull/36))
- **OpenCode integration** — Bidirectional plugin with full session visibility and prompt submission from Layman UI ([#1](https://github.com/castellotti/layman/pull/1), [#8](https://github.com/castellotti/layman/pull/8))
- **Codex integration** — OpenAI Codex monitoring via shell-script hooks ([#27](https://github.com/castellotti/layman/pull/27))
- **Cline integration** — Bash hook scripts with workspace-directory-keyed activation ([#19](https://github.com/castellotti/layman/pull/19))
- **Mistral Vibe integration** — Passive file watcher on session log files ([#18](https://github.com/castellotti/layman/pull/18))
- **Multi-client install system** — Opt-in installation with detection and status UI ([#7](https://github.com/castellotti/layman/pull/7), [#29](https://github.com/castellotti/layman/pull/29))
- **Docker support** — Containerized deployment with host filesystem mounts for hook installation
- **`/layman` slash command** — Session activation command for supported agents
- **On-demand session gating** — Sessions only monitored when explicitly activated ([#4](https://github.com/castellotti/layman/pull/4))
- **Multi-session support** — Track multiple concurrent agent sessions with per-session filtering
- **Layman's Terms feature** — AI-powered plain-language explanations of agent actions with configurable prompt ([#3](https://github.com/castellotti/layman/pull/3))
- **Investigation panel** — Interactive Q&A about session events with per-question model selector ([#13](https://github.com/castellotti/layman/pull/13))
- **Analysis engine** — Anthropic and OpenAI-compatible provider support with LiteLLM streaming ([#5](https://github.com/castellotti/layman/pull/5), [#6](https://github.com/castellotti/layman/pull/6))
- **PII filter** — Regex-based redaction covering 24 categories (emails, API keys, passwords, credit cards, JWTs, etc.) ([#15](https://github.com/castellotti/layman/pull/15))
- **Session search** — SQLite full-text search with `+required`, `-excluded`, and `"quoted phrases"` operators ([#14](https://github.com/castellotti/layman/pull/14))
- **Session recording** — Persistent SQLite storage with bookmarks UI ([#9](https://github.com/castellotti/layman/pull/9))
- **Session history** — Browse, search, and replay past sessions ([#10](https://github.com/castellotti/layman/pull/10))
- **Auto-recovery** — Restore sessions from Vibe and Claude Code history ([#23](https://github.com/castellotti/layman/pull/23))
- **Interactive flowchart view** — Visualize tool call chains with file/URL access tracking ([#35](https://github.com/castellotti/layman/pull/35))
- **Session time tracker** — Configurable idle threshold for accurate session duration ([#34](https://github.com/castellotti/layman/pull/34))
- **Blocking hooks** — `PreToolUse` and `PermissionRequest` suspend the agent until user decides
- **Auto-approve levels** — Configure automatic approval behavior for tool calls
- **Auto-explain** — Automatic analysis for auto-approved events ([#22](https://github.com/castellotti/layman/pull/22))
- **PDF export** — Export session transcripts as PDF ([#16](https://github.com/castellotti/layman/pull/16))
- **GitHub Actions release workflow** — Automated CI/CD with deployment script ([#38](https://github.com/castellotti/layman/pull/38))
- **MIT license** ([2040cef](https://github.com/castellotti/layman/commit/2040cef))

### Fixed

- Remove unsupported `PermissionDenied` hook (requires claude-code >= 2.1.85) ([#37](https://github.com/castellotti/layman/pull/37))
- TypeScript typecheck errors in recovery, Vibe watcher, and shared types ([#30](https://github.com/castellotti/layman/pull/30))
- Installation detection and Docker native module build ([#31](https://github.com/castellotti/layman/pull/31))
- Session activation and Docker bound to localhost only ([#32](https://github.com/castellotti/layman/pull/32))
- Transcript timing and permission request detail display ([#17](https://github.com/castellotti/layman/pull/17))
- Auto-scroll, activation optimization ([#16](https://github.com/castellotti/layman/pull/16))
- Setup banner showing after rebuild when hooks are already installed

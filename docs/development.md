# Development

Building, testing, and contributing to Layman.

## Prerequisites

- Node.js 22+
- pnpm 10 (`corepack enable && corepack prepare pnpm@10.29.3 --activate`)
- Docker (for container builds)

## Workspace layout

pnpm workspace with three packages:

| Package | What it is |
|---|---|
| `packages/server` | Fastify HTTP + WebSocket server, SQLite storage (better-sqlite3), analysis engine, hook/command installers. Builds with tsup. |
| `packages/web` | React 18 + Vite dashboard. Zustand stores, @xyflow/react flowchart, token-based dark theme with locally-served IBM Plex Sans/Mono. |
| `packages/opencode-plugin` | Bidirectional OpenCode plugin. |

## Common tasks

```bash
make install     # pnpm install
make dev         # server + web in parallel watch mode
make build       # pnpm -r build
make test        # vitest across the workspace
make typecheck   # tsc --noEmit across the workspace
```

## Running from source in Docker

```bash
make docker-build   # docker build -t layman .
make docker-run     # build + compose up, hooks scoped to the current directory
make docker-logs    # follow logs
make docker-stop
```

`make docker-run` points Layman at the current working directory's `.claude` folder; override with `LAYMAN_PROJECT_DIR=/path/to/project`.

The image builds on `node:22-slim`; `better-sqlite3` is a native module compiled during the image build (python3/make/g++ are installed in the build stage).

## Frontend conventions

- **Design tokens** - colors, spacing, and type come from CSS custom properties in `packages/web/src/index.css` (`--text`, `--text-muted`, `--accent`, `--bg-selected`, `--warn`, `--error`, …). Never hardcode palette hexes in components.
- **Shared primitives** - `StatusDot`, `StateChip`, `Meter`, `RiskTag`, `FilterChip`, `SearchInput`, `LiveChip`, `JumpToLatest` live in `packages/web/src/components/primitives/`. Reuse them before writing new controls.
- **Selection semantics** - radios render as segmented controls with exactly one selection (re-click is a no-op); toggles are chips that visibly clear on second click; visual state derives from a single store value.
- Fonts are served locally via `@fontsource` - no CDN requests at runtime.

## Contributing

- Read [`CLAUDE.md`](../CLAUDE.md) - it defines project conventions and is enforced for AI-assisted contributions (Layman's own drift monitoring watches it, too).
- Run `make typecheck && make test` before opening a PR.
- Keep [`CHANGELOG.md`](../CHANGELOG.md) entries in the existing format: one bullet per change with the PR link.
- Releases are cut with `scripts/release.sh` and published as Docker images to ghcr.io via GitHub Actions.

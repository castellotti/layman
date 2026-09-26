.PHONY: build dev test typecheck docker-build docker-run docker-stop docker-logs clean start stop update

# ── Container engine ──────────────────────────────────────────────────────────
# Layman runs from a container image; either Docker or Podman drives it. Both
# expose the same `build` and `compose` verbs, so a single detected variable
# stands in for whichever one is installed. Docker wins when its daemon is
# actually reachable — a lingering docker CLI with no running daemon (common on
# Podman-primary hosts) falls back to Podman rather than failing at build time.
# Docker is the last-resort default so error messages name a real engine.
# `:=` evaluates the detection once; a command-line override (e.g.
# `make docker-run CONTAINER_ENGINE=podman`) skips it entirely.
CONTAINER_ENGINE := $(shell \
	if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then echo docker; \
	elif command -v podman >/dev/null 2>&1; then echo podman; \
	elif command -v docker >/dev/null 2>&1; then echo docker; \
	else echo docker; fi)
COMPOSE := $(CONTAINER_ENGINE) compose

# ── glove (optional extension) ────────────────────────────────────────────────
# Layman and glove are independent: the glove mounts live in overlay files that
# are added only when glove's own folders already exist, so starting Layman never
# creates ~/.glove (Docker would create a missing bind source). glove creates
# ~/.glove/control when it renders a session with a network gate; until then
# Layman can show that session's traffic but not change its rules. Layman never
# creates or changes permissions on anything under ~/.glove.
GLOVE_COMPOSE := $(if $(wildcard $(HOME)/.glove/.),-f docker-compose.glove.yml)$(if $(wildcard $(HOME)/.glove/control/.), -f docker-compose.glove-control.yml)
GLOVE_NOTE = $(if $(wildcard $(HOME)/.glove/.),glove: mounting ~/.glove read-only$(if $(wildcard $(HOME)/.glove/control/.), and ~/.glove/control writable, (no ~/.glove/control yet: rules stay read-only until glove creates it and Layman is restarted)),glove: ~/.glove not found; not mounted)

# ── Local development ─────────────────────────────────────────────────────────

install:
	pnpm install

build:
	pnpm build

dev:
	pnpm --parallel -r dev

test:
	pnpm -r test

typecheck:
	pnpm -r typecheck

clean:
	rm -rf packages/server/dist web-dist node_modules packages/*/node_modules

# ── Quick start (pre-built ghcr.io image) ─────────────────────────────────────

start:
	@mkdir -p "$${HOME}/.local/share/layman"
	$(COMPOSE) -f docker-compose.ghcr.yml pull
	@echo "$(GLOVE_NOTE)"
	LAYMAN_HOST_NAME="$${LAYMAN_HOST_NAME:-$$(hostname)}" \
	$(COMPOSE) -f docker-compose.ghcr.yml $(GLOVE_COMPOSE) up -d
	@echo ""
	@echo "Layman running at http://localhost:8880"

stop:
	$(COMPOSE) -f docker-compose.ghcr.yml down
	@echo "Layman stopped."

update:
	@mkdir -p "$${HOME}/.local/share/layman"
	$(COMPOSE) -f docker-compose.ghcr.yml pull
	@echo "$(GLOVE_NOTE)"
	LAYMAN_HOST_NAME="$${LAYMAN_HOST_NAME:-$$(hostname)}" \
	$(COMPOSE) -f docker-compose.ghcr.yml $(GLOVE_COMPOSE) up -d
	@echo "Layman updated and restarted."

# ── Container image (build from source) ───────────────────────────────────────
# Works with either Docker or Podman via $(CONTAINER_ENGINE) / $(COMPOSE).

docker-build:
	$(CONTAINER_ENGINE) build -t layman .

# Start Layman pointed at the current working directory's .claude folder.
# Override the project dir: make docker-run LAYMAN_PROJECT_DIR=/path/to/project
docker-run: docker-build
	@mkdir -p "$${HOME}/.local/share/layman"
	@echo "$(GLOVE_NOTE)"
	LAYMAN_PROJECT_DIR=$(or $(LAYMAN_PROJECT_DIR),$(CURDIR)) \
	LAYMAN_HOST_NAME="$${LAYMAN_HOST_NAME:-$$(hostname)}" \
	$(COMPOSE) -f docker-compose.yml $(GLOVE_COMPOSE) up -d
	@echo ""
	@echo "Layman running at http://localhost:8880"
	@echo "Hooks installed in $${LAYMAN_PROJECT_DIR:-.}/.claude/settings.local.json"
	@echo "Run 'make docker-logs' to follow logs, 'make docker-stop' to stop."

docker-stop:
	$(COMPOSE) down
	@echo "Layman stopped."

docker-logs:
	$(COMPOSE) logs -f

docker-status:
	@$(CONTAINER_ENGINE) ps --filter "name=^layman$$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

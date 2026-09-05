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
	LAYMAN_HOST_NAME="$${LAYMAN_HOST_NAME:-$$(hostname)}" \
	$(COMPOSE) -f docker-compose.ghcr.yml up -d
	@echo ""
	@echo "Layman running at http://localhost:8880"

stop:
	$(COMPOSE) -f docker-compose.ghcr.yml down
	@echo "Layman stopped."

update:
	@mkdir -p "$${HOME}/.local/share/layman"
	$(COMPOSE) -f docker-compose.ghcr.yml pull
	LAYMAN_HOST_NAME="$${LAYMAN_HOST_NAME:-$$(hostname)}" \
	$(COMPOSE) -f docker-compose.ghcr.yml up -d
	@echo "Layman updated and restarted."

# ── Container image (build from source) ───────────────────────────────────────
# Works with either Docker or Podman via $(CONTAINER_ENGINE) / $(COMPOSE).

docker-build:
	$(CONTAINER_ENGINE) build -t layman .

# Start Layman pointed at the current working directory's .claude folder.
# Override the project dir: make docker-run LAYMAN_PROJECT_DIR=/path/to/project
docker-run: docker-build
	@mkdir -p "$${HOME}/.local/share/layman"
	LAYMAN_PROJECT_DIR=$(or $(LAYMAN_PROJECT_DIR),$(CURDIR)) \
	LAYMAN_HOST_NAME="$${LAYMAN_HOST_NAME:-$$(hostname)}" \
	$(COMPOSE) up -d
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

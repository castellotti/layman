.PHONY: build dev test typecheck docker-build docker-run docker-stop docker-logs clean

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

# ── Docker ────────────────────────────────────────────────────────────────────

docker-build:
	docker build -t layman .

# Start Layman pointed at the current working directory's .claude folder.
# Override the project dir: make docker-run LAYMAN_PROJECT_DIR=/path/to/project
docker-run: docker-build
	LAYMAN_PROJECT_DIR=$(or $(LAYMAN_PROJECT_DIR),$(CURDIR)) \
	docker compose up -d
	@echo ""
	@echo "Layman running at http://localhost:8090"
	@echo "Hooks installed in $${LAYMAN_PROJECT_DIR:-.}/.claude/settings.local.json"
	@echo "Run 'make docker-logs' to follow logs, 'make docker-stop' to stop."

docker-stop:
	docker compose down
	@echo "Layman stopped."

docker-logs:
	docker compose logs -f

docker-status:
	@docker ps --filter "name=^layman$$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

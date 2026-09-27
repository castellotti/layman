#!/usr/bin/env bash
# Rebuild the Layman container image and restart it, then follow its logs.
# Works with either Docker or Podman. Detection mirrors the Makefile: prefer
# Docker when its daemon is actually reachable, fall back to Podman when only a
# daemon-less docker CLI is present (common on Podman-primary hosts), else use
# a docker CLI if one exists so the failure names a real engine. Override with
# CONTAINER_ENGINE=podman.
set -euo pipefail

if [ -z "${CONTAINER_ENGINE:-}" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
  else
    echo "Neither docker nor podman found on PATH." >&2
    exit 1
  fi
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# glove (optional extension): add its overlays only when glove's own folders
# already exist, exactly as the Makefile's GLOVE_COMPOSE does, so this never
# creates ~/.glove and never starts Layman blind to glove sessions.
COMPOSE_FILES=(-f docker-compose.yml)
if [ -d "$HOME/.glove" ]; then
  COMPOSE_FILES+=(-f docker-compose.glove.yml)
  if [ -d "$HOME/.glove/control" ]; then
    COMPOSE_FILES+=(-f docker-compose.glove-control.yml)
    echo "glove: mounting ~/.glove read-only and ~/.glove/control writable"
  else
    echo "glove: mounting ~/.glove read-only (no ~/.glove/control yet: rules stay read-only until glove creates it and Layman is restarted)"
  fi
else
  echo "glove: ~/.glove not found; not mounted"
fi

# Both engines accept the same compose/rm/logs verbs.
"$CONTAINER_ENGINE" stop layman || true
"$CONTAINER_ENGINE" rm layman || true
"$CONTAINER_ENGINE" compose "${COMPOSE_FILES[@]}" build
LAYMAN_HOST_NAME="${LAYMAN_HOST_NAME:-$(hostname)}" \
  "$CONTAINER_ENGINE" compose "${COMPOSE_FILES[@]}" up -d
"$CONTAINER_ENGINE" logs -f layman

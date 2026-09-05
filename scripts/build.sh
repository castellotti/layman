#!/usr/bin/env bash
# Rebuild the Layman container image and restart it, then follow its logs.
# Works with either Docker or Podman: whichever is installed is used (Docker
# wins when both are present). Override with CONTAINER_ENGINE=podman.
set -euo pipefail

if [ -z "${CONTAINER_ENGINE:-}" ]; then
  if command -v docker >/dev/null 2>&1; then
    CONTAINER_ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then
    CONTAINER_ENGINE=podman
  else
    echo "Neither docker nor podman found on PATH." >&2
    exit 1
  fi
fi

# Both engines accept the same compose/rm/logs verbs.
"$CONTAINER_ENGINE" stop layman || true
"$CONTAINER_ENGINE" rm layman || true
"$CONTAINER_ENGINE" compose build
"$CONTAINER_ENGINE" compose up -d
"$CONTAINER_ENGINE" logs -f layman

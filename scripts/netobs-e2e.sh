#!/usr/bin/env bash
# Browser checks for the glove network views (e2e/network/), against a throwaway Layman.
#
#   scripts/netobs-e2e.sh up          build the image, fake glove home, replays, container
#   scripts/netobs-e2e.sh run [name…] run the checks (default: all, in order); exit 1 on any failure
#   scripts/netobs-e2e.sh down        stop the replays and the container (--purge: also the work dir and image)
#   scripts/netobs-e2e.sh all         up, run, down
#
# Never touches the live Layman (:8880), its data or ~/.glove: everything lives in LAYMAN_E2E_DIR
# (default /tmp/layman-netobs-e2e), including a fake glove home the replays write. Needs Node,
# pnpm dependencies installed, Docker or Podman, Chrome, and sqlite3 (the persistence check).
# SKIP_BUILD=1 reuses the image. Variables: see e2e/network/env.mjs.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${LAYMAN_E2E_DIR:-/tmp/layman-netobs-e2e}"
PORT="${LAYMAN_E2E_PORT:-8890}"
NAME="${LAYMAN_E2E_NAME:-layman-netobs-e2e}"
IMAGE="${LAYMAN_E2E_IMAGE:-layman-netobs-e2e}"
if [ -z "${CONTAINER_ENGINE:-}" ]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then CONTAINER_ENGINE=docker; else CONTAINER_ENGINE=podman; fi
fi
export LAYMAN_E2E_DIR="$DIR" LAYMAN_E2E_URL="http://localhost:$PORT" LAYMAN_E2E_NAME="$NAME" CONTAINER_ENGINE
case "$DIR" in /|"$HOME"|"$HOME"/.glove*|"$HOME"/.local*|"") echo "Refusing LAYMAN_E2E_DIR=$DIR: it is deleted and recreated." >&2; exit 1 ;; esac
CHECKS=(network control map topology trace persistence ip-setting)

replay() {
  (cd "$REPO/packages/server" && nohup node --import tsx scripts/netobs-replay.ts --dir "$DIR/glove" "$@" >>"$DIR/replay.log" 2>&1 & echo $! >>"$DIR/replay.pids")
}

up() {
  if [ "$PORT" = 8880 ]; then echo "Refusing port 8880: that is the live Layman." >&2; exit 1; fi
  down >/dev/null 2>&1 || true
  rm -rf "$DIR" && mkdir -p "$DIR/data" "$DIR/shots" "$DIR/glove/control"
  cat >"$DIR/data/layman.json" <<'JSON'
{"setupWizardComplete": true, "sessionRecording": true,
 "glove": {"enabled": true, "home": "~/.glove", "network": {"geoipDbPath": "~/.local/share/layman/demo-geo.mmdb"}}}
JSON
  echo "playwright-core → $DIR/pw (outside the repo and the image)"
  npm install --silent --no-save --prefix "$DIR/pw" playwright-core@1.63.0 >/dev/null
  if [ "${SKIP_BUILD:-}" != 1 ]; then "$CONTAINER_ENGINE" build -t "$IMAGE" "$REPO"; fi

  (cd "$REPO/packages/server" && node --import tsx scripts/netobs-replay.ts --demo-geo "$DIR/data/demo-geo.mmdb")
  replay --speed 0.2 --loop --loop-gap 3 --rotate-every 30 --direct --gate --transcript
  replay --scenario rules-rejected,default-block,gate-lost,terminate --gate --loop --loop-gap 20
  replay --scenario direct,empty,pooled,record-full,resolver-down,search,stopped,telemetry-dropped,exit-none,exit-unhealthy,sni-refined,rotation
  node "$REPO/e2e/network/make-big.mjs"
  for _ in $(seq 30); do [ -d "$DIR/glove/observe/pi-search-c0ffee" ] && break; sleep 1; done

  "$CONTAINER_ENGINE" run -d --name "$NAME" -p "127.0.0.1:$PORT:8880" -e HOST_HOME="$HOME" \
    -v "$DIR/data:/root/.local/share/layman" -v "$DIR/glove:/root/.glove:ro" -v "$DIR/glove/control:/root/.glove/control" \
    "$IMAGE" node packages/server/dist/index.js start --host 0.0.0.0 --no-open --hook-url "http://localhost:$PORT" >/dev/null
  for _ in $(seq 60); do curl -fs "http://localhost:$PORT/api/net/sessions" >/dev/null 2>&1 && break; sleep 1; done
  sleep 10 # a few replay passes, so live states exist
  echo "Throwaway Layman at http://localhost:$PORT (work dir $DIR)"
}

run() {
  local names=("$@") failed=()
  [ ${#names[@]} -eq 0 ] && names=("${CHECKS[@]}")
  for n in "${names[@]}"; do
    echo "── $n"
    node "$REPO/e2e/network/$n.mjs" || failed+=("$n")
  done
  if [ ${#failed[@]} -gt 0 ]; then echo "Failed: ${failed[*]}" >&2; return 1; fi
  echo "All passed: ${names[*]}"
}

down() {
  if [ -f "$DIR/replay.pids" ]; then
    # SIGINT: the replay marks its fake gates stopped before exiting.
    while read -r pid; do kill -INT "$pid" 2>/dev/null || true; done <"$DIR/replay.pids"
    rm -f "$DIR/replay.pids"
  fi
  "$CONTAINER_ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "${1:-}" = --purge ]; then rm -rf "$DIR"; "$CONTAINER_ENGINE" rmi "$IMAGE" >/dev/null 2>&1 || true; fi
}

case "${1:-}" in
  up) up ;;
  run) shift; run "$@" ;;
  down) shift; down "$@" ;;
  all) up; status=0; run || status=$?; down; exit "$status" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

#!/usr/bin/env bash
# The glove compose overlays to add, as `-f` arguments on stdout; with --note, a
# one-line description of them instead. The one source of this rule for the
# Makefile and scripts/build.sh.
#
# Layman and glove are independent: the glove mounts live in overlay files that
# are added only when glove's own folders already exist, so starting Layman never
# creates ~/.glove (Docker would create a missing bind source). glove creates
# ~/.glove/control when it renders a session with a network gate; until then
# Layman can show that session's traffic but not change its rules. Layman never
# creates or changes permissions on anything under ~/.glove.
set -euo pipefail

files=""
if [ -d "$HOME/.glove" ]; then
  files="-f docker-compose.glove.yml"
  if [ -d "$HOME/.glove/control" ]; then
    files="$files -f docker-compose.glove-control.yml"
    note="glove: mounting ~/.glove read-only and ~/.glove/control writable"
  else
    note="glove: mounting ~/.glove read-only (no ~/.glove/control yet: rules stay read-only until glove creates it and Layman is restarted)"
  fi
else
  note="glove: ~/.glove not found; not mounted"
fi

if [ "${1:-}" = "--note" ]; then echo "$note"; else echo "$files"; fi

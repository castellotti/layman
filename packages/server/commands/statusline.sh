#!/usr/bin/env bash
# Layman StatusLine relay — receives JSON on stdin from claude-code's StatusLine,
# POSTs it to the Layman server, then optionally chains to the user's original
# statusLine command. The original command's stdout becomes the terminal status text.

INPUT=$(cat)

# POST to Layman (background, 3s timeout, fire-and-forget)
echo "$INPUT" | curl -s --max-time 3 -X POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  "__LAYMAN_URL__/hooks/StatusLine" > /dev/null 2>&1 &

# Chain to original command if set (its stdout becomes the status bar text)
if [ -n "$LAYMAN_ORIGINAL_STATUSLINE" ]; then
  echo "$INPUT" | eval "$LAYMAN_ORIGINAL_STATUSLINE"
fi

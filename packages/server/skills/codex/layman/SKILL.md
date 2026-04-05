---
name: layman
description: Activate Layman monitoring for this Codex session
metadata:
  short-description: Activate Layman monitoring
---

You were invoked via `$layman`. Activate Layman monitoring:

1. Run this shell command (you MUST execute it — do not just output it as text):
   `echo "layman:activate"`

2. Tell the user: "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."

3. If Layman does not appear to be monitoring, tell the user:
   "Layman server may not be running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"

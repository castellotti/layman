---
description: Activate Layman monitoring for this session
---

You are activating the Layman monitoring dashboard. Follow these steps:

1. Use the Bash tool to execute this exact command (do NOT just output it as text — you MUST use the Bash tool):
   `echo "layman:activate"`

2. Tell the user:
   "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."

3. If Layman does not appear to be monitoring (no events appear in the dashboard), tell the user:
   "Layman server may not be running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"

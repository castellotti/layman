---
description: Activate Layman monitoring for this session
---

You are activating the Layman monitoring dashboard. Follow these steps:

1. Activate this session with Layman by running:
   `curl -s -X POST http://localhost:8090/api/activate`

2. If the curl command succeeds (returns JSON with "ok"), tell the user:
   "Layman is now monitoring this session. Open http://localhost:8090 to see the dashboard."

3. If the curl command fails (connection refused or error), tell the user:
   "Layman server is not running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"

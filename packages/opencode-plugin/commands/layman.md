---
description: Start Layman monitoring dashboard for this session
---

You are activating the Layman monitoring dashboard. Follow these steps:

1. Check if the Layman Docker container is running:
   `docker ps --filter "name=^layman$" --format "{{.Status}}"`

2. If NOT running, start it. Set LAYMAN_PROJECT_DIR to the current working directory:
   `LAYMAN_PROJECT_DIR=$(pwd) docker compose -f <path-to-layman>/docker-compose.yml up -d`

3. Verify the plugin is configured in opencode.json (project or global):
   - The plugin entry should point to the layman plugin package
   - LAYMAN_URL should be set to http://localhost:8090

4. Open the dashboard: http://localhost:8090

Report the status to the user.

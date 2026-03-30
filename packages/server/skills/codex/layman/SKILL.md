---
name: layman
description: Activate Layman monitoring for this Codex session
metadata:
  short-description: Activate Layman monitoring
---

You were invoked via `@layman`. Activate Layman monitoring for the current session by running this shell command:

```
curl -s -X POST "http://localhost:8880/api/codex/activate" -H "Content-Type: application/json" -d "{\"cwd\":\"$(pwd)\"}"
```

After running it, tell the user: "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."

If the command fails or returns an error, tell the user: "Layman server may not be running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"

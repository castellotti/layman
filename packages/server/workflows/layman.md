You are activating the Layman monitoring dashboard. Follow these steps:

1. If you are in Plan mode, switch to Act mode first — the activation requires running a shell command.

2. Activate this session with Layman by running:
   `echo "layman:activate"`

3. Tell the user:
   "Layman is now monitoring this session. Open http://localhost:8880 to see the dashboard."

4. If Layman does not appear to be monitoring (no events appear in the dashboard), tell the user:
   "Layman server may not be running. Start it with: docker compose -f ~/layman/docker-compose.yml up -d"

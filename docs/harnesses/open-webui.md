# Open WebUI

Open WebUI uses a filter function that Layman installs directly into your Open WebUI instance via its REST API. Once installed, **all** Open WebUI chat sessions are automatically monitored - no per-session activation step is needed.

## Installation

First time or after a Layman update:

1. Open the Layman dashboard -> **Settings -> Connection** -> click **Configure** next to Open WebUI.
2. Enter your Open WebUI URL (e.g. `http://localhost:3000`). Click **⟳ Auto-detect** to find a running instance automatically.
3. If your Open WebUI instance requires authentication, enter an API key. Generate one under **Admin Panel -> Settings -> General -> Enable API Key Authentication**, then **Profile -> API Keys**. Leave blank if auth is disabled.
4. Click **Install**. Layman pushes the filter function to Open WebUI and enables it globally.

## Usage

Once installed, start any Open WebUI chat - the session appears in the Layman dashboard automatically within seconds of your first message.

## Docker networking note

If Open WebUI runs in Docker, its filter function must be able to reach Layman across the Docker network boundary. Layman handles this automatically: if the Open WebUI URL you enter contains `host.docker.internal`, the callback URL embedded in the filter is rewritten to use `host.docker.internal` instead of `localhost`, so the filter can POST to Layman from inside the container.

## Notes

- The filter captures user prompts (via Open WebUI's `inlet` hook) and AI responses (via `outlet`).
- Multi-modal content (images) and thinking blocks are supported - text portions are extracted automatically.
- Web search sessions are automatically captured when Open WebUI's web search pipeline is active - queries and retrieved sources appear as `web_search` timeline events with clickable source cards.
- Tool approval from the Layman UI is not supported (Open WebUI has no mechanism to pause generation mid-stream).

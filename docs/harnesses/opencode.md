# OpenCode

OpenCode uses a bidirectional plugin with full session visibility. It requires a one-time plugin registration before first use.

## Installation

1. Register the Layman plugin in your OpenCode config (`~/.config/opencode/opencode.json`):

   ```json
   {
     "plugin": [
       "file:///absolute/path/to/layman/packages/opencode-plugin"
     ]
   }
   ```

2. Open the Layman dashboard -> **Settings -> Harness** -> click **Install** next to OpenCode to install the `/layman` command for it.

## Usage

Start OpenCode and type `/layman` to activate monitoring for the current session.

## Capabilities

- Full session visibility via the plugin.
- Send prompts and respond to questions directly from the Layman UI when an OpenCode session is active.

## Architecture & implementation notes

> Moved here from the root `CLAUDE.md` to keep it under its size limit.

`packages/opencode-plugin` is a bidirectional plugin that receives events from OpenCode and can send
prompts back. It is registered in `~/.config/opencode/opencode.json`. Live token streaming is
token-level (OpenCode sends cumulative text via `message.part.updated`, which Layman diffs);
`reasoning` parts feed live thinking, and an estimated live token counter is replaced by the exact
post-turn `usage`.

# glove

[glove](https://github.com/glovebox-ai/glove) sandboxes a coding harness inside a container and
persists its fake home on the host under `~/.glove/envs/<env-id>/home/`. Layman monitors gloved
sessions **passively and read-only** by tailing those already-persisted transcript logs from
outside the sandbox — it adds nothing to what the sandboxed agent can see. The feature is off by
default (`glove.enabled`) and enabling or disabling it never affects native monitoring.

Only harnesses that persist a tailable transcript are discoverable this way today: **Mistral Vibe**
and **pi**. A network-hook harness inside a net-restricted sandbox cannot reach Layman and persists
nothing to tail, so it needs a different mechanism (a glove-provided forwarder), not `GloveSource`.

## How it works

`GloveSource` (`packages/server/src/monitor/sources.ts`) globs `~/.glove/envs/*/home/` and returns a
labelled `WatchRoot` for each harness log tree it finds there — a Vibe root (`.vibe/logs/session`)
and/or a pi root (`.pi/agent/sessions`), so one sandbox can yield both. Each root declares its own
`agentType` and an optional sandbox `label` (the env id). The passive watchers
(`VibeSessionWatcher`, `PiSessionWatcher`) each filter `roots()` down to the agent type they parse,
so the single shared `GloveSource` instance feeds both; native sources precede glove in the list, so
native wins any path collision. See the "Monitor sources" note in the root `CLAUDE.md` for the
`MonitorSource` abstraction this plugs into.

## Design notes

> These moved here from the root `CLAUDE.md` to keep it under its size limit.

### Read-only by design (`monitor/sources.ts`, `GloveConfigSchema`)

glove persists the sandboxed home on the host (bind-mounted to `/home/agent` inside the container —
glove v2 runs the harness non-root, but Layman reads the persisted *host* files so the in-container
path is irrelevant); Layman tails those already-persisted logs from outside. The feature adds nothing
to what the sandboxed agent can see — no new mount into the container, no egress — which is a
deliberate fit for glove's security model, and the reason the host mount is `:ro`. Interception /
blocking of a sandboxed harness would be a separate mechanism (a glove-provided forwarder) — this
watcher is logging only.

glove cooperates with this integration: its Vibe renderer pre-creates `home/.vibe/logs/session/` on
launch *specifically so an external monitor can attach before the first turn*
(`glove/harnessconfig.py`); pi's `home/.pi/agent/sessions/` is not pre-created and appears on pi's
first turn instead, which `GloveSource` picks up on the next scan tick.

**glove v2 also ships an experimental `claude-code` harness**, but `GloveSource` does not discover it:
native Claude Code uses live hooks and Layman has no *passive* Claude Code tail-watcher, so a gloved
Claude Code session would need one built (a new watcher, not just a `GloveSource` branch).

### The on-disk unit is an *environment*, not a session (glove `registry.py`)

An env is the pair `(invocation_dir, harness)` bound to a stable `env-id` (invocation-dir basename,
or `<base>-<harness>` for a second harness in one dir, or `<base>-<shorthash>` on a cross-dir basename
collision). All env state lives under `~/.glove/envs/<env-id>/`, which contains `glove.yaml`, the
`home/` tree Layman tails, **and** a `sessions/<name>/` subtree per `glove run --name` (compose file,
rendered enforcer policies, browser media) — none of which holds transcripts. Because transcripts
live in the shared `home/`, several named glove sessions of one env write into one
`home/.pi/agent/sessions` (or `.vibe/logs/session`) and are all tagged with the *env-id*, not the
glove session name — a deliberate fidelity trade-off, not a bug. `GloveSource` reads only
`<env-id>/home/…`; the sibling `glove.yaml`, `sessions/`, `registry.json`, and a stray `.DS_Store` are
ignored (`statSync().isDirectory()` guards the readdir). A power-user `config_home_source` override in
`glove.yaml` relocates `home/` outside `~/.glove/envs/`, where Layman's single-dir glob would not find
it.

### History import discovers glove pi sessions too (`recovery.ts`, `transcript-pi.ts`)

`discoverTranscriptFiles(gloveRoots)` scans, in addition to the native `~/.pi/agent/sessions` root,
every *pi* root the passive watchers report (`gloveSource.roots()` threaded from the two
`importHistoricalSessions()` call sites in `server.ts`), so a gloved pi run that was never monitored
live is still importable from **Settings -> Data -> Import session history**. Only pi is imported from
a sandbox: glove's experimental claude-code harness is not tailed (no passive Claude Code watcher —
see above), and Vibe has no history importer at all — so non-pi roots are filtered out, and
`gloveRoots` is empty when glove is disabled, leaving native import byte-for-byte unchanged. The env
id rides through `DiscoveredTranscript.label` into `importSession(..., sessionName)` so a gloved import
is tagged exactly like a passively-watched gloved session. Double-import against the live watcher is
prevented by the live-source rule (see the root `CLAUDE.md` history-enrichment note): a session the pi
watcher recorded is `source === 'live'` and is skipped.

## Docker

`${HOME}/.glove/envs` is mounted **read-only** (`:ro`) — it is the one mount Layman only ever reads,
never writes, because writing into a sandbox is exactly what the feature must not do. See the "Docker
mounts" note in the root `CLAUDE.md`.

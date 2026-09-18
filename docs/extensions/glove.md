# glove

[glove](https://github.com/glovebox-ai/glove) sandboxes a coding harness inside a container and
persists its fake home on the host under `~/.glove/envs/<env-id>/sessions/<name>/home/`. Layman monitors gloved
sessions **passively and read-only** by tailing those already-persisted transcript logs from
outside the sandbox — it adds nothing to what the sandboxed agent can see. The feature is off by
default (`glove.enabled`) and enabling or disabling it never affects native monitoring.

Only harnesses that persist a tailable transcript are discoverable this way today: **Mistral Vibe**
and **pi**. A network-hook harness inside a net-restricted sandbox cannot reach Layman and persists
nothing to tail, so it needs a different mechanism (a glove-provided forwarder), not `GloveSource`.

## How it works

`GloveSource` (`packages/server/src/monitor/sources.ts`) globs `~/.glove/envs/*/sessions/*/home/` and
returns a labelled `WatchRoot` for each harness log tree it finds there — a Vibe root
(`.vibe/logs/session`) and/or a pi root (`.pi/agent/sessions`), so one sandbox can yield both. Each
root declares its own `agentType` and an optional sandbox `label` (glove's session token — the env id
for the default session, else `<env-id>-<name>`). For envs created by older glove (or a
`config_home_source` override), which persist a single env-level `<env-id>/home/`, it falls back to
that home when the env has no per-session home — never both, so a session that a glove upgrade left
copied under both is not tailed and recorded twice. The passive watchers
(`VibeSessionWatcher`, `PiSessionWatcher`) each filter `roots()` down to the agent type they parse,
so the single shared `GloveSource` instance feeds both; native sources precede glove in the list, so
native wins any path collision. See the "Monitor sources" note in the root `CLAUDE.md` for the
`MonitorSource` abstraction this plugs into.

A `config_home_source` override can relocate a home **entirely outside** `~/.glove/envs/`, where the
per-session/env-level globbing above structurally cannot reach it. glove records the run-time-resolved
`home` per env in **`~/.glove/registry.json`** — the single canonical pointer — so `GloveSource` reads
that registry and, for any env whose recorded home lies outside the sessions dir, probes it too (a
registry home *inside* the sessions dir is left to enumeration, which already owns it, so it is never
tailed twice). Registry `home` paths are absolute *host* paths; in the container they are rebased from
`HOST_HOME` onto the container home before probing (native Layman leaves this a no-op). Reads are
best-effort: a missing or malformed registry — including a stray non-object array element — degrades
to enumeration. The full design — the glove-side registry field, the host→container translation, and
the mount contract (a relocated home that a containerized Layman watches lives under `~/.glove`) — is
in [`docs/planning/glove-session-discovery.md`](../planning/glove-session-discovery.md).

As a **registry-independent fallback**, `GloveSource` also enumerates `~/.glove/homes/<env-id>/`
directly (a sibling of the sessions dir). glove's launcher scripts relocate a home there
(`config_home_source: ~/.glove/homes/<env-id>`), and the mount contract already keeps any watched
relocated home under `~/.glove`, so a session is discovered even when glove never recorded its `home`.
That is exactly what a `glove <harness> --env X --config Y` one-off produces: a forced `--env` with
`--config` (no prior `glove init`) is *not registered*, so `record_home` finds no registry row to
update and writes nothing — leaving the registry blind to the session. Enumerating `homes/` closes
that gap without depending on the registry being complete. It is redundant with the registry on
purpose; the same in-scan `probed` set that guards enumeration collapses a home found by both paths to
a single tail, so the no-double-tail invariant holds. The paired glove-side fix — registering the
forced `--env` so the registry stays complete for every consumer — lives in the glove repo.

## Design notes

> These moved here from the root `CLAUDE.md` to keep it under its size limit.

### Gloved sessions always activate on the Dashboard (`pi/watcher.ts`, `vibe/watcher.ts`)

Activation — the gate flag `buildSessionsList()` reads as a session's `active`, which the Dashboard
filters on (`DashboardView.tsx`: `s.active !== false`) — is normally driven by `autoActivateClients`
or the `/layman` slash command. A gloved session has neither path: `/layman` runs *inside* the
sandbox and cannot reach the host, and the sandbox agent never posts hooks. So a passively-tailed
session whose `WatchRoot` carries a `label` (i.e. it came from `GloveSource`) **always activates**,
independent of `autoActivateClients`; native (unlabelled) roots keep the `autoActivateClients` gate.
Both watchers apply this through a shared `shouldActivate(agentType, label)` helper, at add *and* at
resume time — a session tombstoned by the 15-minute idle timeout re-activates when its transcript
grows again, so it returns to the Dashboard on the next prompt rather than staying hidden. Without
this, a gloved run recorded to Sessions history but never appeared live on the Dashboard unless its
agent type happened to be in `autoActivateClients` — the reason gloved Vibe (in the list by default)
worked while gloved pi did not.

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
collision). All env state lives under `~/.glove/envs/<env-id>/`, which contains `glove.yaml` and a
`sessions/<name>/` subtree per `glove run --name` (compose file, rendered enforcer policies, browser
media) — **and the harness home Layman tails is inside that subtree**, at `sessions/<name>/home/`.
glove's `_home_dir()` resolves the home per session, not per env, because the rendered harness config
embeds session-scoped values (its own LLM sidecar URL) that two live sessions must not share; the
default unnamed session is named after the env, so its home is `sessions/<env-id>/home/`. Each session
is therefore tagged with glove's session token (`<env-id>` for the default, else `<env-id>-<name>`),
not one shared env-id — a change from older glove, which bind-mounted a single env-level
`<env-id>/home/` and where all of an env's sessions did share one home. `GloveSource` prefers the
per-session homes and reads the env-level `home/` only as a fallback for legacy envs; sibling
`glove.yaml`, `registry.json`, and a stray `.DS_Store` are ignored (`statSync().isDirectory()` guards
each readdir). A power-user `config_home_source` override relocates the home outside
`~/.glove/envs/<env-id>/`; when the relocated home lands outside the sessions dir, where the glob
cannot find it, `GloveSource` follows it via the resolved `home` glove records in
`~/.glove/registry.json` (see [`glove-session-discovery.md`](../planning/glove-session-discovery.md)),
translating the host path onto the container home and requiring — for a containerized Layman — that
the relocated home live under `~/.glove`.

### History import discovers glove pi *and* Vibe sessions too (`recovery.ts`, `transcript-pi.ts`, `transcript-vibe.ts`)

`discoverTranscriptFiles(gloveRoots)` scans, in addition to the native `~/.pi/agent/sessions` and
`~/.vibe/logs/session` roots, every *pi* and *Vibe* root the passive watchers report
(`gloveSource.roots()` threaded from the two `importHistoricalSessions()` call sites in `server.ts`),
so a gloved pi or Vibe run that was never monitored live is still importable from **Settings -> Data ->
Import session history**. Each importer filters `gloveRoots` down to the agent type it parses
(`discoverGlovePiSessions` / `discoverGloveVibeSessions`), exactly as the passive watchers do; glove's
experimental claude-code harness is still not imported (no passive Claude Code watcher — see above), so
its roots are ignored. `gloveRoots` is empty when glove is disabled, leaving native import byte-for-byte
unchanged. The env id rides through `DiscoveredTranscript.label` into `importSession(..., sessionName)`
so a gloved import is tagged exactly like a passively-watched gloved session. Double-import against the
live watcher is prevented by the live-source rule (see the root `CLAUDE.md` history-enrichment note): a
session a watcher recorded is `source === 'live'` and is skipped.

Vibe's transcript carries no per-message timestamp (the live watcher stamps `Date.now()`), so the Vibe
importer reads each session's real span from `meta.json` (`start_time`/`end_time`) at discovery and
spreads the imported events across it — otherwise every imported Vibe session would land on the import
date rather than the day it ran. See the file header of `transcript-vibe.ts` for the discover→parse
hand-off this relies on.

## Docker

`${HOME}/.glove/envs` is mounted **read-only** (`:ro`) — it is the one mount Layman only ever reads,
never writes, because writing into a sandbox is exactly what the feature must not do. See the "Docker
mounts" note in the root `CLAUDE.md`.

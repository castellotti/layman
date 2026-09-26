# glove

[glove](https://github.com/glovebox-ai/glove) sandboxes a coding harness inside a container and
persists its fake home on the host under `~/.glove/envs/<env-id>/sessions/<name>/home/`. Layman monitors gloved
sessions **passively and read-only** by tailing those already-persisted transcript logs from
outside the sandbox — it adds nothing to what the sandboxed agent can see. The feature is off by
default (`glove.enabled`) and enabling or disabling it never affects native monitoring. The one thing
Layman ever writes is a session's network rules file, `~/.glove/control/<env>/<name>/rules.json`,
outside the sandbox and only when the user blocks or allows something (Network → Writing rules).

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
purpose, and the no-double-tail invariant is held by a single `handledEnvs` set — every env id the
registry or enumeration already resolved authoritatively. The convention loop skips any env in that
set, which covers both overlap shapes at once: the **same-tree** case (registry and convention name
the identical home) and the **stale** case (the env's real home is elsewhere but a dead `homes/<env>`
lingers from a prior one-off, a different path a raw dedup could not collapse). Because the env id is
the `homes/<env>` dir name, the skip lands before the twin is ever probed. Registry homes are
canonicalized where they are read (glove may record a `home` with a trailing slash, which `path.join`
preserves; every other home is built from slash-free segments), so the `probed` path dedup stays
spelling-agnostic without a per-probe workaround. The paired glove-side fix — registering the forced
`--env` so the registry stays complete for every consumer — lives in the glove repo.

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
watcher is logging only. (Blocking *network traffic* is different: glove's gate reads a rules file
Layman may write, outside the sandbox; see Network → Writing rules.)

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

## Network

glove's netgate records every connection a sandboxed session makes, and Layman renders it as the
Network, Map, Topology and Trace tabs. The implementation plan is
[`docs/planning/network-views.md`](../planning/network-views.md); glove's data contract, frozen at v1,
is glove's `docs/planning/network-observability-layman-handoff.md` ("the handoff"), and wins over the
plan on any question of data format. Code: `packages/server/src/netobs/`. What is built so far: the
**read side** (discovery, tailing, the store, classification, `net:*` WebSocket frames and a REST
snapshot), the **client shell** shared by the four tabs, the **Network tab**, **writing rules** and the
**Map tab** with offline geolocation, and the **Topology tab**. Correlation with the transcript (Trace)
and persistence come in later phases.

glove answered Layman's follow-up questions in its
`docs/planning/network-observability-layman-followup-results.md` (glove branch
`netobs-layman-followup`): fail-closed on an unreadable `rules.json`, the permission contract for the
rules writer, hash-based write confirmation, gate lifecycle records, and a scenario fixture for every
state its first fixture lacked. What that changed on the read side is below, and the writer follows its
contract (Writing rules).

### The rule that must not be relaxed

glove resolves destination hostnames *inside the tunnel* so the operator's resolver never sees them.
**Layman never makes a network call keyed on gloved flow data** — no DNS or reverse-DNS lookup, geo-IP
API, favicon fetch, link unfurl or WHOIS, however much prettier the label would be. Any such call leaks
the sandboxed agent's browsing history to the host's resolver and undoes glove's design; it is a
privacy bug, not a missing feature. Geolocation will be a local file read or nothing. A deliberately
crude test (`netobs/index.test.ts`, "no-network guard") fails any `netobs/` source file that imports
`dns`, `net`, `http(s)` or `tls`, calls `fetch(` on anything but `/api/`, opens a WebSocket, or mentions
`favicon`. `domain.ts` even carries its own IP-literal check rather than importing `node:net`'s `isIP`,
so the guard needs no exemptions.

### What is read, and from where

Per session, `~/.glove/envs/<env>/sessions/<name>/net/`: `flows.ndjson` and its rotated
`flows-<stamp>.ndjson`, `exit.ndjson` (which rotates the same way), `status.json`, `session.json`; and
`~/.glove/control/<env>/<name>/rules.json`. All of it is inside the existing read-only `~/.glove`
mount; only writing rules needs the extra `control/` mount (Docker, below).

- **Discovery is a plain glob** (`discovery.ts`), deliberately not routed through `GloveSource`: that
  source grew registry and `homes/` handling because a harness *home* can be relocated, but `net/`
  never leaves the session directory (handoff §1).
- **Token and paths.** A session's token is `<env>` for the default session (whose directory is named
  after the env) and `<env>-<name>` otherwise. It is the value flows carry in `session` and the label
  `GloveSource` gives the Layman sessions it tails, so network data joins the transcript by it. The
  control path uses the **directory name** `<name>`, while the rules file's own `session` field is the
  **token**; for a named session the two differ, and mixing them up makes the gate ignore the file.
  Env and session names must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and the resolved control path must
  stay inside `~/.glove/control`, or the session is skipped — those names later address the one
  directory Layman will be allowed to write.
- **Reading is tolerant** (`parse.ts`): unknown fields are ignored, an unknown record `type` is skipped,
  and a line that does not parse or carries `v` other than 1 is counted (`counters.invalid`), never
  thrown. A glove-side addition must never break a deployed Layman.

### Tailing: content, not inodes

`tail.ts` polls every second (inotify does not cross Docker Desktop's file sharing; glove made the same
choice) and reads each file from a byte offset, buffering a trailing partial line — as bytes, so a
multi-byte character split across two reads is never mis-decoded. glove rotates by renaming
`flows.ndjson` to `flows-<stamp>.ndjson` and creating a fresh file at once, and a flow's `close` can land
in a newer file than its `open`, so the unread tail of the old file must be drained by its new name.

The obvious way to find it — and what the plan and glove's own reference tailer describe — is by inode.
**That does not work where Layman usually runs.** Through Docker Desktop's bind mount, inode numbers are
not stable across a host-side rename: measured on this machine, `flows.ndjson` at inode 192 reappeared
after rotation as the rotated file at inode 194. Matching by inode found nothing, counted a gap, and
then re-read the rotated file as unseen, on every rotation (bytes stayed right only because they are
cumulative and deduplicated by flow id). The tailer therefore identifies a file by its **first bytes**
(up to 1 KB, which include a ULID and a timestamp): the live file has rotated when it no longer starts
with the bytes read from it, or is shorter than the offset; the file to drain is the rotated one that
does start with them; any other file rotated meanwhile is read whole, in rotation order, told apart by
name (glove never reuses one). Rotation order comes from the parsed `(stamp, n)`, not from sorting
names: `…Z-1.ndjson`, glove's same-millisecond collision name, sorts *before* `…Z.ndjson` because `-`
precedes `.`. Verified live against the container across ~70 rotations: every line read exactly once,
no gaps. Two tests in `tail.test.ts` simulate the new-inode rename with a copy, so a change back to
inode matching fails.

Backfill at startup reads rotated files oldest first, then the live file, within a 64 MB budget per
session; over budget the newest files win (they hold the open flows) and the snapshot says
`historyTruncated`. `status.json` and `session.json` are rewritten in place, so a read that fails to
parse is taken to be torn: the previous value is kept and the file re-read next tick. `rules.json` is
always replaced atomically, so there an unparseable file is its real content and is shown as such.

### The store, and why it is not `EventStore`

`update` records arrive about once a second for every open flow. `EventStore.add()` would PII-scan each
one, push it onto the 10,000-entry ring (evicting real events), record it to SQLite and broadcast it —
the "ruinous for a token delta" case the root `CLAUDE.md` documents for live token streaming. Network
data gets its own `NetStore` (`store.ts`) and its own frames, as `LiveStreamStore` does.

- **No PII filter on flow records.** They are hostnames, IPs, ports and byte counts from glove's
  collector, not agent-authored text, and redacting hostnames would make the feature useless. The one
  exception is `request` in `record: "full"` mode, whose URL and header values go through the same
  `redactString` the live stream uses before they leave the server.
- **Bytes are cumulative**, so a flow's total is its latest record's and rates are the differences,
  bucketed per second (1 s for the last hour, then 1 min). A dropped `update` costs resolution, not
  accuracy. `dest` is taken from the latest record too: when it is refined after `open`, the flow's
  whole contribution moves to the new destination (`removedDestinations` in the delta says which row
  emptied).
- **Aggregates are running sums** per destination (host + port; a null host is keyed by the service
  endpoint it arrived on, from `session.json`), maintained by subtracting a flow's previous
  contribution and adding its new one. Closed flows are evicted beyond 5,000 per session without
  changing a total.
- **Empty connections are folded**, not listed: an allowed flow with no destination that closed on
  `eof`/`timeout` is proxy noise (handoff §2), counted in `emptyFolded`.
- Sparklines anchor on the session's latest record, not the wall clock, so when a gate stops its
  sparklines freeze rather than drain. There is one per destination and one per flow (the table draws
  both), each the last 60 s at 1 s, sent sparse: a flow with nothing in the window sends an empty list.
- **Grouping by registrable domain** (`domain.ts`: `en.wikipedia.org` → `wikipedia.org`; IPs,
  single-label and private-TLD names such as `llm.operator.lan` are their own groups) runs on the server
  so there is one implementation, using `tldts`, which bundles the Public Suffix List (so grouping is a
  string operation, never a lookup). A TLD not on the list is an operator's own name, not a public
  registry, and grouping one level up would invent an organisation boundary.

### States (`classify.ts`)

The single place state is decided; the web client receives results and never re-derives them. A flow
has one primary `NetState` — `active`, `pooled` (open, no byte change for over 3 s), `finished`, `guard`
(`builtin:*`, never user-toggleable), `user_rule`, `default_block` (block with `rule: null`), `broken`
(an upstream failure, not a policy decision), `gate_shutdown`, `empty` — plus orthogonal `FlowFlags`
(scope, unresolved, no host, cleartext, fan-out). Blocks are recognised by `close_reason: "blocked"` as
well as by verdict, because a `terminate: true` rule cuts an already-allowed flow. Session-wide states
come from `classifySession()`: gate freshness (`stale` when a `running` gate's heartbeat is over 20 s
old, falling back to `status.json`'s mtime for a gate that writes no `t`), route declared vs verified
(verified only while the latest exit is healthy; with `exit_identity: "none"` "declared" is expected,
not an error), resolver, rules load result, telemetry, and unobserved services.

`gate_lost` is the tenth state, from glove's follow-up: an unclosed flow whose forwarder has gone (next
section). It is not "open" in any sense the UI means, so `totals.openFlows` and a destination's
`openFlows` leave it out and `totals.gateLost` counts it. `status.json`'s `rules` also carries glove's
new `sha256` (of the file now enforced) and `last_rejected` (`{checked_at, source_mtime, sha256, error}`,
kept after a later acceptance); they are parsed now and are how the rules writer will confirm a write.

### Gate lifecycle: flows that never close

Before glove's follow-up, a forwarder killed with SIGKILL left its open flows looking pooled forever:
nothing ever wrote their `close`, and `restart: unless-stopped` does not restart a killed container. glove
now tags every flow record with `run` (the forwarder process, `g_<ULID>`) and writes `type: "gate"`
start/stop records into `flows.ndjson`, including an `"inferred": true` stop for a forwarder silent for
30 s. The reader rule: in file order, a run ends at a `stop` for it, or when a later run appears for the
same service; any later record of the run revives it; an unclosed flow of an ended run was cut by the
gate going away.

`NetStore.ingestGate()` and `noteRun()` are a **port of glove's reference `glove.netview.ended_runs`**,
and must stay one: two readers that disagree about which flows are live is exactly the bug class this
avoids. Three details come straight from the reference. A `stop` ends only its own run and never
displaces the service's current one — glove fixed this during the follow-up (`d855a1c`) after a crashed
run's late inferred stop ended its restarted replacement. A later record of an *older* run makes it the
service's current run again, ending the newer one. Collector records (`role: "collect"`) are skipped.
`lifecycle.crosscheck.test.ts` enforces the port by running glove's own function (through `uv`) on every
scenario fixture and on 300 seeded random sequences of starts, stops, collector records and flows, and
requiring identical ended runs. It was checked to fail on the first draft of the port, which revived an
old run without making it current. It is skipped when glove or `uv` is not beside the repo. A flow with
no `run` (an older gate) is never judged by the rule.

### Frames and coalescing

On connect a socket receives `net:sessions` only — a Layman user who never opens the tabs never pays for
flow data. `net:subscribe { token }` (one session per socket) returns a `net:snapshot` (every open flow
plus the latest closed ones, up to 500), then `net:delta`s coalesced to at most one per session per
500 ms, each carrying the latest full value of whatever changed (so applying one twice is harmless).
`net:status`, `net:exit` and `net:rules` are sent as they change. A session nobody is subscribed to
accumulates nothing. The list is re-broadcast only when something the picker shows changes. REST mirrors
it: `GET /api/net/sessions`, `/api/net/sessions/:token` (the snapshot), `…/flows?since=&limit=`, and
`…/buckets?window=60s|5m|1h|session`.

### The client shell

The header gains `Network  Map  Topology  Trace` between their own dividers — **only** when
`glove.enabled` (and `glove.network.enabled`) and the server has listed at least one glove session with a
`net/` directory. Otherwise the header is unchanged; this was checked by comparing the rendered tab bar
with glove off against a pre-feature build, and they are identical. The four tabs are exclusive
full-content views like Flow (`isNetworkView()` in `sessionStore.ts`; excluded from `inLiveMode`),
lazy-loaded as one chunk (`components/network/NetworkView.tsx`), with keys `N`, `M`, `O`, `T` (unbound
elsewhere) active only while the group is shown. The Network label carries a dot: red while a
*running* gate reports rejected rules or has carried untunnelled traffic, teal while any gate runs,
nothing for finished sessions (their history is not an alarm).

- **Data and selection live apart.** The network data is in `stores/netStore.ts`, fed by
  `lib/net-state.ts` (a pure reducer, so it is tested in node), because deltas arrive up to twice a
  second and nothing outside these tabs should re-render on them. *Which* glove session and *which*
  destination are view state in `sessionStore` (`netToken`, `netDest`), because the URL is derived from
  them — the root `CLAUDE.md` rule that anything hydration sets must be readable back out.
- **URLs.** `/?view=network|map|topology|trace&glove=<token>&dest=<host>` (both copies of the grammar,
  round-trip tested in both packages). `routeForState` checks the network views *before* a leftover
  `/f/` folder id, which would otherwise outrank them. Changing the glove session pushes a history
  entry; changing tab or destination replaces (like every view on the dashboard route). A bare
  `/?view=network` shows the default session — the one matching the active Layman session's
  `sessionName`, else the most recently active — and writes it into the URL by **replacing**, because
  pushing would make Back land on the bare URL, re-default and push again (`historyModeFor`, tested).
- **Subscription.** The view subscribes the socket to the shown session, re-subscribes after a
  reconnect (the server forgets subscriptions with the socket) and unsubscribes when the tabs close, so a
  dashboard that is not looking stops receiving deltas.
- **Gate strip** (`GateStrip.tsx`, chips derived by `gateChips()` in `lib/net-format.ts`, tested): the
  glove session picker, then gate state, the untunnelled alarm straight after it (the mockups' order, so
  it is the last thing clipped), route and exit (the exit's `source` is in the tooltip: Layman did not
  determine it), resolver, rules, record mode, and "View incomplete" when the gate dropped records, a
  rotated file vanished, or backfill hit its budget. The chip row shrinks and scrolls sideways before the
  Panels chips on the right would be cut — found at 1440 px, where a stale gate's longer label pushed the
  last Panels chip off screen.
- **Rules rejected** pins a red `role="alert"` banner under the strip on all four tabs, with "Show file".
  The path it shows is the **host** path (`RulesView.displayPath`, via `toHostPath()` using `HOST_HOME`);
  showing the container's `/root/.glove/…` would send the user to a file that does not exist on their
  machine. An error beginning `cannot read` gets its own wording: since glove's follow-up an *unreadable*
  file is a rejection too (it used to fail open), and it almost always means ownership, not content.
  "Revert" and "Try again" arrive with the rules writer.
- **Panels** (`lib/net-panels.ts`, `hooks/useNetPanels.ts`, reusing `useDragReorder`): each tab's panels
  are shown or hidden from the chips and reordered by dragging the header grip, persisted per tab in
  localStorage. A per-viewer convenience, so reads are tolerant: unknown ids are dropped and a panel
  added later appears after its default neighbour.
- A web no-network guard (`lib/net-guard.test.ts`) mirrors the server's over `components/network/`,
  `lib/net-*`, `netStore` and `useNetPanels`.

### The Network tab

Built from `network-ledger.dc.html`: a KPI row, then the Destinations table (main column) and the mini
map and Rules panels (side column), plus Activity and Details, off by default. Details is the Map's
detail card, docked (The Map tab, below). Activity (`ActivityChart.tsx`) draws received and sent bytes as
bars over 1m / 5m / 1h, from the client's own 1 s buckets, or over the whole session from
`GET …/buckets?window=session`. All deciding is in pure, tested modules; the components draw.

- **The state legend is data** (`NET_LEGEND` in `lib/net-format.ts`): one entry per row of handoff §6.1,
  plus cleartext HTTP, each with its label, data rule, icon, colour, badge, toggle kind, map treatment and
  explanation, and `NET_STATE_INFO` mapping every `NetState` to its entry. Every view reads colours and
  toggles from it, so the legend and the views cannot disagree. The Map, Topology and Trace tabs will use
  the same table.
- **The table model** (`lib/net-table.ts`, `buildTable()`) turns destinations and flows into rows:
  group → host → flow, grouped by registrable domain (default), route or tool, and sorted by most recent
  or most bytes. A group whose only host *is* the group (`arxiv.org`) is drawn as that host, with no extra
  level; `wikipedia.org` keeps its level because its host is `en.wikipedia.org`. Four groups are fixed
  whatever the grouping: Search fan-out, Local links, Refused by glove guard, and Not watched (declared
  `observed: false` services, which have no records at all). The guard and Not watched groups start
  expanded: they are what a glance should catch. The mockup drew guard refusals as loose rows; the plan
  requires the fixed group, and it wins. Not watched rows appear only unfiltered, since they have nothing
  to match a filter on. Filter chips (All, Live, Blocked, Broken, Local, with counts) and a text filter
  over host, IP, tool, service, rule id and rule note apply per destination. A host expands to its flows
  newest first; a destination with more flows than the client holds says how many were not loaded. The
  footer counts folded empty connections, with "show" to list them.
- **What each cell says** is decided there too: `live · 380 KB/s` (the last 3 s of the sparkline),
  `pooled · idle 4 s`, `finished · eof`, `finished · cleartext http`, `path broken · upstream`,
  `refused by glove guard` / `refused · malformed request`, `blocked · your rule “ads”` (the note from
  rules.json), `blocked · nothing allowed it`, `cut · gate shut down`, `cut · gate went away (inferred)`.
  Untunnelled traffic keeps its state but is prefixed `untunnelled ·` in red, with a tinted row and a red
  left edge; the route cell says `never left` for refusals, `local`, `Direct`, or the declared route. A
  guard refusal's sublabel says why (`cloud metadata`, `internal name`, `private address`, `no
  destination`), a user rule's shows its match pattern. The Playwright pass checks that every one of
  these renders somewhere across the scenario sessions.
- **Windowing** past 200 rows: `windowRange()` computes the visible slice and spacer heights from a prefix
  sum of the two row heights (30 px for top-level rows, 28 px below), with no dependency. Checked with a
  301-row session: 30 rows in the DOM, and scrolling reaches the last row.
- **Toggles are real buttons** (`NetToggle` in `cells.tsx`): `aria-pressed`, and an `aria-label` naming
  the verb and target ("Block arxiv.org", "Unblock …", "Allow …"). The kinds are drawn as the legend says:
  allow filled teal, your rule filled red, default outlined red, guard dashed amber with a lock and always
  disabled. A group gets a toggle only when all its members agree on one. What they do is under Writing
  rules below.
- **KPIs**: Sent, Received, Live (open flows, plus how many were lost with their gate), Destinations (to
  map, unknown location), Blocked (by guard / your rules / the default), Untunnelled (green "every egress
  flow used the VPN" at zero, otherwise a red `role="alert"` tile).
- **Rules panel** (`RulesPanel.tsx`): whether the gate enforces what is on disk, evaluation order
  (glove's guard as locked row 0 with its hit count, then the file's rules with theirs, and a `CUTS OPEN`
  badge for `terminate`), the default policy, and editing (Writing rules, below). When the gate has **rejected** the file, the list is headed "In
  rules.json · not enforced": the file on disk is not what the gate enforces, and Layman cannot see the
  set that is. Listing it as the evaluation order would claim otherwise. Hit counts come from the
  destination aggregates (each destination's block count under its latest rule), so they undercount a
  destination blocked by two different rules over time. "View file" shows the host path and the file.
- **Mini map** is the Map tab's renderer at small size (no labels, no pan or zoom), with how many
  destinations are placed and how many are in Unknown location. A click opens the Map tab with the
  selection kept.

### Writing rules

Blocking and unblocking (plan §5.3, §6.4; `controls-block-unblock.dc.html`). This is the only place
Layman writes into `~/.glove`. It follows glove's contract for a second writer: its follow-up results
§3, as revised by its `layman-independence-results.md` §3 (glove PR #12). That contract overrode the
plan in three places:

- **Never create the control directory.** glove creates `control/<env>/<name>/` (0700, the user's) when
  it renders a session with a gate. If it is absent the session has no gate yet, and the toggles say so
  (`control.state: 'no-dir'`). The plan had Layman create it.
- **A file the gate's user can read, and no ownership changes** (`writer.ts`). The gate runs as the
  user who ran glove and only reads the file. So Layman writes `rules.json.layman.tmp` in that
  directory, fsyncs it, `chmod 0644`s it **explicitly**, and renames it onto `rules.json`. On any
  failure the temp file is deleted.
  - *Explicitly*, because through the umask a root writer with umask 077 leaves `root:root 0600`,
    which the gate cannot read. A test writes under `umask 077` in a child process, and fails if the
    explicit chmod is removed.
  - 0644 exposes nothing: the session directory is 0700 and the user's.
  - glove's CLI can still replace a root-owned file, because a rename needs write permission on the
    directory.

  The first version of this contract had Layman chown the file to the directory's owner and set 0600.
  glove dropped that at Layman's request so that Layman changes no ownership at all, and verified the
  0644 form on Docker Desktop and on rootless and rootful Podman. The writer refuses a directory that
  is a symlink or not exactly `control/<env>/<name>`, and never writes anything else there. The plan
  used a shared `rules.json.tmp` name, which another writer could clobber.
- **Confirm by hash, not time** (`control.ts`). `status.json` `rules.sha256` names the bytes the gate
  enforces and `rules.last_rejected.sha256` the bytes it last refused. So a write is `enforced` or
  `rejected` by its own hash, `superseded` when the file on disk no longer holds it (another writer),
  and `pending`, then `unconfirmed` after 10 s. The plan's timestamp rule could not detect a rejection
  at all, because `loaded_at` does not move on one. Confirmation lags enforcement by up to ~5 s (the
  collector re-reads the file when it writes `status.json`).

How it is built:

- **The validator is a port of glove's `policy.py`** (`rules.ts`). It covers every rejection, Python's
  quirks included: `v: true` passes as 1, an explicit `terminate: null` fails, netmasks and hostmasks
  in `ip`, and IPv6 scope ids accepted and ignored, which the cross-check found. Layman refuses to
  write anything it rejects. `rules.crosscheck.test.ts` feeds ~120 files and a set of flows to both
  the port and glove's own `parse_bytes` / `RuleSet.evaluate`, requires identical verdicts and matching
  rules, and runs `glove net validate` on a file Layman wrote. It is skipped without glove or `uv`.
  Known and harmless: JSON cannot tell `443.0` from `443`, which Python rejects as a port; Layman never
  writes the former.
- **Operations** (`RulesOp`, applied to a fresh read, new rules on top): `blockHost`, `blockDomain`
  (two rules, `apex` and `*.apex`, ids `<stem>-apex` / `<stem>-sub` so removing one removes the pair),
  `blockIp`, `blockGroup` (one rule for fan-out, local links, a route or a tool), `allowHost`,
  `allowDomain`, `removeRule`, `setDefault`, `cutAll` / `restoreAll`, `saveDraft`, `revert` and
  `rewrite`. `cutAll` writes `default: block` plus terminating block rules for the three scopes, after
  an `allow service: llm` when the LLM link is kept. Its rules carry the id prefix `r_layman_cut_` and
  record the previous default in their note, so `restoreAll` needs no state outside the file.
  `saveDraft` is refused unless the file still has the hash the draft started from.
- **Refuse to clobber.** If the file on disk is one the gate would reject, every operation but `revert`
  is refused: someone else's broken write is theirs to fix. `revert` writes back the bytes the gate
  enforces. Layman remembers every valid version it has read, by hash, so it knows those bytes after a
  rejection; if the gate enforces "no file", it removes the file. `rewrite` ("Try again") writes the
  current, valid file again through the contract (0644). That is what fixes a file the gate cannot read.
- **What the toggles show.** The server evaluates each destination (host, first IP, port, service,
  tool, scope) against both the *enforced* set and the file on disk, and sends both
  (`DestinationAggregate.policy`). The toggle shows the enforced verdict, so a rejected write springs
  back by itself, and shows `pending` while the two differ. The observed state column stays the
  authority on what actually happened.
- **The UI.** A toggle opens a popover. For an allowed destination, Block offers this host, the domain
  and every subdomain, or this IP (with the shared-CDN warning), plus "also cut the N open connections"
  (checked when there are some), a note, and the exact JSON. For your own rule, Unblock offers removing
  the rule or rule pair ("unblocks every host it matches (N seen)"), or allowing only this host above
  it. A default block offers Allow host / Allow domain. The Rules panel edits a draft (drag to reorder,
  delete, Add rule with the six permitted match keys, the default policy) and saves it as one write.
  When the file changes under a draft, the draft is rebased (your additions on top, your deletions
  kept, everything else from the new file) and a conflict notice says so. "Cut all traffic now"
  confirms first, with "Keep the LLM link open" checked by default. The strip then shows
  **ALL TRAFFIC CUT** with Restore. The rejected banner gained "Revert to enforced rules" and "Try again".
  A toast reports a failed write, and any change to rules.json that was not Layman's.
- **When toggles cannot act**, they say why: `glove.network.controlEnabled` off (Settings → Glove →
  Allow blocking from Layman), no control directory, a read-only mount (checked with `access(W_OK)`,
  never a probe file, since glove's contract forbids other files there), an invalid file, or a write
  still waiting for the gate.
- **Wire.** `net:rules:apply { token, op, opId }` over the socket and `POST
  /api/net/sessions/:token/rules { op }` over REST share `NetObs.applyRules`. The response says whether
  the write reached disk (`net:rules:result`, or 409 with the reason); the gate's verdict follows in
  `net:rules` (`rules.write.state`).
- **Checked in the running app** against the fake gate: block → pending → enforced → later flows
  refused by the rule, with owner and mode right on the host; unblock from the same row; allow a
  default block; a draft saved; cut and restore; an outside edit toasted; a hand-broken file shows the
  banner on all four tabs while the toggles keep showing the enforced rules; revert restores the exact
  bytes.

### The Map tab

Built from `map-route-map.dc.html`, with mockup A's Connection section in the detail card.

- **Offline, bundled map.** Natural Earth land (`world-atlas` `land-50m`, public domain) drawn with
  `d3-geo` and `topojson-client`. It is imported lazily into its own chunk (~174 KB gzipped) that
  Layman serves itself, and only when a map is shown. Nothing is fetched from anywhere else: no tiles,
  no fonts, no lookups. The phase 5 browser check records every request the page makes across the Map,
  Network and Settings pages, and requires all of them to go to Layman.
- **Geolocation is a local file read** (`netobs/geo.ts`, `mmdb-lib` on the server). The user downloads
  a MaxMind-format city database themselves; DB-IP's "IP to City Lite" (CC BY 4.0, no account) is the
  suggestion. They point Settings → Glove → Geolocation database at it. In Docker it must be in a
  mounted folder, so the suggested place is Layman's own data folder, `~/.local/share/layman/`, which
  is already mounted. Layman ships no database.
  - Only a destination IP glove resolved **inside the tunnel** (or that was a literal) is looked up,
    never a local link, and never the exit, which is placed from exit.ndjson's own `lat`/`lon`.
  - Results are cached per IP. The database is re-opened when the setting or the file changes, and every
    destination is then re-sent.
  - No database, or no entry, means "Unknown location".
  - `GET /api/net/geo` reports the state. While a database is in use, the legend and Settings show its
    credit ("IP geolocation by DB-IP", which CC BY 4.0 requires, or the file's own type otherwise).
- **Tests without a database.** `netobs/testing/mmdb-writer.ts` is a small writer for the MMDB format,
  used only by tests and by the replay script's `--demo-geo <file>`. That option writes a database
  typed "Layman-Demo-City", whose metadata says it is not real data, placing the fixtures' IPs in
  plausible cities. The writer's output is read through `mmdb-lib` itself, so the tests exercise the
  real reader on the real format.
- **Geometry** (`lib/net-geo.ts`, pure and tested):
  - **Projection.** Mercator, fitted to the exit and the placed destinations, widened to at least
    50°×25°, clipped to 84°N–58°S, with a North-Atlantic view when nothing is placed.
  - **Fitted clear of the cards.** The fit leaves room for the cards over the map: the tall top-corner
    cards take a side, the bottom ones a strip.
  - **The fit is a set of corner points, not a polygon.** d3-geo reads a ring's winding as which side is
    inside, and the first version's counter-clockwise box fitted "everything but the box", i.e. the
    whole world. A test pins it.
  - **Arcs and pins.** Arcs are great circles (48 samples, split at the antimeridian), 1–3.5 px by the
    square root of bytes. Destinations in one city share a pin with a count.
  - **Unknown location** is what left the sandbox but cannot be placed.
  - **The ribbon** has one lane per flow in the last 60 s.
- **The trunk and the sandbox.** The sandbox is not a place: it is a card in a corner, and the trunk
  runs from that card's edge to the exit pin. It is solid when the exit is verified, dashed when the
  route is only declared, and absent for a direct or point-to-point route. With no exit to pin, arcs
  leave from the card itself, dashed. Untunnelled destinations get a red dashed curve straight from the
  sandbox that skips the exit, plus a red banner with "Block direct egress", which writes one terminating
  `scope: direct` rule. The banner cannot be dismissed while such traffic exists.
- **Renderer** (`WorldMap.tsx`): SVG. Land and graticule are projected once per size change and
  panned and zoomed with a transform (drag, wheel about the cursor, +/−, reset) and non-scaling strokes.
  Pins and labels are placed in screen space so they stay crisp. A drag never starts on a pin or a
  control, because the drag's pointer capture would swallow their click; the zoom buttons were dead
  until that was fixed. Live arcs have a moving dash, which `prefers-reduced-motion` turns off (checked
  in the browser).
- **Cards** (`MapView.tsx`), each hidable from the Panels chips and draggable by its grip to another
  corner (remembered per viewer in localStorage):
  - **Talking now**: open destinations by live rate with their toggles, plus finished / refused /
    blocked / broken counts that switch the list.
  - **Unknown location**.
  - **Details** (`DetailCard.tsx`).
  - **This sandbox**: local links and unwatched services.
  - **Legend**, with the database credit.
  - **The last 60 seconds**, a band beneath the map, with session totals.

  Top corners get ~60% of the height and bottom ones ~40%, and cards scroll inside their share, so
  stacks never overlap on a short window.
- **The detail card**, floating on the Map and docked in the Network tab's Details panel. Its sections
  are toggled from a menu and remembered: Totals, Agent asked for and Connection on, Flows off; Policy
  is always shown.
  - **Connection**: the IP and how it was resolved, port and protocol, service → upstream, route
    (verified or declared), location and its source, opened / closed with reason and duration, and the
    flow id.
  - **Policy**: the enforced verdict, and Block this host / Block the domain / Block and cut live
    flows, Unblock, or Allow.
  - **Agent asked for** says honestly that nothing is joined yet: joining flows to the transcript's
    tool calls is the Trace phase.
- **Known limitation:** labels of nearby cities can overlap at the fitted zoom (Ashburn/Virginia,
  London/Amsterdam). Zooming in separates them.

### The Topology tab

Built from `topology.dc.html`: the route a session's traffic takes, as a diagram of six columns, and a
Selected path panel that walks one destination's path hop by hop.

- **Columns**, left to right:
  - **Sandbox**: the session, its harness, and "no route out except through the gate".
  - **Gate services**: every service `session.json` declares, including one glove does not watch,
    which is drawn dashed with an eye-off icon ("declared · not watched") and a dashed line from the
    sandbox, since traffic there is invisible, not absent. A service seen in traffic but not declared is
    drawn too. The fan-out service says "SearXNG → gate · not the harness", and a dashed "triggers" link
    joins it to the `search` service.
  - **Policy**: a wall where refusals end. One label per reason: glove's guard (with its reasons:
    metadata, internal, malformed), each of your rules by its note, and the default. The caption gives
    the default and the rule count.
  - **Route**: Local (its upstream, "never mapped"), the declared tunnel (kind, upstream, resolver,
    upstream health) and Direct, which shows a check and "no traffic" when nothing went direct.
  - **Apparent origin**: the exit, as glove verified it (country, IP, "via am.i.mullvad.net · not
    Layman's lookup"), or "not verified" with the reason (exit identity off, a failed check, no record
    yet). A broken path ends here in a broken-line glyph labelled with its host, before the exit.
  - **Destinations** that were reached: local links first, then the harness's tunnelled traffic, then
    the fan-out's, then direct, by bytes within each.
- **Bands** are sized by the square root of bytes, relative to the busiest band, and coloured by route:
  teal tunnelled, violet fan-out (it starts at the fan-out service, not the sandbox), grey local, red
  direct, amber/red thin lines into the wall for refusals. Live traffic is a thin moving line along its
  band, not a dashed band (dashing a 30 px band reads as stripes); reduced motion stops it.
- **Layout** (`lib/net-topology.ts`) is a pure, tested function returning every box and band path; the
  component (`TopologyView.tsx`) only draws SVG.
  - **Columns.** Destinations sit against the right edge. The route and origin columns keep their share
    of the width unless that would leave their bands under 40 and 90 px to bend (at 1280 px wide they
    otherwise collapsed into a vertical strip). The wall sits in the gap before the route.
  - **Order.** Services keep glove's declared order rather than byte order, as the mockup draws them, so
    the column does not reshuffle while traffic flows. Destinations are ordered by bytes, as the plan
    says. Each column then gets one overlap-avoidance pass.
  - **Size.** Below 1000 × 420 the diagram is laid out at that size and scaled down, never scrolled.
  - **Folding.** Destinations that do not fit are folded into one "+N more" box per route, keeping the
    busiest; the Network tab lists them all.
- **Selecting.** Clicking a destination, a band or a "+N more" box selects that path. A band shared by
  several destinations selects the busiest. The selection is the same `dest=` the Map and the Network
  tab use, and every band not on the path dims.
- **Selected path panel.** The destination's hops, each with its status and whether glove **observed**
  it, only **declared** it (a dashed circle), or **verified** it:
  - the sandbox, with gate freshness and heartbeat age (a fan-out path starts at SearXNG instead);
  - the service and its listener;
  - the policy verdict;
  - the route (a declared tunnel and its upstream health, a local link, or direct);
  - the exit (verified by exit identity, or not);
  - the destination, with its IP, port and offline location.

  A refused path stops at the policy hop, a broken one before the exit. Below the hops: sent and
  received tiles, Block (or Unblock), and Open in map.

### Configuration

`glove.network` in `GloveConfigSchema`: `enabled` (default true, meaningful only with `glove.enabled`),
`controlEnabled` (default true; false makes every toggle read-only, and is the Settings toggle "Allow
blocking from Layman") and `geoipDbPath` (the Map's offline geolocation database; empty means none). `glove` and `glove.network` are deep-merged in
both `loadConfig()` and `updateConfig()` — before this, `glove` was not, so a Settings update carrying
only `glove.enabled` would have blanked `sessionsDir`, and one carrying a single network toggle would
have reset the others. With glove (or its network views) off, the store is emptied and the session list
is empty, so nothing changes for users who don't run it.

### Testing against a fake glove

`netobs/__fixtures__/` is a byte-for-byte copy of glove's `tests/fixtures/netobs/` (see its README for
the source commit and how to refresh it). `fixture.test.ts` loads it through discovery, tailing and the
store and asserts every fixture state in handoff §6.1 plus Appendix A's totals; a drift guard fails when
the copy differs from `../glove`, and is skipped when glove is not checked out beside this repo.

`netobs/__scenarios__/` is the same for glove's `tests/fixtures/netobs-scenarios/`: sixteen real `net/`
directories, one per state the first fixture lacks (`default-block`, `direct`, `rules-rejected`,
`terminate`, `gate-lost`, `stopped`, `pooled`, `rotation` with a same-millisecond collision, and more),
written by glove's real forwarder and collector code. `COPIED.md` records the source commit and the
refresh command. `scenarios.test.ts` reads each one through the same path, with "now" one second after
its heartbeat since every fixture is stale when read later, and asserts the state it exists for. It
has its own drift guard.

`packages/server/scripts/netobs-replay.ts` builds a fake glove home from the fixture with timestamps
moved to now and replays it at its recorded pace (`--speed`, `--loop`, `--rotate-every N`, `--direct`).
`--gate` adds a fake gate: it polls the session's `rules.json`, validates it with the port, reports
`status.json` `rules` as glove's collector does (hash, `last_rejected`, the last good set kept on a
rejection, a ~5 s status lag), refuses matching new connections, and cuts open flows for `terminate`
rules. `--scenario <names|all>` replays scenarios instead, each into its own glove session named after it, so
every state can be looked at in the session picker; a later `--loop` pass gets fresh flow **and run**
ids, which to the reader is a restarted gate:

```bash
pnpm --filter ./packages/server netobs:replay -- --dir /tmp/layman-netobs/glove --speed 0.2 --loop --rotate-every 30
pnpm --filter ./packages/server netobs:replay -- --dir /tmp/layman-netobs/glove --scenario all
# then: glove.enabled = true, glove.sessionsDir = /tmp/layman-netobs/glove/envs
```

## Docker

Layman and glove are independent projects that meet only when the glove extension is enabled, so
**`docker-compose.yml` does not mount glove at all**. A bind mount's missing source is created by Docker
(root-owned, on Linux), and someone who only ever uses Layman must not get a `~/.glove` folder from
starting it. The glove mounts are two opt-in overlays, added by `make docker-run`, `make start` and
`make update` only when glove's own folders already exist:

| Overlay | Mount | Added when |
|---|---|---|
| `docker-compose.glove.yml` | `${HOME}/.glove` → `/root/.glove`, **read-only** | `~/.glove` exists |
| `docker-compose.glove-control.yml` | `${HOME}/.glove/control` → `/root/.glove/control`, **writable**, mounted over the read-only one | `~/.glove/control` exists |

The make targets print which were used. By hand, add them after the base file:
`docker compose -f docker-compose.yml -f docker-compose.glove.yml -f docker-compose.glove-control.yml up -d`
(with `docker-compose.ghcr.yml` as the base, the published image works the same way). The overlays
are read at start, so a glove installed, or a `control/` created, after Layman started needs Layman
restarted. Until then Layman sees no glove data, or shows the session's traffic with read-only toggles
whose tooltip says why.

**Layman never creates, chmods or relabels anything under `~/.glove`.** `control/` is created by glove
when it renders a session with a network gate. The only write is a session's `rules.json` inside
glove's existing `control/<env>/<name>/`, by glove's own contract (Writing rules, above). The writable
path is safe to expose because the gate's schema can express only allow/block verdicts over
destinations. An earlier draft of this phase had `make docker-run` create `~/.glove/control`, and the
mounts carry the SELinux shared label `z` (which relabels host files). Both were taken out: they
changed glove's folders from Layman's side. glove took over what they did (its
`layman-independence-results.md`, PR #12):

- **`control/` exists whenever glove has set up its home.** Any registry write, `glove init` or
  `glove run` creates it as the user. An install that predates this needs one `glove init`/`run` (or
  `mkdir ~/.glove/control`).
- **SELinux-enforcing hosts (Fedora, RHEL) are unsupported, for glove and for Layman alike.** glove
  itself does not run there yet, because its harness binds are unlabelled. There, Layman's binds are
  denied, and that is expected. Layman must not add `z`/`Z`: that would relabel glove's files from
  Layman's side, and a recursive `z` would relabel every harness home. glove withdrew its earlier advice
  to use them. Labelling (and whether harness homes may be shared with another container at all)
  belongs to the future work that makes glove run on SELinux.

The nested rw-inside-ro bind was checked on Docker Desktop and on rootless Podman (a macOS Podman
machine): the rest of `~/.glove` stays read-only, `control/` is writable, and a file container root
writes lands owned by the host user. See the "Docker mounts" note in the root `CLAUDE.md`.

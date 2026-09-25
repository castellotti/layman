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

## Network

glove's netgate records every connection a sandboxed session makes, and Layman renders it as the
Network, Map, Topology and Trace tabs. The implementation plan is
[`docs/planning/network-views.md`](../planning/network-views.md); glove's data contract, frozen at v1,
is glove's `docs/planning/network-observability-layman-handoff.md` ("the handoff"), and wins over the
plan on any question of data format. Code: `packages/server/src/netobs/`. What is built so far: the
**read side** (discovery, tailing, the store, classification, `net:*` WebSocket frames and a REST
snapshot), the **client shell** shared by the four tabs, and the **Network tab**. The rules writer, the
map, topology, correlation and persistence come in later phases.

glove answered Layman's follow-up questions in its
`docs/planning/network-observability-layman-followup-results.md` (glove branch
`netobs-layman-followup`): fail-closed on an unreadable `rules.json`, the permission contract for the
rules writer, hash-based write confirmation, gate lifecycle records, and a scenario fixture for every
state its first fixture lacked. What that changed on the read side is below; the writer follows its §3
contract when it is built.

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
`~/.glove/control/<env>/<name>/rules.json` (read only, for now). All of it is inside the existing
read-only `~/.glove` mount, so reading needs no new Docker mount.

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
map and Rules panels (side column). Activity and Details are off by default and still placeholders; they
come with the Map tab's detail card. All deciding is in two pure, tested modules; the components draw.

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
  disabled. Until the rules writer exists all of them are disabled, with a tooltip saying how to change
  rules meanwhile. A group gets a toggle only when all its members agree on one.
- **KPIs**: Sent, Received, Live (open flows, plus how many were lost with their gate), Destinations (to
  map, unknown location), Blocked (by guard / your rules / the default), Untunnelled (green "every egress
  flow used the VPN" at zero, otherwise a red `role="alert"` tile).
- **Rules panel, read-only**: whether the gate enforces what is on disk, evaluation order (glove's guard as
  locked row 0 with its hit count, then the file's rules with theirs, and a `CUTS OPEN` badge for
  `terminate`), and the default policy. When the gate has **rejected** the file, the list is headed "In
  rules.json · not enforced": the file on disk is not what the gate enforces, and Layman cannot see the
  set that is. Listing it as the evaluation order would claim otherwise. Hit counts come from the
  destination aggregates (each destination's block count under its latest rule), so they undercount a
  destination blocked by two different rules over time. "View file" shows the host path and the file.
- **Mini map** is a static placeholder until the Map tab's renderer exists: sandbox → exit (dashed while
  no exit is verified), how many destinations can be placed and how many are in Unknown location, and a
  click opens the Map tab.

### Configuration

`glove.network` in `GloveConfigSchema`: `enabled` (default true, meaningful only with `glove.enabled`),
`controlEnabled` and `geoipDbPath` (used by later phases). `glove` and `glove.network` are deep-merged in
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
`--scenario <names|all>` replays scenarios instead, each into its own glove session named after it, so
every state can be looked at in the session picker; a later `--loop` pass gets fresh flow **and run**
ids, which to the reader is a restarted gate:

```bash
pnpm --filter ./packages/server netobs:replay -- --dir /tmp/layman-netobs/glove --speed 0.2 --loop --rotate-every 30
pnpm --filter ./packages/server netobs:replay -- --dir /tmp/layman-netobs/glove --scenario all
# then: glove.enabled = true, glove.sessionsDir = /tmp/layman-netobs/glove/envs
```

## Docker

The whole `${HOME}/.glove` is mounted **read-only** (`:ro`): it is the one mount Layman only ever reads,
never writes, because writing into a sandbox is exactly what the feature must not do. It covers the
network views' `net/` directories too. See the "Docker mounts" note in the root `CLAUDE.md`.

# glove

[glove](https://github.com/castellotti/glove) sandboxes a coding harness inside a container. Layman
supports **glove v3 only** (a clean break from v2; see "glove v2 homes" below). In glove v3 a session
is a directory the user chose (`glove new <template> <dir>`); its state is private to it, in
`<dir>/.glove/`. The only data outside it is what the session's two explicit, per-session **grants**
export, and that is all Layman reads or writes:

| Grant | glove extension | What Layman gets |
|---|---|---|
| **observe** (read) | `observe` | flow records under `~/.glove/observe/<id>/net/` and, with `transcripts: true` (the default), the harness's transcripts under `~/.glove/observe/<id>/transcripts/` |
| **filter** (write) | `filter` (needs `observe`) | `~/.glove/control/<id>/rules.json`, enforced by every gate, which Layman may write |

Layman monitors gloved sessions **passively and read-only** by tailing those exports from outside the
sandbox; it adds nothing to what the sandboxed agent can see. The feature is off by default
(`glove.enabled`), and enabling or disabling it never affects native monitoring. The one thing Layman
ever writes is a session's `control/<id>/rules.json`, only with the filter grant, and only when the user
blocks or allows something (Network → Writing rules).

Only harnesses that persist a tailable transcript are discoverable this way: **pi**, **Mistral
Vibe** and **Claude Code**. A network-hook harness inside a net-restricted sandbox cannot reach Layman,
so a gloved Claude Code is read from its exported transcripts, never through hooks: Layman shows it
but cannot approve, deny or rewrite its tool calls (see "Gloved Claude Code is watched passively").

## How it works

**The session id is the token.** A glove v3 id is `<dirname>-<6 lowercase hex>` (for example
`research-1-3fa9c1`), stable for the life of the session directory (`<dir>/.glove/id`). It is the
directory name under both `observe/` and `control/`, the `env` *and* `session` of every flow record and
of `rules.json`, and the label Layman gives the sessions it tails, so a transcript joins its traffic by
it. Layman acts only on names matching glove's own pattern, `^[a-z0-9][a-z0-9_-]{0,39}-[0-9a-f]{6}$`
(`SESSION_ID` in `packages/server/src/glove/registry.ts`); `glove gc` touches nothing else either.

**One reader for glove's home** (`packages/server/src/glove/registry.ts`) serves both consumers:
`readRegistry()` reads `~/.glove/registry.json`, `observeIds()` lists the observe exports, and
`sessionDirState()` applies glove's orphan rule. `glove.home` (default `~/.glove`) is the only setting;
Layman follows it, never `$GLOVE_HOME`, because the container mounts `~/.glove`.

**The registry** is `{"v": 2, "sessions": [{id, dir, harness, template, created, grants, subnet}]}`,
written atomically by glove. Rows missing a required key, or whose id is not a glove id, are skipped,
and unknown keys are ignored, as glove itself does.

**Transcripts** (`GloveSource`, `packages/server/src/monitor/sources.ts`). For every
`observe/<id>/` with a `transcripts/` directory, `GloveSource` returns one labelled `WatchRoot`: the
path is `transcripts/` itself, because glove bind-mounts it *over* the harness's transcript directory
(pi's `.pi/agent/sessions`, Vibe's `.vibe/logs/session`, Claude Code's `.claude/projects`), so it holds
exactly the layout the watchers already parse (pi's per-cwd subdirectories such as `--work--/`; for
Claude Code, `-work/<uuid>.jsonl` and `-work/<uuid>/subagents/agent-<id>.jsonl`, the cwd being always
`/work`). The harness comes from glove, never from the layout: the registry row's `harness`, else
`session.json`'s. `pi` maps to the pi watcher, `vibe` to the Vibe watcher, `claude-code` to the Claude
Code watcher, anything else yields no root. A session without the observe grant has no export and is
never looked for anywhere else (its private `<dir>/.glove/home/` is off limits). The passive watchers
(`VibeSessionWatcher`, `PiSessionWatcher`, `ClaudeCodeSessionWatcher`) each filter `roots()` down to
the agent type they parse, so the single shared `GloveSource` instance feeds all three; native sources
precede glove in the list, so native wins any path collision. `roots()` is memoized for 1 s, since every
watcher calls it each scan tick against a FUSE-backed bind mount on macOS. See the "Monitor sources" note in the
root `CLAUDE.md` for the `MonitorSource` abstraction this plugs into.

**Mistral Vibe under glove is verified on glove's side, not yet live in Layman.** glove fixed its Vibe
profile (Vibe writes `logs/session`, which is what glove binds) and its tests have checked a gloved Vibe
run live. Layman reads the export as that `logs/session` directory; its own live check against a gloved
Vibe is still to do.

### glove v2 homes

glove v3 refuses a v2 `registry.json` (a bare array of environments) rather than migrating it, and so
does Layman: `readRegistry()` reports `v2-home`, the Network views show "glove v2 home: upgrade glove"
with glove's instruction (move the old registry aside, recreate sessions with `glove new`), and nothing
under `envs/` or `homes/` is read. Any other registry version is "unsupported". The setting
`glove.sessionsDir` (`~/.glove/envs`) became `glove.home`; `config.ts` (`migrateGloveHome`) takes its
parent once when `home` is absent and drops the old key.

## Design notes

> These moved here from the root `CLAUDE.md` to keep it under its size limit.

### Gloved sessions always activate on the Dashboard (`pi/watcher.ts`, `vibe/watcher.ts`, `claude/watcher.ts`)

Activation — the gate flag `buildSessionsList()` reads as a session's `active`, which the Dashboard
filters on (`DashboardView.tsx`: `s.active !== false`) — is normally driven by `autoActivateClients`
or the `/layman` slash command. A gloved session has neither path: `/layman` runs *inside* the
sandbox and cannot reach the host, and the sandbox agent never posts hooks. So a passively-tailed
session whose `WatchRoot` carries a `label` (i.e. it came from `GloveSource`) **always activates**,
independent of `autoActivateClients`; native (unlabelled) roots keep the `autoActivateClients` gate.
Every watcher applies this through the shared `shouldActivateWatchedSession()` helper, at add *and* at
resume time — a session tombstoned by the 15-minute idle timeout re-activates when its transcript
grows again, so it returns to the Dashboard on the next prompt rather than staying hidden. Without
this, a gloved run recorded to Sessions history but never appeared live on the Dashboard unless its
agent type happened to be in `autoActivateClients` — the reason gloved Vibe (in the list by default)
worked while gloved pi did not.

### Read-only by design (`monitor/sources.ts`, `GloveConfigSchema`)

glove writes the observe export on the host; Layman tails it from outside. The feature adds nothing to
what the sandboxed agent can see (no new mount into the container, no egress), which is a deliberate
fit for glove's security model and the reason the host mount is `:ro`. glove itself refuses to render a
session in which a harness mount could reach its own `net/` or `control/<id>/`, so the agent can
neither read nor forge the record Layman shows. Interception or blocking of a sandboxed harness's
*tool calls* would be a separate mechanism; this watcher is logging only. (Blocking *network traffic*
is different: with the filter grant, glove's gates read a rules file Layman may write, outside the
sandbox; see Network → Writing rules.)

`transcripts/` is created by glove's first `glove up` with `transcripts: true`; pi writes into it on
its first turn, which `GloveSource` picks up on the next scan tick.

### Gloved Claude Code is watched passively (`claude/watcher.ts`)

glove's `claude-code` harness exports Claude Code's own `~/.claude/projects`, and
`ClaudeCodeSessionWatcher` tails it as `PiSessionWatcher` tails pi: scan-tick discovery, replay from
the start for a session touched in the last 5 minutes (skipping what the database already holds by
`transcriptEventId`), adoption without replay for older ones, a 15-minute idle tombstone that
resurrects when a file grows, and the transcript's own times kept as `transcriptAt` /
`transcriptCompletedAt` for Trace. Lines are parsed with `parseTranscriptLines()` from `recovery.ts`,
the parser history import and gap recovery already use, so there is one Claude Code parser.

- **Only glove roots.** There is no native Claude Code source: native Claude Code is recorded over
  hooks, and tailing its transcript as well would record every turn twice.
- **Identity** is the `sessionId` on the lines, not the filename: a resume/fork writes a new file that
  keeps the original id. A session is tracked once however many files it spans, so a resume file that
  repeats earlier lines adds only the new ones, and the session has one idle timer: it is not ended
  while any of its files grows, and a resume file brings back a session that had already ended.
- **Subagents** (`<uuid>/subagents/agent-<id>.jsonl`, also older sidechain lines in the main file)
  are attributed as the hook path attributes them: a `subagent_start` marker, then the subagent's tool
  calls in the parent session tagged `subagentId` (in-file sidechain lines are grouped by `agentId`
  first). Its prompt and prose are left out: they are the Task
  tool's input and output, and a `user_prompt` would split the parent's turn in two.
- **Read-only.** A gloved Claude Code cannot reach Layman's hooks (Claude Code refuses an `http` hook
  to a private address, and glove's `command` hooks have no network), so there is no live gate:
  Layman cannot block, approve or rewrite its tool calls, and drift blocking does not apply. A
  loopback relay that would allow it is an opt-in glove feature that does not exist yet.
- **No gap recovery.** Startup gap recovery looks only in the native `~/.claude/projects`, so it never
  reads an export. That is deliberate: the watcher's restart replay fills a gloved session's gaps, and
  recovery reading the export too would record those lines twice (parser ids there, live ids here).

### History import discovers glove pi, Vibe *and* Claude Code sessions too (`recovery.ts`, `transcript-pi.ts`, `transcript-vibe.ts`)

`discoverTranscriptFiles(gloveRoots)` scans, in addition to the native roots, every *pi*, *Vibe* and
*Claude Code* root the passive watchers report (`gloveSource.roots()` threaded from the two
`importHistoricalSessions()` call sites in `server.ts`), so a gloved run that was never monitored live
is still importable from **Settings -> Data -> Import session history**. Each importer filters
`gloveRoots` down to the agent type it parses (`discoverGlovePiSessions` / `discoverGloveVibeSessions`
/ `discoverGloveClaudeSessions`), exactly as the passive watchers do. As natively, only Claude Code's
main transcripts are imported, not its subagent files. `gloveRoots` is empty when glove is disabled,
leaving native import byte-for-byte unchanged. The session id rides through `DiscoveredTranscript.label` into `importSession(..., sessionName)`
so a gloved import is tagged exactly like a passively-watched gloved session. Double-import against the
live watcher is prevented by the live-source rule (see the root `CLAUDE.md` history-enrichment note): a
session a watcher recorded is `source === 'live'` and is skipped. For a gloved session this check comes
before Claude Code's `parseAfter` enrichment, which would otherwise insert parser ids for lines the
watcher's restart replay records under live ids.

Vibe's transcript carries no per-message timestamp (the live watcher stamps `Date.now()`), so the Vibe
importer reads each session's real span from `meta.json` (`start_time`/`end_time`) at discovery and
spreads the imported events across it — otherwise every imported Vibe session would land on the import
date rather than the day it ran. See the file header of `transcript-vibe.ts` for the discover→parse
hand-off this relies on.

## Network

glove's netgate records every connection a sandboxed session makes, and Layman renders it as the
Network, Map, Topology and Trace tabs. glove's data contract, frozen at v1, is its `net/` record
format (glove's README → Network observability; "glove's record contract" in the code), and wins over
anything here on any question of data format. Code: `packages/server/src/netobs/`. It is built in full: the
**read side** (discovery, tailing, the store, classification, `net:*` WebSocket frames and a REST
snapshot), the **client shell** shared by the four tabs, the **Network tab**, **writing rules** and the
**Map tab** with offline geolocation, the **Topology tab**, the **Trace tab** (correlation with the
transcript), and **persistence** of totals across restarts.

glove answered Layman's follow-up questions in its PR #11: fail-closed on an unreadable `rules.json`, the permission contract for the
rules writer, hash-based write confirmation, gate lifecycle records, and a scenario fixture for every
state its first fixture lacked. What that changed on the read side is below, and the writer follows its
contract (Writing rules).

### The rule that must not be relaxed

glove resolves destination hostnames *inside the tunnel* so the operator's resolver never sees them.
**Layman never makes a network call keyed on gloved flow data** — no DNS or reverse-DNS lookup, geo-IP
API, favicon fetch, link unfurl or WHOIS, however much prettier the label would be. Any such call leaks
the sandboxed agent's browsing history to the host's resolver and undoes glove's design; it is a
privacy bug, not a missing feature. Geolocation is a local file read or nothing (The Map tab). A deliberately
crude test (`netobs/index.test.ts`, "no-network guard") fails any `netobs/` source file that imports
`dns`, `net`, `http(s)` or `tls`, calls `fetch(` on anything but `/api/`, opens a WebSocket, or mentions
`favicon`. `domain.ts` even carries its own IP-literal check rather than importing `node:net`'s `isIP`,
so the guard needs no exemptions.

### What is read, and from where

Per session with the observe grant, `~/.glove/observe/<id>/net/`: `flows.ndjson` and its rotated
`flows-<stamp>[-<n>].ndjson`, `exit.ndjson` (only with `exit_identity: via-proxy`; it rotates the same
way), `status.json` and `session.json`; with the filter grant, `~/.glove/control/<id>/rules.json`; and
`~/.glove/registry.json`. All of it is inside the existing read-only `~/.glove` mount; only writing
rules needs the extra `control/` mount (Docker, below).

- **Discovery** (`discovery.ts`) lists `observe/<id>/` directories with a `net/` and reads glove's
  registry through the shared reader (`glove/registry.ts`). The id is the token everywhere; it must be
  a glove id, and the resolved control path must stay inside `~/.glove/control`, or the session is
  skipped: the id addresses the one directory Layman is allowed to write.
- **Grants** come from `session.json` `grants` (what the gates were rendered with), else the registry
  row. `transcripts: false` means flows only.
- **Session states** (the session picker, `NetGloveInfo`):
  - *not observable*: a registry row with `grants.observe: null` and no export. Listed greyed out and
    not selectable; Layman never goes looking for its data. These travel in their own `notObservable`
    list (`net:sessions`, `GET /api/net/sessions`), never among `sessions`, so only the picker shows them.
  - *orphaned* ("session deleted; export retained"): glove's own rule from `glove gc`, either an
    export with no registry row, or a row whose directory is gone or now holds another id
    (`<dir>/.glove/id`). Read-only; the Rules panel names `glove gc`, which removes it. Layman never
    deletes an export: `~/.glove` is mounted read-only. **A containerized Layman cannot see arbitrary
    session directories** (only `~/.glove` and harness folders are mounted), so there it proves only
    the no-row form; a directory it cannot see is never reported missing (`sessionDirState` →
    `unknown`). Native Layman applies both forms. An unreadable registry orphans nothing.
  - *revoked*: see Writing rules → The filter grant.
- **New labels in v3.** `route` gains `corporate`; `scope` gains `lan` and `cloud`, from glove's `llm`
  extension (an inference server on the LAN, or a provider on the internet reached by the llm link
  rather than the tunnel). Both are expected, never an alert, never "untunnelled", and never placed
  or bucketed as unresolved on the map when `lan`; the Route column says `LAN · LLM` / `cloud · LLM`
  (before, they fell through to the route name and read as the VPN). Every view reads them the same
  way: Topology draws both through their own **LLM link** route (local-toned, never through the
  tunnel or the exit; `routeOf` in `lib/net-topology.ts`), and the Map draws a `cloud` pin with a
  plain solid line straight from the sandbox, not an arc from the exit (`Cluster.tunnelled` in
  `lib/net-geo.ts`), and neither red like `direct`. `client: playwright` and
  `tool: browser` come from glove's browser extension and need no special handling. SearXNG's engine
  requests arrive through their own `searxng-egress` gate (`client: searxng`), so a `web_search` shows
  every engine it reached, as the fan-out treatment already expects.
- **Labels from glove's Claude Code and Vibe harnesses.** These harnesses reach search and fetch as
  MCP servers in sidecars, so they add two harness → sidecar hops (client `harness`, tcp, scope
  `local`): **`search-mcp`** (tool `web_search`) and **`webfetch-mcp`** (tool `web_fetch`, Vibe's
  `fetch_url`). Vibe's fetcher then goes out through its own gate, **`webfetch-egress`**, whose flows
  carry the new client label **`webfetch`**. pi still uses `search` and `proxy`. Claude Code's own
  **WebFetch** goes through `proxy` (tool `web_fetch`, client `harness`), as pi's `web_fetch` does, and
  its destinations include `api.anthropic.com`: WebFetch's domain preflight, expected even when the
  session's model is not Anthropic's, and not an anomaly. With `provider: anthropic` the `llm`
  service's flows name `api.anthropic.com` by SNI with scope `cloud`, drawn as the cloud LLM link.
  - `webfetch-egress` is an egress consumer (`harness: false`), drawn like SearXNG's fan-out: "Web fetch
    → gate · not the harness", its path starting at the fetcher ("page fetch · triggered by a web
    fetch"). It is not a fan-out: `classify.ts` and `correlate.ts` keep the fan-out flag for SearXNG.
    Each egress consumer's display name, wording and triggering tool are one table (`EGRESS_CLIENTS` in
    `lib/net-topology.ts`), which already names glove's planned `github` and `ssh` relays.
  - In Trace, the `webfetch-mcp` hop's destination is the sidecar, not the URL's host, so a fetch call
    claims it by time (role `fetchhop` in `correlate.ts`), as a search claims `search-mcp`; the fetcher's
    egress flow names the host and joins by it.
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

A session whose `net/` drops out of a discovery pass keeps its reader; it is only no longer polled.
One failed directory read (a Docker Desktop bind mount can return an empty listing) used to drop the
reader, and when the directory came back a new one re-read every file from the start into the same
session: exit records were added again, the records counter inflated, and closed flows already evicted
from memory counted a second time, all of which then reached the saved totals. Switching glove or its
network views off is different: the store forgets every session, so readers and the rules control's
per-session state are dropped with it. The rules state must go too, or on switching back the control
sees an unchanged `rules.json` and never sends the rules again, leaving every Rules panel blank.

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
  `eof`/`timeout` is proxy noise (glove's record contract), counted in `emptyFolded`.
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

**Since when** (`gateSince()`, `NetGateView.since`). The strip's tooltips say when the gate, the route,
the exit IP and the resolver became what they are. Each is dated by the glove record that says so,
whether Layman saw the change live or reads it back after a restart, so the two give the same date and
neither says "since Layman started":
- a running gate since its collector run's start record. A new `glove up` is a new run id, so it is
  running since its own start, not the previous run's;
- a stale gate since its last heartbeat (the clock, not a record, turns it stale), and a stopped one
  since its run's stop;
- a verified exit since the first record of its unbroken healthy streak, and the exit IP since its
  first record in a row. The upstream's own health is not part of "verified since": glove reports it
  with no time, and a blip would re-date it.

A streak that runs back to the oldest exit record Layman holds is shown as "at least since", because
older records may have expired. A change no record dates (the resolver's health) is dated when Layman
saw it, and is left out after a restart. A time range shows its own last exit, so the live "this exit
since" is left out of a range whose exit is not the live one.

Where nothing says (the resolver's health has no record), there is no "since": a tip leaves it out
rather than guess. `exact: false` reads "at least since" and is reserved for a date that is only a lower
bound. It is pure and tested at each transition and after a restart (`gate-since.test.ts`).

`gate_lost` is the tenth state, from glove's follow-up: an unclosed flow whose forwarder has gone (next
section). It is not "open" in any sense the UI means, so `totals.openFlows` and a destination's
`openFlows` leave it out and `totals.gateLost` counts it. `status.json`'s `rules` also carries glove's
new `sha256` (of the file now enforced) and `last_rejected` (`{checked_at, source_mtime, sha256, error}`,
kept after a later acceptance); they are how the rules writer confirms a write.

### llm-auth, the relays and downloads (glove rounds 1–10)

glove's record contract did not change, but its gates now record traffic the views first misread.
Layman matches these by `tool`, `client` and `harness`, not by service names, except where noted.

- **A model call through llm-auth is two flows.** With an injected API key (or `auth: oauth`), the
  harness's `llm` forwarder ends at glove's `llm-auth` sidecar, which adds the key and dials the
  provider through a second gate, `llm-upstream` (`harness: false`, client `llm`, same `tool: llm` and
  scope). `nextServices()` (`types.ts`, both mirrors) says which service goes on through which.
  From glove's round 13 every `session.json` service carries `next`: the egress forwarders the
  sidecars behind it dial out through (`llm` → `llm-upstream`, `webfetch-mcp` → `webfetch-egress`,
  `webdownload-mcp` → `webdownload-egress`, `search`/`search-mcp` → `searxng-egress`, `browser` →
  `browser-egress`; `[]` otherwise). It is static and transitive through sidecars, with no per-flow
  link, so a hop's flows are joined to the egress flows they cause by time. Only an **observed**
  gate counts: glove lists a skipped one (`observed: false`) too, and its traffic is unrecorded, so
  the hop's flows stay the only record and are not set aside. That holds when *any* of a service's
  `next` gates is skipped (`isHopService`): its flows then count, even though the watched gate's
  share is counted twice, because leaving them out would lose the skipped gate's traffic outright. For a gate from before round 13 (no
  `next`), the one pair Layman knows is matched by its labels: a harness-side `tool: llm` service →
  the `harness: false` `tool: llm` services. So **every sidecar hop is a hop**, not only the llm one,
  and its flows carry `FlowFlags.hop`:
  - **Counted once.** A hop's bytes are left out of the session totals and rate buckets, and so out
    of what history keeps (`setPre` skips them in `seen` too). The egress leg counts them (for the
    llm, the provider leg; for a fetch, the fetcher's egress). Search and fetch sessions therefore
    total less than before round 13, when the hop to the sidecar was added on top. The
    hop's own destination keeps its bytes. `history.test.ts` restarts at every record of this case.
    The flag is kept with the destination (`net_destinations.hop`, migration 5, local only), so a
    hop whose files are gone is still a hop, not an unresolved cloud destination on the Map.
  - **Re-flagged when session.json changes.** The flag is set as each record is read, from the
    session.json of the moment, and session.json can be missing or unreadable at first, or be
    rewritten with another `next` or `observed`. `setSessionFile` therefore re-flags the stored flows
    (`reflagHops`), moving their bytes out of the totals or back in, so a flow is never counted at
    both legs or at neither. The 1 s buckets still held move with them; what was already folded
    into 1 min buckets stays as it was counted.
  - **A local link, whatever its scope says.** The hop carries the provider's `cloud`, but it is
    never geolocated or mapped (`offMap`), it sits in "Local links", and its route reads "local · hop".
  - **Trace** gives one LLM row per request. Each hop is folded into the nearest upstream leg that
    opened while it was open, one to one, so pooling on either side never merges two requests. A
    leftover hop or leg is a row of its own. The row expands to both flows. Its bytes are the leg's.
  - **Topology** draws `llm-upstream` as a service, not an egress consumer: no sandbox band, and a
    band from `llm` to it labelled with the sidecar ("via llm-auth"). The selected path is sandbox →
    `llm` → llm-auth (adds the API key) → `llm-upstream` → LLM link → provider.
- **`scope: lan` is not only the LLM.** glove's ssh relay sets it explicitly on its per-host gates
  (`ssh-<name>`, client `ssh`, `tool: ssh`). `isInferenceScope(scope, tool)` is the llm link
  (`cloud`, or `lan` with `tool: llm`). `isOffTunnelScope` is "never tunnelled, never an alert".
  The table names a `lan` host by its tool ("LAN · LLM", "LAN · SSH", else "LAN"). Topology routes
  an ssh host as a LAN link (local, never the llm route), and the legend row is "LAN link".
- **Cut all** matches by tool, because `lan` and `cloud` cannot be named in a rule (`RULE_SCOPES`).
  It writes `tool: llm` (kept or cut, which covers both legs: matching `service: llm` left
  `llm-upstream` to the new default block, so "keep the LLM" broke the LLM). It adds
  `{block, tool: ssh, terminate: true}`, since without it the default would refuse new ssh
  connections but leave open ones running. The server's `opRules` and the client's `previewRules`
  change together.
- **`--lan-only`** refuses a `via: lan` name that resolved to a public address, with
  `rule: "builtin:lan-only"` (glove's round 13; gates before it wrote `"lan-only"`, which is still
  accepted). That is glove refusing, not a user's rule, so `classifyFlow` reads it as `guard`. The
  refused flow does not record the public address (`dest.ip: null`, `resolution: disabled`). Since
  round 13 a `via: lan` gate defaults to `scope: lan` (it had been `local`). The rule is decided at each connection,
  on a resolution Layman never sees, so it is not predicted. A destination it refused carries
  `policy.*.lanOnly`, and the Details card says so instead of promising an allow.
- **Downloads.** `web_download` reaches the same fetcher as `webdownload-mcp`
  (`tool: web_download`) and goes out through `webdownload-egress` (client `webfetch`). In Trace,
  only the download tools (`web_download`, `web_download_status`, and their MCP spellings) claim
  the download hop and its egress. A fetch call claims neither, and a download call claims no fetch
  hop. A status call names no URL, so it can claim only the hop. A long download stays with the
  call whose window it opened in. Topology takes an egress consumer's trigger from its own `tool`
  first, so `webdownload-egress` hangs off `webdownload-mcp`, not the fetch hop. The saved files
  come from the recorded results (`saved:`, `bytes:`, `sha256:`, `content_type:`, `final_url:`; in
  Vibe before 2.26, inside the `structured: {'result': '…'}` repr its MCP result is recorded as,
  read as Python writes it: double-quoted when the text holds a `'`, other keys around it, cut off
  before its closing quote; the repr is replaced by its text rather than added to it, and a file
  reported twice in one result is listed once):
  - in a download call's Details;
  - in the Trace tab's Downloads panel (`GET /api/net/sessions/:token/downloads`, one entry per
    file, under the call that first reported it).

  Nothing is read from the sandbox. Layman makes no "safe to open" claim, and glove quarantines
  the files on macOS at `glove down`.
- **Relays in Trace.** A shell command claims its relay's flows in its window, read from its leading
  words only (`shell.ts`): quotes respected, `cd …&&`, `VAR=x` and wrappers skipped. `gh …`, and git
  `push`/`pull`/`fetch`/`clone`/`ls-remote` (glove's git shim relays only those), claim `client: github`
  flows. `ssh [opts] <name> …` claims the gate `ssh-<name>` first, and any ssh flow only when no gate
  has that name. `echo "gh pr list"` claims nothing. Such calls are `kind: 'relay'` and carry
  `relay: {via, host}`. A relay call also joins by host like a fetch: its URLs, and an ssh
  command's host, are its `targets`, and one that names a host or (a codemode script) calls a fetch
  or download tool may claim fetch flows too. Without a relay sidecar, `git clone https://…` or
  `ssh <host>` goes out through the proxy, and `git push && curl …` makes both kinds of traffic;
  as a relay call alone, each left its proxied flows Unattributed.
- **Client labels are open.** `EGRESS_CLIENTS` (`net-topology.ts`) no longer calls `github`/`ssh`
  "planned", and it names `llm` (llm-auth) for labelling only. An unknown client shows raw.

Until glove ships netobs-v3 scenarios for these (asked of glove), the tests use hand-made records
(`netobs/testing/rounds.ts`, `rounds.test.ts`, web `net-rounds.test.ts`). Replace them when glove's land.

### Gate lifecycle: flows that never close

Before glove's follow-up, a forwarder killed with SIGKILL left its open flows looking pooled forever:
nothing ever wrote their `close`, and `restart: unless-stopped` does not restart a killed container. glove
now tags every flow record with `run` (the forwarder process, `g_<ULID>`) and writes `type: "gate"`
start/stop records into `flows.ndjson`, including an `"inferred": true` stop for a forwarder silent for
30 s. The reader rule: in file order, a run ends at a `stop` for it, or when a later run appears for the
same service; any later record of the run revives it; an unclosed flow of an ended run was cut by the
gate going away.

`NetStore.ingestGate()` and `noteRun()` are a **port of glove's reference `ended_runs`** (glove v3:
`extensions/observe/netview.py`),
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

### Time ranges (`netobs/range.ts`)

`net:subscribe { token, range: { from, to } }` (epoch ms; `to: null` means until now) shows one window of
a session instead of All records. Without a `range`, nothing changes: the snapshot is the live store's,
with `range: null`.

**A range is built from glove's files, never filtered from the live view.** Layman holds only the newest
records in memory (the 64 MB backfill budget), and what it keeps of the rest is per hour and per
destination (`net_hours`, below): no flows, and too coarse for a window that starts and ends mid-hour.
So a past window is not there to filter. On a real session with 260 MB of flow files, the live store held about a quarter of
them. The window's records go into a fresh `NetStore`, so a range is counted by the same code as All
records, with one addition, the clip:

- A flow is in the range when it has a record in it. Its bytes in the range are what moved during it: its
  cumulative bytes at its last record in the range, less those at its last record *before* the range. A
  pooled connection opened yesterday and reused for one exchange counts only what that exchange moved.
- To find each open flow's bytes at `from`, the scan starts an hour early (`LEAD_IN_MS`). glove writes an
  `update` for an open flow every few seconds (measured: 3 s typically, 30 s at the 99th percentile, 29 min
  at most), so a flow open at `from` has a record in the lead-in. A flow idle for longer than the lead-in
  would count from zero.
- A refusal counts when its record is in the range. Exits are read whole: the one shown is the last at or
  before `to`.
- The gate, rules and session file are the current ones. glove keeps no history of them, and the controls
  act on the gate now. Destinations' predicted verdicts follow rule changes in every range.

Which files are read is decided from each file's first and last record times, so files outside the window
(less the lead-in) are skipped. A file's read stops at the first record more than a minute past `to`.
Measured on a copy of that session: everything (264 MB) in 2.1 s, one multi-day run in 1.2 s, one hour in
under 0.3 s. The scan reads at most 512 MB (`rangeBudgetBytes`), newest files first, and says so
(`range.truncated`, which also sets `historyTruncated`). `range.filesFrom` is the earliest record the
range could read: later than `from` means the window starts before what glove still keeps. The scan reads
1 MB chunks asynchronously, so it never blocks hooks, and `net:range:progress` frames (at most 4 a
second) report how far it has got.

**The part glove no longer holds** is answered from Layman's hourly history (`net_hours`, below), when
glove has deleted it (the files start later than the session did) or the scan's budget skipped it. A
session whose files are all gone gets its whole range from the hours, rather than an error (one with
no kept hours still gets `net:range:error`). How the two parts meet:
- **The cut.** The hours answer up to the hour after the files begin, and the files count from there.
  Records before the cut only set each flow's baseline. So every hour is counted once, from one
  source: a file starting mid-hour gives that hour's start to the history and its end to the files,
  and neither is lost nor counted twice (`range.test.ts` fails if the cut moves an hour either way).
  **The cut is never in the future.** The hours are a copy taken when the range is built, so an hour
  still going cannot be answered by them: when the files begin in the current hour, the cut falls at
  its start, and what glove deleted of that hour is not counted. Without this, an open range dropped
  up to an hour of live traffic. Files that exist but hold no record yet hand over at the moment the
  range is built. Only a session whose files are gone is answered by the hours throughout.
- **A connection across the cut is one.** A pooled connection that opened in the hourly part and is
  still recorded after the cut was counted by the hours when it opened, and would be counted again by
  the files. It is taken back out of the hourly part (with its refusal or direct count), so a range
  around everything equals All records.
- **The same code.** The hourly part goes into the range's store as kept history (`hourlyHistory`,
  then `setHistory`), the mechanism that adds kept totals to All records. So the merge is the store's
  own, tested one, not a new sum.
- **What the hours keep.** Whole hours: the part's edges round out to them, `to` included (a range
  ending on the hour takes in the hour starting there). Totals by destination, with no individual
  connections: the flow list and Trace do not cover that part. Each hour keeps its refusals by kind
  (guard, rule, default) and its direct connections, because a destination's kind of refusal can
  change; only what the hours lack about a destination (its host, scope, IP) comes from it as All
  records shows it.
- **Gaps.** An hourly part with no traffic in it is covered, and simply empty. If Layman's hours begin
  after the range and the session do (they start with migration 6, or when recording was turned on),
  the banner says nothing was kept before then.
- **Measured.** On a copy of a real session with its two oldest files deleted, a 3-day run and a
  2-hour report gave the same bytes as with every file (702.7 MB and 175.7 MB sent). Connections
  differ by a few, as the rules above say they will. The hours count connections *opened* in them,
  so 8 opened before the report and reused during it are not counted (1,621 against 1,629). The run's
  first hour rounds out to 06:00 and takes in 4 from the previous run (35,752 against 35,748).
- **Reported.** `range.hourly` gives the part's first hour Layman kept and the hand-over. The banner
  says what that part is and why it came from the hours: glove deleted the files, or they were too
  much to read. It says "All of it" when the files had nothing to add.

glove can rotate while a range is being read. The live path then opens the new, near-empty file, and
the one the scan meant sits under a rotated name it never planned. After its planned files the scan
therefore lists them again and reads any rotated file whose first line it has not read: files are known
by content, as the tailer knows them.

One built range is shared by every socket that asks for it. A range somebody is watching follows the
live reader: each newly read record is handed to it, along with session.json changes (which services
are hops) and a new geolocation database. A range that ended drops those records itself, so it never
changes. A record that arrives while the scan runs is queued and applied after.

The scan and the live reader can both hand over the same record: one written while the scan ran, or
read by the scan just before the next poll. A store counts a repeated flow record's bytes once, but not
its record count, and a repeated gate record of an old run would revive that run. So the range remembers
what the scan read from a minute before it started, skips those records when the live reader repeats
them, and forgets them after the first poll once it is built. Exits are deduplicated by content.

Once nobody is looking at a range, it is kept for the next subscriber (switching tabs, Back) only if
it has ended: an idle range no longer follows the live reader, so one reaching into the present would
go stale. The four most recently used are kept, where "used" is when the last socket left it. A range
still being read when its last subscriber leaves is dropped, which stops its scan, and so does `stop()`.
A socket that moved on never receives the range it left.

`net:delta` and `net:exit` carry the range's key (`range`, null for All records), so a client can drop
frames for a range it has left. `net:status` and `net:rules` go to every subscriber of the session. A
range that cannot be built gets `net:range:error` instead of a snapshot: an unknown session, a read error,
a history-only session with no kept hours (its files are gone, and nothing else holds a window), or something
that is not a range at all (a start before 1970, an end before the start). The last is answered under
the key the client built from what it sent: falling back to All records would leave a client that
waits for its range dropping that snapshot and waiting forever.

`range.sessionFrom` is the session's first record as far as Layman knows: the earlier of the live
store's first (kept history included) and the oldest file's first record. A range starting before it
is not missing anything, since the session had not begun; a range whose `filesFrom` is later than it
is, because glove deleted the older files.

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

- **Tooltips** (`components/network/NetTip.tsx`). One host, mounted by `NetworkView`, shows a tip for
  any element with `data-tip` (and `data-tip-heading`, `data-tip-facts`, written by `tipProps`), SVG
  elements included. It replaced the browser's `title` everywhere in these tabs, because a native
  title appears after about a second, cannot be styled, and never appears on keyboard focus: the
  strip's chips read as unexplained labels. A tip appears 120 ms after hover (long enough not to
  flicker across a row of chips), at once on keyboard focus, and goes on Escape or a click; the
  element gets `aria-describedby` while it shows. Details that bit:
  - **Keyboard focus only** (`:focus-visible`). A click focuses what it hits; showing on that focus
    brought back the tip the click had just dismissed, over the popover the click opened.
  - **It follows its element.** It re-reads the element four times a second and on scroll, so a chip
    that relabels itself is not described by its old words, a tip whose element is gone goes with it,
    and a chip scrolled into view by focus keeps its tip.
  - **Disabled controls** (`TipWrap`). A disabled button takes no focus and, in some browsers, no
    pointer events, so its reason sits on a wrapper that is focusable while the control is disabled.
  - **It fits.** On whichever side has more room, no taller than that room, with long text and facts
    cut short.

  The words live with the data, not in components: each gate chip's `tip` (a heading, a plain
  sentence, then its facts) in `gateChips()`, and the Topology legend's in `TOPOLOGY_LEGEND`, both in
  `lib/net-format.ts` beside `NET_LEGEND`. The rules chip states only the default the gate *enforces*
  (`rules.enforced`), never Layman's write or a guess. The legend names the diagram's band kinds and
  takes its colours from the diagram's own table (`BAND`), so the two cannot drift.
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
  `sessionName`, else the first in the picker — and writes it into the URL by **replacing**, because
  pushing would make Back land on the bare URL, re-default and push again (`historyModeFor`, tested).
- **The picker's order** (`netPickerOrder` in `lib/net-state.ts`, tested). Glove sessions the
  Dashboard lists come first, in the Dashboard's order: most recent first, or as the user dragged
  them. `orderDashboardSessions` in `lib/session-state.ts` is that order, shared with the Dashboard,
  and its sort mode is kept in `sessionStore` so both read it. The rest follow: live first, then the
  newest started, then by token. Gate records never move it. The server's list is sorted by the
  latest record, and a live gate writes records while it is idle, so two idle live sessions swapped
  places under the pointer while the list was open and a click picked the wrong one. The Dashboard's
  own order does follow agent activity, so the picker also freezes its order while the list is open
  (focus to blur or a choice; a new session joins at the end). The Dashboard still opens at most
  recent each time, as before the sort mode moved into the store.
- **Arriving from another view.** Entering any of the four tabs from elsewhere while looking at a
  gloved session shows that session, even if another was chosen on these tabs before. "Looking at"
  is the session open in Logs or a session view, or the Dashboard's focused one (from the Dashboard,
  `activeSessionId` is only whatever Logs last showed). `setViewMode` resolves it in the same update
  as the view (`arrival` in `sessionStore.ts`, `arrivalNetToken`), so the switch is one history entry
  and one subscription: resolving it in an effect afterwards first pushed and subscribed to the old
  session, and Back landed on it. It also shows a session that is not observable, which the default
  skips. Before the glove sessions are known nothing is chosen, and the default prefers the active
  session anyway. Moving between the four tabs never changes the session. A deep link with `glove=`
  is hydrated without `setViewMode`, so the link wins.
- **Time range.** `netRange` in `sessionStore`, hydrated from `&from=<iso>&to=<iso|now>` (ISO, not ms, so
  a shared link says what it shows; a missing `to` is "now"). A range is dropped when it has no start,
  starts before 1970 (the server's rule, so the two never disagree), ends before it starts, or has an
  end that cannot be read: reading that as "now" would silently widen it. Shared by the four tabs, so an
  investigation survives switching between them. Cleared when another glove session is picked, because
  its runs and records belong to the old one; but filling in the *default* session (a link with a range
  and no `glove=`) keeps it, and the destination too. Setting,
  changing or clearing it **pushes**, so Back returns to the previous range. The view subscribes with
  the range, and the reducer keeps the range's key (`rangeKey`, the server's): it drops any snapshot,
  delta or exit for another range (a frame in flight from the range just left), while the gate and
  rules apply to every range. Until the ranged snapshot arrives the view says it is reading glove's
  files, with the scan's progress; a `net:range:error` is shown with a way back to All records. Both
  carry the range they are for, so one range's progress or error never shows under another, even for
  the frame before the new subscription clears them. A banner under the strip names what a range
  leaves out (`rangeGaps`): traffic glove deleted (its files start after the session did), or a scan
  cut short by its budget, said as skipped, not deleted. It also says when the part from Layman's
  hourly history begins. A range that merely starts before the session says when the session began, as
  information rather than a warning. A range covered in full has no banner: its span is in the strip.
- **Range bar** (`GateStrip.tsx` → `RangeControl`, picker in `RangePicker.tsx`, arithmetic in
  `lib/net-picker.ts`, tested). A calendar icon follows the session picker. It shows or hides the range
  display (kept per browser, `layman.net.rangeDisplay`, shown by default). With a range set it stays lit,
  and its tip gives the range, so hiding the display never hides that the figures are filtered. The
  display is the range in local time with seconds ("Run 18 · Oct 21 00:27:03 → …", named when it is
  exactly a run; UTC in the tip; an open range's length ticks), or "All records", and ✕ back to All
  records. While the display is shown the routine gate chips shrink to their icons (`chipCollapses`): the
  label leads the tip's facts, so nothing is lost. A chip in a warning or error tone is an alarm (traffic
  cut, untunnelled flows, rules rejected, a stale gate, a direct route) and never shrinks, nor does
  History only. Each panel whose figures depend on the range is marked IN RANGE in its header, so a
  panel read on its own is not taken for All records. The Rules and Trace panels are not marked: they
  show the rules in force and one turn.
  - **The picker** opens from the range display and stays open while one range after another is
    tried. *Runs & sessions* lists the segments newest first, with flows and bytes: runs (numbered from
    the first, with how each ended), bursts (the split gap chosen there, 1–24 h, kept per browser) and
    agent sessions. *Calendar* draws a Monday-first month, each day shaded by its flows on a log scale (so
    one busy day does not blank the rest), from the segments' hours. A click sets that day; shift-click
    extends the range to the day clicked. Today's day, and any range reaching now, stays open. Presets
    (last hour, last 24 h, today, this or the last run) and `datetime-local` start and end fields (to the
    second; an empty end is now) complete it. *Timeline* is the session's hours as bars, model calls in
    the tunnel colour, run edges as ticks and agent sessions as dots. A drag across it sets a range,
    each edge snapping to the nearest run or agent-session edge within 8 px. A drag reaching now on a live
    session stays open. *All records* is always one click away. Presets are relative to when the picker
    opened, so the one picked stays marked, and the start and end fields follow the range however it was
    set, so Apply never restores an old one. A range picked while its run was up (`{ from: run start,
    to: now }`) is closed to the run's end once the run ends (`endedRun`). Left open, it would grow into
    the next run while the strip still read it as that run's figures. The segments are fetched only while
    they are used: the picker is open, or a range is set (to name it and to close a run's).
  - **Trace** counts and steps through only the turns that began in the range ("TURN 2 OF 5 IN RANGE"),
    and opens on the range's latest. The trace route takes `from`/`to` in ms. A turn opened by id from
    outside (a detail card's "Open in Trace") is still shown, marked as outside the range, with arrows
    back into it. Which flows a turn owns does not change: its window still ends at the next prompt.
    A range with no turn says so. A new range opens on its own latest turn rather than keep one picked
    under the last. The route refuses an empty `from`, which `Number` would read as the epoch, and a
    `to` without a `from`.
- **Subscription.** The view subscribes the socket to the shown session, re-subscribes after a
  reconnect (the server forgets subscriptions with the socket) and unsubscribes when the tabs close, so a
  dashboard that is not looking stops receiving deltas.
- **Gate strip** (`GateStrip.tsx`, chips derived by `gateChips()` in `lib/net-format.ts`, tested): the
  glove session picker, then gate state, the untunnelled alarm straight after it (the design's order, so
  it is the last thing clipped), route and exit (the exit's `source` is in the tooltip: Layman did not
  determine it), resolver, rules, record mode, and "View incomplete" when the gate dropped records, a
  rotated file vanished, or backfill hit its budget. The chip row shrinks and scrolls sideways before the
  Panels chips on the right would be cut — found at 1440 px, where a stale gate's longer label pushed the
  last Panels chip off screen.
- **Rules rejected** pins a red `role="alert"` banner under the strip on all four tabs, with "Show file".
  Its headline says who wrote the rejected file (`rejectedAuthor` in `lib/net-rules.ts`): "Your last rules
  change" only when Layman's own last write is the file on disk, "rules.json was changed outside Layman"
  when Layman saw it change without writing it or `updated_by` names someone else, and neutral wording
  otherwise. The real-glove check caught it calling a hand edit "your change".
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

A KPI row, then the Destinations table (main column) and the mini
map and Rules panels (side column), plus Activity and Details, off by default. Details is the Map's
detail card, docked (The Map tab, below). Activity (`ActivityChart.tsx`) draws received and sent bytes as
bars over 1m / 5m / 1h, from the client's own 1 s buckets, or over the whole session from
`GET …/buckets?window=session`. All deciding is in pure, tested modules; the components draw.

- **The state legend is data** (`NET_LEGEND` in `lib/net-format.ts`): one entry per row of glove's state table,
  plus cleartext HTTP, each with its label, data rule, icon, colour, badge, toggle kind, map treatment and
  explanation, and `NET_STATE_INFO` mapping every `NetState` to its entry. Every view reads colours and
  toggles from it, so the legend and the views cannot disagree. The Map, Topology and Trace tabs use
  the same table.
- **The table model** (`lib/net-table.ts`, `buildTable()`) turns destinations and flows into rows:
  group → host → flow, grouped by registrable domain (default), route or tool, and sorted by most recent
  or most bytes. A group whose only host *is* the group (`arxiv.org`) is drawn as that host, with no extra
  level; `wikipedia.org` keeps its level because its host is `en.wikipedia.org`. Four groups are fixed
  whatever the grouping: Search fan-out, Local links, Refused by glove guard, and Not watched (declared
  `observed: false` services, which have no records at all). The guard and Not watched groups start
  expanded: they are what a glance should catch. A fixed group, rather than loose rows, keeps them
  together. Not watched rows appear only unfiltered, since they have nothing
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
  set that is. Listing it as the evaluation order would claim otherwise. Hit counts are exact over
  the flows the files hold: each destination counts its blocks by the rule that made each one
  (`DestinationAggregate.blockedBy`, `''` for the default; `ruleHits` in `lib/net-rules.ts`). Blocks
  that only the kept history knows (files since deleted) have no rule on record and are counted under
  the destination's latest rule, as an estimate. "View file" shows the host path and the file.
- **Mini map** is the Map tab's renderer at small size (no labels, no pan or zoom), with how many
  destinations are placed and how many are in Unknown location. A click opens the Map tab with the
  selection kept.

### Writing rules

Blocking and unblocking. This is the only place Layman writes into `~/.glove`. It follows glove's
contract for a second writer (glove PR #11, as revised by glove PR #12). That contract overrode
Layman's original design in three places:

- **Never create the control directory.** glove creates `control/<id>/` (0700, the user's) only for a
  session with the filter grant, before its gates start. If it is absent, the toggles say why
  (`control.state`: `not-granted`, `revoked`, or `no-dir` when granted but not created yet). The plan
  had Layman create it.
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
  is a symlink or not exactly `control/<id>`, and never writes anything else there. The plan
  used a shared `rules.json.tmp` name, which another writer could clobber.
- **Confirm by hash, not time** (`control.ts`). `status.json` `rules.sha256` names the bytes the gate
  enforces and `rules.last_rejected.sha256` the bytes it last refused. So a write is `enforced` or
  `rejected` by its own hash, `superseded` when the file on disk no longer holds it (another writer),
  and `pending`, then `unconfirmed` after 10 s. A timestamp rule could not detect a rejection
  at all, because `loaded_at` does not move on one. Confirmation lags enforcement by up to ~5 s (the
  collector re-reads the file when it writes `status.json`).

#### The filter grant (glove v3)

Controls are enabled only when all three hold (`writer.ts` `controlStatus`, glove's handoff §5):
`glove.network.controlEnabled` is on; the session's filter grant is `granted: true`; and
`control/<id>/` exists in the writable control mount. glove's grant is checked first, because without
it no setting or mount could make a write take effect: an observe-only gate never reads a rules file.

- **Not granted**: "this session does not grant filter access", with the fix (add `filter: {}` under
  `extensions:` in its `glove-session.yml` and re-run `glove up`). There is deliberately no way for
  Layman to grant itself access; the hint is text only.
- **Revoked.** Removing `filter:` makes the next `glove up` move `rules.json` into the session
  directory (`.glove/ext/filter/rules.revoked.json`), remove `control/<id>/`, and set the grant back to
  exactly `{"granted": false}`. glove records the revocation **nowhere**: on disk a revoked session is
  identical to one never granted (compare the `filter-revoked` and `observe-only` fixtures). So Layman
  remembers the last `grants.filter.since` it saw, and whether it saw the control directory under that
  grant, in the `net_sessions` rollup (`filter_since` and `filter_saw_dir`, migration 4; local only,
  never synced), and calls a grant that has gone `revoked`, across restarts. A control directory that
  disappears while the grant still reads `granted` (glove mid-revocation, or `glove rm`) is `revoked`
  too, but only under the grant (the `since`) Layman saw the directory with, which survives a restart
  (a new `since` resets it, in `NetStore.noteFilterGrant`): a re-grant carries a new `since` and glove writes it before it creates
  `control/<id>/`, so in that gap the session is `granted` with `no-dir`, not `revoked`. Controls disable at the next poll, and Layman never
  recreates the directory or the file. A Layman that never saw the grant (recording off, or a fresh
  database) can only say "not granted".
- **Not enforced yet**: granted, but `status.json` has no `rules` object (gates starting). The Rules
  panel says so.
- **Corporate route.** glove's `corporate` egress passes the operator's allowlist to the gate as SSRF
  guard exceptions (from `glove-session.yml` only; `rules.json` has no key for it, and the v1 validator
  already rejects any unknown key), and its proxy runs a fixed `default: block` baseline that never
  reads `rules.json`. None of that is in `session.json`, so on a corporate route `predict()` does not
  predict the guard, and an `allow` is marked `allowlist`: "up to the corporate allowlist". Rules can
  block more there; they cannot allow more. The observed verdict still shows what really happened.
- **Cut all traffic** blocks the llm link by `service: llm`, not by scope, because glove v3's
  `lan`/`cloud` scopes cannot be named in a rule (`RULE_SCOPES`).

How it is built:

- **The validator is a port of glove's `policy.py`** (`rules.ts`; glove v3: `extensions/gate/netgate/policy.py`,
  unchanged for Layman except the corporate `StaticPolicy`, which is not a rules.json path). It covers every rejection, Python's
  quirks included: `v: true` passes as 1, an explicit `terminate: null` fails, netmasks and hostmasks
  in `ip`, and IPv6 scope ids accepted and ignored, which the cross-check found. Layman refuses to
  write anything it rejects. `rules.crosscheck.test.ts` feeds ~120 files and a set of flows to both
  the port and glove's own `parse_bytes` / `RuleSet.evaluate`, requires identical verdicts and matching
  rules, and runs `glove filter validate` on a file Layman wrote. It is skipped without glove or `uv`.
  Both cross-checks look for glove's v3 module paths; under glove v2 they skip (they used to skip
  silently against v3 until the paths were updated, which is worth remembering when glove moves code).
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
- **The guard comes first in the prediction.** glove's gate refuses a proxy destination that is not
  plainly public before any rule (`forward.py`): by the host's shape (an IP that is not globally
  routable, a single-label name, a local-only suffix), then by the IP its in-tunnel resolver returned
  (a host that resolves in-tunnel to `203.0.113.x` is refused as
  `builtin:ssrf-guard`). `rules.ts` ports `guard.check` (with the legacy numeric IPv4 forms and Python's
  `is_global` tables), and `predict()` applies it in the gate's order, then the rules. It runs only for
  a destination that came through an `http-proxy` listener (the declared service's `mode`; for a
  history-only destination, a resolution only a proxy produces), because a `tcp` listener goes to a
  fixed endpoint. Without it, Details, Trace and Topology named the user's rule for a destination the
  guard refuses. The cross-check requires the same answer as glove's own `guard.check` for 65 hosts;
  its tables follow the Python that runs the check (3.14), while glove's gate image runs 3.12, whose
  table may lack the newest entries (e.g. `3fff::/20`).
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

The world map full-bleed, with a Connection section in the detail card.

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
- **Labels never overlap.** Nearby cities (Ashburn/Virginia, London/Roubaix/Frankfurt) are placed
  greedily, biggest cluster first, right of the pin, then above right, left, above left
  (`placeLabels` in `lib/net-geo.ts`, after the exit's label); a label with no free side is hidden,
  and its pin's tooltip still names it. Zooming in brings it back.

### The Topology tab

The route a session's traffic takes, as a diagram of six columns, and a
Selected path panel that walks one destination's path hop by hop.

- **Columns**, left to right:
  - **Sandbox**: the session, its harness, and "no route out except through the gate".
  - **Gate services**: every service `session.json` declares, including one glove does not watch,
    which is drawn dashed with an eye-off icon ("declared · not watched") and a dashed line from the
    sandbox, since traffic there is invisible, not absent. A service seen in traffic but not declared is
    drawn too. The fan-out service says "SearXNG → gate · not the harness", and a dashed "triggers" link
    joins it to the `search` service, labelled just under `search` (halfway down, the `proxy` box that
    glove's declared order puts between them would cover the label). Every egress consumer gets its own
    link from the service whose tool triggers it (preferring a `-mcp` hop): `search-mcp` → `searxng-egress`
    and `webfetch-mcp` → `webfetch-egress` for Vibe. A consumer without a known trigger (Playwright's)
    gets none, rather than the search service's. With glove's `next` (round 13) the link is the hop's
    own band ("via <sidecar>", by bytes), and the dashed "triggers" label match is used only for a gate
    from before it.
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
  - **Order.** Services keep glove's declared order rather than byte order, as the design draws them, so
    the column does not reshuffle while traffic flows. Destinations are ordered by bytes, as the plan
    says (or by name or last seen: see below). Each column then gets one overlap-avoidance pass.
  - **Size.** Below 1000 × 420 the diagram is laid out at that size and scaled down, never scrolled.
  - **The destination column scrolls; nothing is folded.** Every reached destination has a row, at
    a fixed pitch inside the column's window. When they do not all fit, the column scrolls on its own
    (`DestColumn`, `maxScroll`). `projectTopology(t, scrollTop)` redraws only the bands into a
    destination. A band into a row in the window ends at its row, never moved. A band into a row
    scrolled out converges on the window's top or bottom edge, where one stub ("↑ 12 above · 3.1 MB",
    "↓ 40 below") stands for them all. Its width (`DestStub.width`) is the sum of their widths, and
    its bytes the sum of theirs. The end is the row's centre clamped to the window, plus the band's
    offset in the row's port stack, which shrinks to nothing over one row's height past the edge,
    so it slides continuously as a row leaves or enters and then meets the stub exactly. The tests
    hold it to that at every half pixel of scroll. `scrollToDest` centres a
    row, and a stub's `scrollTo` brings its nearest row into the window: clicking a stub scrolls
    there, and a destination chosen elsewhere (the Network tab, a link) is scrolled into view. The
    stubs' room is taken from the window only when the column scrolls. With hundreds of rows the
    exit's port stack is squeezed so every band still leaves the box (thin bands overlap there
    rather than run off its bottom). Rows sort within each group by bytes (the default), name or
    last seen: "sorted by bytes" under the column's heading cycles them, and the choice is kept in
    the browser. The "+N more" boxes and the "folded" footer are gone. 500 destinations lay out
    and project quickly (a test holds them to it).
  - **Scrolling it.** The wheel over the column scrolls it, not the page (a non-passive listener:
    React's is passive and cannot prevent the page's scroll). So do the scrollbar beside it (drag
    the thumb, click the track for a page), and, with the column focused, the arrow keys (a row),
    Page Up and Page Down (a window less a row), Home and End. Only the rows in the window are Tab
    stops (hundreds of hidden ones would trap the keyboard), and the diagram is a `group`, not an
    `img`, so its buttons and the column's key hint reach assistive technology. A destination
    chosen elsewhere is revealed when the choice, the session, the order or the size changes, never
    on live data: every delta is a new layout, and revealing on it pulled a selected row back while
    the user scrolled away from it. Every row is drawn once, in a group that is moved, and the window clips the rest.
    The scroll eases a quarter of the way per 60 Hz frame (`easeScroll`, the same whatever the frame
    rate), and lands at once when the user prefers reduced motion. During an animation, React does
    not re-render: each frame moves the row group, the thumb and the bands into destinations through
    the DOM, from `projectTopology`, and commits to React state when it lands or a stub's count
    changes. Re-rendering every band and row 60 times a second is what that avoids. A render that
    lands mid-scroll (live data during a drag or an animation) draws the bands at the committed
    scroll, so a layout effect repaints them at the live one; a new layout that scrolls less clamps
    the live and target scroll, or keys and the wheel would move nothing until they caught up. The key, wheel and
    scrollbar arithmetic is pure (`keyScroll`, `wheelDelta`, `scrollThumb`, `thumbDrag`) and tested.
    Another session or sort starts at the top.
- **Selecting.** Clicking a destination or a band selects that path. A band shared by
  several destinations selects the busiest. The selection is the same `dest=` the Map and the Network
  tab use, and every band not on the path dims.
- **Selected path panel.** The destination's hops, each with its status and whether glove **observed**
  it, only **declared** it (a dashed circle), or **verified** it:
  - the sandbox, with gate freshness and heartbeat age (a fan-out path starts at SearXNG instead,
    unless glove's `next` says which hop leads to it);
  - for a leg a sidecar dials after a hop (`next`: the llm upstream, a fetch or download egress),
    the hop's service and the sidecar ("llm-auth · the model call, with the API key added", "fetcher · page fetch or file
    download"), named as Topology names its hop band, before the leg's own service;
  - the service and its listener;
  - the policy verdict;
  - the route (a declared tunnel and its upstream health, a local link, or direct);
  - the exit (verified by exit identity, or not);
  - the destination, with its IP, port and offline location.

  A refused path stops at the policy hop, a broken one before the exit. Below the hops: sent and
  received tiles, Block (or Unblock), and Open in map.

### The Trace tab

One turn at a time, each tool call the agent made over the
flows the gate saw for it. This is what Layman can do and glove cannot: glove never learns the URL
behind an HTTPS `CONNECT`, but the harness transcript Layman records has the exact `web_fetch` call.
The footnote says so: tool calls come from the transcript and flows from the gate, and glove never
links them.

- **Which Layman sessions.** Those whose `sessionName` is the glove token (`GloveSource` labels the
  sessions it finds so), from the live store and from `recorded_sessions`. One glove session can hold
  several harness runs; their turns are listed together, in time order, within the glove session's
  span. Events come through `TurnStore`, so a long, recorded session works.
- **The join** (`netobs/correlate.ts`, pure, tested against glove's fixture). A turn owns the flows
  opened from its prompt until the next prompt. Within that window:
  1. A call that names URLs (a `url`-like argument, a `urls` list, or URLs in a shell command) claims
     a flow to the URL's host that opened between the call's start − 1 s and its end + 2 s. The host
     matches case-insensitively, and the port only when the URL spells one out. When two calls could
     claim a flow, the nearest start wins; this is how the fixture's two arxiv flows go to the abstract
     and the PDF fetches.
  2. A search call (`web_search`) claims the `search` service's flows and SearXNG's fan-out, grouped
     as "fan-out · N engines". A fetch call likewise claims the hop to a fetcher sidecar
     (`webfetch-mcp`: a tcp listener for `web_fetch`, unlike the `proxy`), whose destination is the
     sidecar; the sidecar's own egress joins by host under rule 1. Only the harness's fetch tool
     (`isFetchTool`: `web_fetch`, `WebFetch`, `…fetch_url`) claims that hop or is shown riding a kept
     connection to it; a shell `curl` names a URL too, but never goes through the sidecar.
  3. `llm` service flows are rows of their own between the calls.
  4. Anything else is **Unattributed**. Nothing is guessed.

  Calls that start at the same instant (one assistant message's parallel calls) share their flows in
  turn instead of the first taking them all.
- **Kept-alive connections** (found against real glove). pi keeps its connection to SearXNG open
  across searches, and SearXNG pools its engines' connections, so after the first search the later
  ones open nothing. Joining by open time alone left them reading "no traffic seen", which was false.
  A call now also lists `openIds`: matching connections (the search service and fan-out for a search,
  the same host for a fetch) that were already open when it started, including ones an earlier turn
  opened (`NetStore.flowsOpenAt`, excluding `gate_lost`). It reads "no new connection · searxng:8080 + 9
  fan-out already open". These are named, never claimed: metadata cannot say how many of a pooled
  connection's bytes were which call's, so the flow stays with the call that opened it and the turn's
  counts include only flows it opened.
- **Call times.** A turn's window needs events that carry the
  call's real start and end. Gloved pi (and gloved Claude Code, whose watcher shares the code) reaches
  Layman only through the passive watcher, which stamps
  every event with the time it *read* the transcript (up to a poll late) and records no start at all.
  The watcher now also keeps the transcript's own times (`data.transcriptAt`,
  `data.transcriptCompletedAt`; see `docs/harnesses/pi.md`), and the join uses them. A call is
  otherwise exact when its completion is after its start (a hook harness, a history import). For
  anything else, including pi events recorded before this change, only "it had ended by the time it
  was read" is known: such calls join by host alone, after the turn began, the first call read after
  the flow opened winning, and are marked **≈ time**.
- **The PII filter.** Events are PII-filtered before they are stored, so with the IPv4 category on,
  `http://169.254.169.254/latest/meta-data/` is recorded as `http://[REDACTED]/latest/meta-data/`. Such
  a call stays a fetch, is marked **redacted**, and joins nothing; its flow (here the guard refusal)
  goes to Unattributed. Flow records are not PII-filtered (they are hostnames and IPs by design), and
  Layman does not work around the user's filter to match them.

  **Settings → Glove → Show IP addresses in sandboxed sessions** (`glove.showIpAddresses`, off by
  default) is the user's way to change that. With it on, the filter leaves IPv4 and IPv6 addresses in
  gloved sessions' events, and everything else it redacts as before; other sessions are untouched. A
  session is gloved when a passive watcher found it under a glove sandbox root (`EventStore.markGloved`),
  not when it merely has a name: a renamed Claude Code session has one too, and an earlier "has a
  session name" check kept that session's IPs. The metadata fetch then keeps its IP, joins the guard refusal,
  and shows in Logs. It applies from the moment it is turned on: events already recorded stay redacted,
  and "purge PII" still redacts IPs everywhere (its confirmation says so). History import applies the
  same keep-set to transcripts found under a glove root. The kept IPs never leave the host: with the
  filter on, sync redacts event rows in full on the way out (the outbound readers in `sync/entities.ts`, and `CLAUDE.md`). The filter's keep-set had one trap: with the IPv4 pattern
  skipped, the phone-number pattern matched `169.254.169` inside the address. Kept matches are therefore
  parked behind private-use placeholders while the other patterns run (`redactString` in
  `pii/filter.ts`), and past a few thousand in one string the rest are redacted rather than left to
  the other patterns.
- **The waterfall.** Tool call → flows, outcome (worded from the legend), bytes, a timeline from the
  turn's start, and each flow's toggle, which opens the same block popover as the Network tab. "Only
  calls with traffic" hides calls that made none. When the turn has a guard refusal, it is selected by
  default: "the agent tried to reach cloud metadata" is the most important thing this tab can say.
- **The turn bar** has previous/next, the prompt, and chips: tool calls, flows, refused, blocked,
  bytes received. The latest turn shows by default and the view refreshes every 3 s.
- **Details.** For a flow:
  - the state and rule, and "The agent asked for" with the call;
  - what happened, and whether it can be allowed (the guard: no, and why the toggle is locked; your
    rule: Unblock; the default: Allow; allowed: Block);
  - the connection.

  For a call: its times, and how it was joined. **Open turn** goes to `/s/{sessionId}/t/{promptEventId}`
  (`buildPath`), and **Bookmark** saves the turn as a highlight.
- **Elsewhere.** The detail card's **Agent asked for** section asks the trace for the turn in which the
  destination's latest flow opened (`?at=`). While that turn is still running (pi's watcher records a
  call only once it finishes), it shows the latest earlier claimed flow's call, marked "an earlier
  turn". **Open in Trace** opens that turn with the flow selected. The Map's ribbon draws a marker for
  every tool call that started in its 60 s window, across turns (`/calls?from=&to=`).
- **API.** `GET /api/net/sessions/:token/trace?turn=<event id>|at=<ms>` and
  `GET /api/net/sessions/:token/calls?from=<ms>&to=<ms>` (at most an hour). The trace names the
  shown turn's neighbours (`nav`: position, count, previous and next prompt id), not the whole list:
  the tab refreshes every 3 s, and a list of every turn was 2.9 MB on a database with 28,000 turns. The
  tab schedules each refresh once the previous one settles, so a slow build never stacks requests.
- **Empty state.** With no Layman session named after the glove session, the tab says so; the other
  three tabs work without one. It also points to history import: the pi watcher replays only sessions
  touched in the last 5 minutes, so a Layman started after the agent went idle has no turns for it
  unless it was recording at the time.

### Persistence (`netobs/persist.ts`, `netobs/history.ts`)

Per-flow rows would dwarf the event tables, so Layman keeps **rollups**: one row per glove session
(`net_sessions`) and one per destination (`net_destinations`), migration 3 in `db/database.ts`, plus
their time axis (below).
- **When.** Written every 30 s, on shutdown, and before glove is switched off, only while session
  recording is on. Writes replace a session's rows in one transaction, so writing the same rollup
  twice changes nothing.
- **Not synced.** The tables have no journal triggers and no `SYNC_ENTITIES` entry: they describe one
  host's sandbox traffic, and must not travel to a central instance (also in `CLAUDE.md`).

**No double counting.** On restart the files are backfilled again, so the rows cannot simply be added
to what is read. The plan suggested resetting the rows when the backfill covers the whole history and
"adding only new flows" otherwise. That turned out to need per-flow knowledge it did not specify, so
the scheme is this:
- **What is stored.** The rows hold the totals as the views showed them, and a **watermark**: the
  latest record time they include.
- **Re-reading.** When the files are read again, the store tracks for every flow how much came from
  records before the watermark. That is exactly the part the rows already hold, so each view shows
  rows − that part + everything read.
- **Attribution.** A flow's already-counted part belongs to the destination key it had at the
  watermark, even if the destination is refined later (`sni-refined`).
- **The carry list.** Time alone is not enough. glove writes many records in one millisecond, and that
  millisecond may have been only partly read when the rows were written. A flow open at the watermark
  can also lose its opening record to rotation and reappear later. So the rows also carry the flows
  open at the watermark or with a record at it: their key, bytes and state (`carry_json`, tens of
  entries, not per-flow history). A record at the watermark counts as already held only for a carried
  flow, and a carried flow reappearing takes its held part from that list.
- **Consequence.** Totals from files glove has since deleted (rotation keeps 8), or that a
  byte-budgeted backfill skipped, are kept. Traffic written while Layman was down is counted once.
- **Tested.** `history.test.ts` checks it the hard way:
  - on glove's fixture, persist after every third record, restart with the oldest records deleted,
    and compare with one uninterrupted read;
  - restart after *every* record of the fixture and of the gate-lost, terminate, default-block,
    direct, pooled and sni-refined scenarios;
  - the running-app check restarts the container twice and requires identical totals and
    destinations.
- **Known imprecision.** A record older than the watermark that arrives after a write, out of time
  order, is not counted.

Two columns go beyond a plain total:
- **`blocked_guard` / `blocked_rule` / `blocked_default`**, because the KPI row splits blocked by who
  refused.
- **`watermark` and `carry_json`**, which the scheme needs.

**History only.** A glove session whose files are gone is still listed (the picker says "history"),
with its totals and destinations. The gate strip shows only a "History only" chip, because the gate,
route and rules it last saw are not current. Toggles are disabled with that reason. The Map, Topology,
Trace, Activity, Rules and Details panels say "History only". If its files come back, it is read
again, from its watermark.

### Runs, bursts and the hourly history (`netobs/segments.ts`, migration 6)

The session and destination rows above have no time axis, and a time range is read from glove's files,
which rotation deletes. Migration 6 adds the axis, kept for as long as Layman has recorded:
- **`net_runs`**: the collector's runs. A run is one `glove up` to its `glove down`, from glove's
  `type: gate`, `role: collect` start and stop records. What moved during a run is not stored with it:
  it is summed from the run's hours, so the two can never disagree.
- **`net_hours`**: one row per destination, tool, collector run and hour it was active. Each row holds
  the bytes moved in that hour, by record time, which is the same clip a time range uses. It also
  holds the flows first seen and refusals recorded in the hour, whether it is a hop, and the first and
  last record in the hour that moved bytes, opened a flow or was refused. A heartbeat is not activity;
  a refused connection is (the agent was trying something).
  - **By run**, so an hour in which one `glove up` ends and the next starts is two rows, each with
    exact edges. A record belongs to the latest run started at or before it, unless that run had
    stopped more than 5 s earlier (forwarders' last records trail the collector's stop): traffic while
    no run was up belongs to none.
  - **By tool**, so a model call is never hidden by another tool using the same host in that hour.
  - **Hops follow session.json.** When it changes which services are hops (it was unreadable when the
    flows were read, or glove rewrote `next`), the store re-flags the destination's hours along with
    its flows. Without that, the hop leg of a model call stayed in the hours and counted twice.

Both tables are local only and never synced, as migration 3. They are counted by the restart rule
above: records before the watermark are already held, and a carried flow counts only what it moved
beyond the carried part. `history.test.ts` holds the hours and runs to one uninterrupted read at
every restart point, alongside the totals; disabling either part of the rule fails it. Hours are
**upserted**, not rewritten. A save every 30 s writes only the hours that changed, which keeps the
cost flat as history grows. Rows kept before migration 6 (`net_sessions.hours_kept = 0`) hold no
hours, so the store counts the hours of everything it re-reads instead of skipping what came before
the watermark.

`GET /api/net/sessions/:token/segments?gap=<hours>` (1–24, default 6) builds the ready-made ranges
from them:
- **Runs.** How each run ended: `stopped`, `died` (the collector's inferred stop, or none written for
  the last run of a gate no longer running, which then ends at its last activity), or `replaced`
  (no stop, and the next run started).
- **Bursts: the agent at work.** Model calls (`tool: llm`) with no pause of `gap` or more, inside one
  run. On a real session, one `glove up` ran three days and held four daily reports, so a run alone is
  too coarse. **Model calls, not any traffic**, because a sandbox is never quiet: between reports the
  headless browser's sidecar kept up about 550 connections and 770 KB an hour, plus its telemetry, so
  the busiest 6 h pause in all traffic was none at all. Measured on a copy of that session, the 3-day
  run split into its four reports (Oct 17 06:31–10:45, 21:33–22:38, Oct 18 20:07–21:15 and Oct 20
  04:14). A session with no model calls observed (a model the gate does not carry) falls back to all
  traffic, and `burstBasis` says which was used. A burst's edges are its first and last active record.
  Its totals are all the traffic in the hours it spans.
- **Agent sessions.** The Layman sessions Trace joins (`sessionName` is the token), from their first
  to last event, by transcript time where the pi watcher kept it.
- **`hours`.** The session's activity per hour, hops' bytes left out, with `inference` marking hours
  with model calls, for an activity calendar.

On that session, runs, hours and the store agree to the byte (984.6 MB sent).

**Known imprecision.** A run whose start record glove deleted before Layman ever read it (Layman first
installed partway through a long run) starts at the earliest collector record Layman saw, its stop. Its
traffic before that stop belongs to no run, so it shows as bursts of no run, and the run itself as
having moved nothing. Once Layman has seen a run start, its row keeps it.

### Configuration

`glove.network` in `GloveConfigSchema`: `enabled` (default true, meaningful only with `glove.enabled`),
`controlEnabled` (default true; false makes every toggle read-only, and is the Settings toggle "Allow
blocking from Layman") and `geoipDbPath` (the Map's offline geolocation database; empty means none). `glove` and `glove.network` are deep-merged in
both `loadConfig()` and `updateConfig()` — before this, `glove` was not, so a Settings update carrying
only `glove.enabled` would have blanked the glove path (`sessionsDir` then, `home` now), and one carrying a single network toggle would
have reset the others. With glove (or its network views) off, the store is emptied and the session list
is empty, so nothing changes for users who don't run it.

### Testing against a fake glove

`netobs/__fixtures__/` is a byte-for-byte copy of glove's `tests/fixtures/netobs/` (see its README for
the source commit and how to refresh it). `fixture.test.ts` loads it through discovery, tailing and the
store and asserts every fixture state in glove's state table plus the fixture's totals; a drift guard fails when
the copy differs from `../glove`, and is skipped when glove is not checked out beside this repo.

The v2-era fixtures are copied unchanged and laid out as a glove v3 session in the tests
(`netobs/testing/glove-home.ts`: `observe/<id>/net/`, a v2 registry row with grants, the session
directory with its `.glove/id`, and `control/<id>/` with the filter grant; `asId()` rewrites a fixture's
`env`/`session` to the id).

`netobs/__scenarios_v3__/` is a copy of glove's `tests/fixtures/netobs-v3/`: one whole `~/.glove` per
grant state (`observe-only`, `observe-filter`, `observe-no-transcripts`, `filter-revoked`, `orphaned`,
`not-observable`). `v3.test.ts` reads each through discovery, the store and the rules control and
asserts the control lifecycle above, plus the corporate prediction; `monitor/sources.test.ts` reads the
same homes through `GloveSource`. It has its own drift guard.

`netobs/__scenarios__/` is the same for glove's `tests/fixtures/netobs-scenarios/`: sixteen real `net/`
directories, one per state the first fixture lacks (`default-block`, `direct`, `rules-rejected`,
`terminate`, `gate-lost`, `stopped`, `pooled`, `rotation` with a same-millisecond collision, and more),
written by glove's real forwarder and collector code. `COPIED.md` records the source commit and the
refresh command. `scenarios.test.ts` reads each one through the same path, with "now" one second after
its heartbeat since every fixture is stale when read later, and asserts the state it exists for. It
has its own drift guard.

`packages/server/scripts/netobs-replay.ts` builds a fake glove home from the fixture with timestamps
moved to now and replays it at its recorded pace (`--speed`, `--loop`, `--rotate-every N`, `--direct`).
The home it writes is a glove v3 one: each session is `observe/<name>-c0ffee/`, registered in a v2
`registry.json` with the observe and filter grants, with its session directory and `control/<id>/`.
`--gate` adds a fake gate: it polls the session's `rules.json`, validates it with the port, reports
`status.json` `rules` as glove's collector does (hash, `last_rejected`, the last good set kept on a
rejection, a ~5 s status lag), refuses matching new connections, and cuts open flows for `terminate`
rules. `--scenario <names|all>` replays scenarios instead, each into its own glove session (`<scenario>-c0ffee`), so
every state can be looked at in the session picker; a later `--loop` pass gets fresh flow **and run**
ids, which to the reader is a restarted gate. `--transcript` also writes a pi session into the fake
session's transcript export (`observe/pi-search-c0ffee/transcripts/--work--/`), one turn per pass whose
`web_search` and `web_fetch` calls match the fixture's flows at the fixture's moments. GloveSource and
the pi watcher then record it as a real gloved session named `pi-search-c0ffee`, which gives the Trace tab
something to join:

```bash
pnpm --filter ./packages/server netobs:replay -- --dir /tmp/layman-netobs/glove --speed 0.2 --loop --rotate-every 30 --transcript
pnpm --filter ./packages/server netobs:replay -- --dir /tmp/layman-netobs/glove --scenario all
# then: glove.enabled = true, glove.home = /tmp/layman-netobs/glove
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

**Layman never creates, chmods or relabels anything under `~/.glove`.** glove v3 creates `control/`
with its home (`glove new`, any registry write), and `control/<id>/` only for a session with the filter
grant. The only write is that session's `rules.json` inside glove's existing `control/<id>/`, by
glove's own contract (Writing rules, above). The mounts are unchanged from glove v2. The writable
path is safe to expose because the gate's schema can express only allow/block verdicts over
destinations. An earlier draft of this phase had `make docker-run` create `~/.glove/control`, and the
mounts carry the SELinux shared label `z` (which relabels host files). Both were taken out: they
changed glove's folders from Layman's side. glove took over what they did (glove PR #12):

- **`control/` exists whenever glove has set up its home.** Any registry write (in v3, `glove new` or
  `glove up`) creates it as the user, and glove warns, with the `sudo chown` that fixes it, when it
  belongs to someone else.
- **SELinux-enforcing hosts (Fedora, RHEL) are unsupported, for glove and for Layman alike.** glove
  itself does not run there yet, because its harness binds are unlabelled. There, Layman's binds are
  denied, and that is expected. Layman must not add `z`/`Z`: that would relabel glove's files from
  Layman's side, and a recursive `z` would relabel every harness home. glove withdrew its earlier advice
  to use them. Labelling (and whether harness homes may be shared with another container at all)
  belongs to the future work that makes glove run on SELinux.

The nested rw-inside-ro bind was checked on Docker Desktop and on rootless Podman (a macOS Podman
machine): the rest of `~/.glove` stays read-only, `control/` is writable, and a file container root
writes lands owned by the host user. See the "Docker mounts" note in the root `CLAUDE.md`.

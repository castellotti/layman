# netobs scenarios

One directory per state in the handoff's §6.1 that the original fixture
(`../netobs/`, which stays byte-identical) does not contain. Each is a complete `net/` directory
(`session.json`, `flows.ndjson` and any rotated `flows-<stamp>[-<n>].ndjson`, `exit.ndjson` when
there is an exit record, `status.json`) plus `rules.json` where the state involves rules — laid out
exactly as `~/.glove/envs/<env>/sessions/<name>/net/`, except that `rules.json` really lives in
`~/.glove/control/<env>/<name>/`. Env and session token are `pi-search` throughout.

Written by the real gate code: real `Forwarder`s carry real loopback connections into a real
`Collector` (its writer, rotation, gate lifecycle records, exit carry-forward and `PolicyWatcher`).
The two substitutions, which change no record's shape: the collector is fed directly rather than
over the unix datagram socket, and upstream dials go to loopback stubs while the forwarder keeps the
deployment's names. Regenerate with `uv run python tests/fixtures/netobs-scenarios/generate.py
[name …]`; `tests/test_netobs_scenarios.py` keeps each one valid against the handoff and checks
that it still shows its state. Timestamps are wall-clock times of the generation run, so a reader
testing gate freshness must fake "now" (every fixture here is "stale" when read later).

These fixtures carry the additive fields and records the original one predates: `run` on every
flow record, `gate` start/stop records in `flows.ndjson`, and `rules.sha256` /
`rules.last_rejected` in `status.json`.

| Scenario | What it contains | Synthetic? |
|---|---|---|
| `default-block` | `default: "block"` with one allow rule: `en.wikipedia.org` allowed, `arxiv.org` blocked with `verdict: "block"`, `rule: null`, `close_reason: "blocked"` | no |
| `direct` | the proxy route declared `direct` (`session.json` `upstream_kind: "direct"`, `exit_identity: "none"`): a flow with `scope: "direct"`, and a guard refusal with `scope: "local"` | no |
| `rules-rejected` | a good `rules.json` was accepted, then replaced by one with an unknown top-level key. `status.json` `rules`: `ok: false`, `error`, `sha256` = the still-enforced good file, `last_rejected` = the bad one (whose bytes are the `rules.json` here); a flow then blocked by the *good* file's rule | no |
| `terminate` | an established `arxiv.org` download cut by a `terminate: true` rule written mid-flow: `verdict: "block"`, `rule: "r_…"`, `close_reason: "blocked"` on the close, updates before it | no |
| `resolver-down` | the in-tunnel resolver refuses: `status.json` `resolver.healthy: false`; flows `resolution: "unavailable"`, `dest.ip: null`, and still `verdict: "allow"` (traffic is fine) | no |
| `telemetry-dropped` | the collector's disk filled for a while: `telemetry.dropped > 0`. Consequences a reader must tolerate, as produced: a flow whose `close` was dropped (looks open forever), and a `close` with no `open` | fault injected (`ENOSPC` from `os.write`) |
| `record-full` | `record: "full"` + `record_headers`: a cleartext `GET` with `request.url` and `headers` (`Authorization`/`Cookie` as `"[redacted]"`), and a `CONNECT` with `url: null` | no |
| `exit-none` | `exit_identity: "none"`: there is **no** `exit.ndjson` file at all (it is created on the first exit record), so "absent" and "empty" must mean the same to a reader | no |
| `exit-unhealthy` | `exit.ndjson`: a healthy exit, then `healthy: false` with null address fields (the tunnel stopped answering the IP echo) | no |
| `pooled` | an `llm` flow that stops changing after ~0.5 s and stays open with **no further records** (the gate emits `update` only when bytes change), while a `web_fetch` runs on for over 3 s | no |
| `sni-refined` | a `tcp` flow silent past 250 ms: `open` has the configured `dest.host: "host.docker.internal"`, later records the SNI `llm.operator.lan` | no |
| `rotation` | `rotate.max_bytes: 6000`: `arxiv.org` opens in `flows-<stamp>.ndjson` and closes in the live file; a same-millisecond collision `flows-<stamp>-1.ndjson` (newer than `flows-<stamp>.ndjson`), with a flow straddling it | the writer's clock frozen for one burst, to force the collision |
| `empty` | proxy connections that sent nothing: one closed at once (`close_reason: "eof"`), one idle past the head timeout (`"timeout"`), both `verdict: "allow"`, `dest.host: null`, `scope: "local"` | head timeout shortened to 0.5 s |
| `search` | one `web_search`: the `search` flow (`tcp`, `dest.host: "searxng"`) open while SearXNG's four engine fan-out flows (`service: "fanout"`, `client: "searxng"`, `tool: "search-engine-fanout"`) run and close, then the search flow closes | SearXNG is a stub that fans out through the real fan-out gate |
| `stopped` | a clean `glove down` mid-download: forwarders stop first (`gate_shutdown` close, then each forwarder's `gate` `stop`), then the collector (`gate` `stop`, `status.json` `state: "stopped"`) — the order verified live with Docker Compose | no |
| `gate-lost` | a forwarder SIGKILLed mid-download: no `close`, no `stop` from it; the collector's inferred `stop` (`"inferred": true`) ends its run, so the open flow reads as cut | the kill is simulated (the forwarder's records stop) and the collector's clock is advanced past the 30 s heartbeat, so the inferred `stop`'s `t` is 0.5 s after the last update; live it is 30–40 s later |

# Multi-host sync — implementation progress

Companion to [`multi-host-sync.md`](multi-host-sync.md). Tracks what has been built,
the branch/commit layout, test status, and — most importantly — every place the
implementation deviated from the plan, so the plan can be corrected.

**Status:** all five implementation phases (0–5) complete on stacked branches,
none merged yet, plus a follow-up mirror fix on `sync/phase-4-fix-mirror-fuse`
(`8dc64e5`) after live two-machine testing. Last updated after that fix.

---

## Live two-machine test (2026-09-05) — central `Nyx.local`, client `Odyssey.local`

Central = an existing install with **657 sessions / 180,404 events / 158 MB**
(docker); client = **12 sessions** (podman on macOS). Central was moved onto a
new branch `test/multihost-sync` at commit `c2b16ae` via a local git bundle
(no GitHub access on that host), bound `0.0.0.0`, role Central. Client ran
`sync/phase-5`, role Remote.

**Passed:** migration/identity, token enrolment (TOFU bind), test-connection,
push (client→central backfill, no duplicate events), host attribution
(`?host=`, resolve, search `hostIds`), deletion + suppression (deleted on
central, kept on client, not resurrected after re-push).

**Found a real defect — mirror pull corrupted the client DB.** Enabling Mirror
made the client snapshot central's full history; around ~68 k of 180 k events
the client's `layman.db` corrupted (`PRAGMA integrity_check` → invalid btree
page numbers) and the server crash-looped. This is the FUSE / bind-mount failure
class `db/database.ts` documents. Root cause, in order of impact:

1. `SyncApplier` ran a full `COUNT`/`SUM` over `recorded_events` on **every
   snapshot page** (`updateHostStats`) — hundreds of heavy scans interleaved
   with the bulk writes on the FUSE mount.
2. No pacing between the ~360 write transactions (one per 500-row page); DELETE
   journal creates/deletes a rollback file per transaction over FUSE.
3. Aggravating (test-only): a host-side `sqlite3` CLI polling the live DB file
   during the import — a second process over a mount whose cross-process advisory
   locking is unreliable.

Recovery: `sqlite3 .recover` produced a clean DB (integrity `ok`, **zero
committed rows lost**); mirror disabled, cursors cleared, swapped back.

### Fix (`sync/phase-4-fix-mirror-fuse`, `8dc64e5`)

- `ApplierOptions.deferStats` — skip the per-batch counter refresh; the puller
  sets it for snapshot applies and calls `recomputeHostStats` **once** at the end.
  Removes the hundreds of heavy interleaved scans (cause 1).
- Puller paces between snapshot pages (`LAYMAN_SYNC_SNAPSHOT_PACING_MS`, default
  40 ms) so writes don't sustain back-to-back (cause 2).
- Puller logs a warning at snapshot start inside a container.
- Re-test avoided the host-side CLI reader, monitoring only via `/api/sync/*`
  (cause 3).

**Re-test result:** full **180,404-event** mirror completed on the podman FUSE
bind mount with **`integrity_check ok`, no duplicates, no crash**; 657
central-origin sessions attributed to `Nyx.local`; offline search over mirrored
data returned 46 k matches from the client.

### Push side now also defers stats (`8dc64e5` + follow-up)

The *receiving* side of **any** bulk transfer over a FUSE bind-mounted DB is the
hazard, not just mirror — a large remote's first backfill-push onto a central has
the same shape. The push receive path now also applies with `deferStats: true`,
and `server.ts` recomputes the pushing host's counters on a per-host 3 s debounce
(`scheduleHostStats`) instead of per batch. So the O(n²) stats amplifier is gone
in **both** directions.

### Honest framing of what this fix is and is not

**Do not call this "corruption-proof."** Of the changes:

- **`deferStats`** (both directions) is a genuine fix — it removes an accidental
  O(n²): the applier was running a full `COUNT`/`SUM` over `recorded_events` on
  every page. Worth keeping on its own merits.
- **Pacing** (pull only) is a *mitigation* — it lowers the sustained write rate,
  reducing probability, not eliminating the failure.
- **Neither touches the substrate.** SQLite in DELETE journal mode over a FUSE
  bind mount remains fragile under bulk writes. The single-process `fsync`
  ordering failure mode is not addressed at all.
- The passing 180k re-test changed **two variables** (added the fix *and* removed
  the concurrent host-side `sqlite3` reader), so it proves the fix helps but does
  not isolate cause or prove durability under a second reader / mechanism B.

**The complete fix is deferred to a dedicated future effort** (single-owner
datastore and/or storage placement off the FUSE mount), to be planned by a
separate agent from a clean context **after all PRs are merged and the feature is
working with reasonable reliability**. The full problem brief — every perspective
discussed (bidirectional hazard, the two corruption mechanisms, the storage-
placement options, the reframed sidecar/single-owner idea, invariants to
preserve, the decisive experiment to run first, and acceptance criteria) — is in
[`multihost-sync-durability-followup.md`](multihost-sync-durability-followup.md).

---

## Branch / commit layout

Each phase is its own branch, **stacked** on the previous one (not re-cut from
`main`). Merge into `main` in order 0 → 5.

| Branch | Commit | Phase |
|---|---|---|
| `sync/phase-0` | `73457f4` | identity + journal schema (migration 2, triggers) |
| `sync/phase-1` | `9c9e17b` | push protocol, tokens, applier, management API |
| `sync/phase-2` | `1a8164b` | host attribution UI, search/resolve, Settings, read-only curation |
| `sync/phase-3` | `4013c88` | live remote presence on the Dashboard |
| `sync/phase-4` | `939606c` | mirror pull, compaction, retention |
| `sync/phase-5` | `515b9e9` | docs + hardening |

Because the branches are stacked, merging phase-0 lets the rest fast-forward /
rebase cleanly. If a per-phase PR off `main` is preferred, re-cut each branch
after its predecessor merges.

## Test status (Node 22 via fnm — the repo's pinned version)

- `pnpm -r typecheck` — all 4 workspace projects pass.
- `pnpm -r test` — **server 550 passed (35 files)**, **web 249 passed (13 files)**.
- `pnpm build` — both packages build.

> **Environment note:** the machine's default `node` on `PATH` is v26, but
> `better-sqlite3` in this repo is compiled for Node 22 (`fnm` default). Run the
> suite with `eval "$(fnm env)" && fnm use 22` or every `:memory:` DB test fails
> with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. This is not a code
> problem; it is a local toolchain detail.

## New dependency

- `@fastify/compress@^7` added to `packages/server` (Phase 1) for scoped gzip
  request decompression on the sync routes. Recorded in `pnpm-lock.yaml`.

---

## Deviations from the plan

These are places where the code diverges from `multi-host-sync.md`. Per the
kickoff rule ("code wins for existing behaviour, plan wins for new behaviour"),
each is a deliberate correction of the plan for new behaviour; the plan text
should be updated to match.

### 1. Q&A journal trigger is folded, not split (§4, Phase 0)

The plan shows a separate `trg_qa_sync_id_default` (assigns `sync_id`) and
`trg_qa_log_ins` (reads it into `sync_log`). **This does not work:** two sibling
`AFTER INSERT` triggers on the same table do not see each other's row
mutations, so the log trigger's `(SELECT sync_id …)` read `NULL` and hit a
`NOT NULL constraint failed: sync_log.entity_id` (verified). The `sync_id`
assignment is therefore done in the **first statement of `trg_qa_log_ins`'s own
body** (statements within one trigger body run in order), guarded by
`WHERE … sync_id IS NULL` so an applier-supplied id survives.

**Plan fix:** replace the two-trigger qa recipe in §4 with the single folded
trigger.

### 2. Host/`sync_id` backfill runs in `ensureHostIdentity`, not `applyMigrations` (§4/§5, Phase 0)

§4 lists the backfill "in the same migration"; §5 acknowledges it needs the host
id first. `applyMigrations()` is structure-only (idempotent DDL); the row
backfill (`host_id`, `updated_at`, `sync_id`) and the local `sync_hosts` row are
written by `ensureHostIdentity()` (exported `backfillHostColumns`), which runs
after `openDatabase()` once `sync_state.hostId` is known. This matches §5's
"split so migrations can run after identity is known".

**Plan fix:** move the backfill bullet from §4 into §5 explicitly.

### 3. `sqlite_master` parity assertion is name-set + sync-object SQL, not full-text (§4 test, Phase 0)

The plan's migration test asserts a fresh and an upgraded DB "end with identical
`sqlite_master` entries". Base tables legitimately keep their **original**
`CREATE` text (whitespace / ALTER ordering differ between the hand-written
`OLD_DDL` in the test and the code's base DDL), so full-text equality is fragile.
The test asserts identical object **name sets** for everything, plus identical
full SQL for the **sync-created** objects (whose text is emitted identically down
both paths). Same guarantee, robust to base-table formatting.

### 4. `SyncApplier` gained a `trustRowOrigin` option (§3.8/§3.10, Phase 4)

The plan's applier signature is `apply(peer, batch)` and forces every row's
origin to the single authenticated peer. That is correct for **push** (a peer may
only push its own data) but **wrong for pull**, where central relays rows from
many hosts, each with its own `host_id`. Added `apply(originHostId, entries,
{ trustRowOrigin })`:

- push → `trustRowOrigin: false` (default): row `host_id` forced to the pusher.
- pull → `trustRowOrigin: true`: each row keeps the `host_id` it carries.

Without this the mirror would stamp every mirrored row as central's, destroying
attribution. This is now documented as a load-bearing rule in `CLAUDE.md`.

**Plan fix:** note the `trustRowOrigin` distinction in §3.8/§3.10.

### 5. `SyncClient` split into `PushClient` / `PullClient` (Phase 1/4)

`SyncClient` is the full transport (`hello`, `push`, `snapshot`, `changes`).
`SyncPusher` accepts `PushClient = Pick<SyncClient,'hello'|'push'>` and
`SyncPuller` accepts `PullClient = Pick<SyncClient,'hello'|'snapshot'|'changes'>`,
so a test fake for one role need not implement the other's methods. Purely an
internal typing refinement; no protocol change.

### 6. Presence TTL uses the default interval, not the remote's reported one (§3.7, Phase 3)

The plan sizes the presence TTL at "3 × the remote's interval". The remote's
`intervalSeconds` is **not currently threaded** to central (neither `hello` nor
the push body carries it), so `RemoteSessionRegistry` uses the 5 s default →
15 s idle window. Correctness is unaffected (the TTL only decides when a remote
session's dot goes idle), but a remote configured with a long interval will show
idle sooner than intended.

**Follow-up (not blocking):** include `intervalSeconds` in `hello` (or the push
`live` payload) and call `registry.setInterval(hostId, n)` on receipt. The
registry already exposes `setInterval`.

### 7. Mirror learns host names via snapshot/changes `hosts`, not a synced table (§3.10, Phase 4)

For a mirror's host chips to render, it needs `sync_hosts` rows (with names) for
hosts it has never met. Rather than syncing `sync_hosts` as an entity, the
`SnapshotPage` and `ChangesResponse` carry a `hosts: HostStats[]` array that the
puller upserts via `upsertRemoteHost` (kind `remote`, never touching its own
local row). Small, self-contained; no new entity kind.

---

## Client-side notes (Phase 2)

- Read-only remote curation is enforced **server-side (403)** *and* mirrored in
  the client, which hides rename/delete/drag affordances via the pure
  `isEditableCuration(row, localHostId)` helper (unit-tested in `lib/host.test.ts`).
  Both Sessions (bookmarks) and Prompts (highlights) folders and rows are gated.
- Per the plan, there is no DOM test setup; UI logic lives in pure helpers
  (`hostAccent`, `isEditableCuration`, `hostLabel`, `formatContentBytes`) that are
  unit-tested, plus `sessionStore` merge tests and `db/search` host-filter tests.

## Not yet done / out of scope

- **Manual two-machine acceptance (§11)** — untouched; requires two built images
  on a private network. Ready to run once a phase is merged and imaged.
- **`docs/images/multi-host-sync.png`** — referenced by `docs/features.md` as a
  screenshot placeholder; not captured yet (needs a running two-host setup).
- Everything under §12 "Future" (last-writer-wins curation, chained hubs,
  analysis on central for remote events, syncing dismissed drift items) remains
  future work, as the plan intends.

# Multi-host sync — implementation progress

Companion to [`multi-host-sync.md`](multi-host-sync.md). Tracks what has been built,
the branch/commit layout, test status, and — most importantly — every place the
implementation deviated from the plan, so the plan can be corrected.

**Status:** all five implementation phases (0–5) complete on stacked branches,
none merged yet. Last updated after Phase 5.

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

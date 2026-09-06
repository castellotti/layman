# Multi-host sync — database durability under bulk transfer (future work brief)

**This is a problem brief, not a plan.** It exists so a future agent — starting
from a clean context — can do the actual design and planning for a *complete*
fix. **Do not implement from this document without first producing a plan and
getting it approved.** The immediate feature ships with stopgaps (below); this
describes the underlying issue those stopgaps only *reduce*, and every
perspective considered so far.

**Prerequisites before this work starts:**
1. The six multi-host-sync PRs (#91–#96) are merged.
2. The follow-up fix on branch `sync/phase-4-fix-mirror-fuse` (deferStats +
   pacing + push-side deferral) is merged.
3. The feature is working with *reasonable* day-to-day reliability for normal
   (small, incremental) syncs. This brief is about the *bulk* edge, not everyday
   operation.

Related reading: [`multi-host-sync.md`](multi-host-sync.md) (the feature design),
[`multihostsync-progress.md`](multihostsync-progress.md) (implementation +
deviations + the live-test incident), and the long comment in
`packages/server/src/db/database.ts` (why the DB uses DELETE journal mode).

---

## 1. What happened (the incident)

During live two-machine testing (2026-09-05), enabling **Mirror** on a client
made it snapshot a central with **657 sessions / 180,404 events / ~158 MB**. Part
way through the event import the client's `layman.db` **corrupted** (`PRAGMA
integrity_check` → invalid btree page numbers), the server process died, and the
container restart-looped on the bad file. `sqlite3 .recover` produced a clean DB
with zero *committed* rows lost.

This is the same failure class `db/database.ts` documents (a prior corruption on
2026-08-05, `btreeInitPage() error 11`).

## 2. The substrate — why this is possible at all

- `layman.db` lives at `~/.local/share/layman/layman.db` and, in the normal
  Docker/Podman deployment, is a **bind mount** into the container. On macOS that
  mount is **FUSE-backed** (virtiofs / gRPC-FUSE).
- The DB runs in `journal_mode = DELETE` **on purpose**: WAL needs an
  mmap-coordinated `-shm` file and correct cross-process POSIX advisory locks,
  neither of which a FUSE bind mount reliably provides. DELETE was chosen as the
  safe option **for the normal workload**: a single writer process (the server,
  via better-sqlite3, single-threaded) writing one small row per hook event.
- **Bulk sync violates the assumptions of that compromise.** A snapshot/backfill
  applies hundreds of thousands of rows in a tight loop of transactions, each of
  which (in DELETE mode) creates and deletes a rollback journal file on the FUSE
  mount, and relies on `fsync` to order the journal against the main DB.

## 3. Root-cause analysis — two mechanisms, not cleanly separated

There are **two** plausible corruption mechanisms, and the incident did not
isolate them:

**A. Multiple processes over an unreliable-locking mount.** During the failing
run, a *second* process (a host-side `sqlite3` CLI polling for progress) read the
live file while the container wrote it. FUSE advisory locks are exactly what
DELETE-over-FUSE cannot be trusted to coordinate. This was almost certainly a
contributor and possibly *the* trigger.

**B. Single-process fsync ordering/durability.** SQLite depends on `fsync`
honoring durability and ordering (journal fully on disk before the DB pages it
protects are overwritten). If the FUSE layer lies about or reorders `fsync`
during a heavy write burst, a torn write can corrupt the btree **even with a
single writer and no second reader.** This mechanism is *not* addressed by
anything shipped so far.

**Amplifier (now fixed, was accidental O(n²)).** The applier recomputed a full
`COUNT`/`SUM` over `recorded_events` on **every** page (`updateHostStats`) —
hundreds of full-table scans interleaved with the writes, turning an O(n) import
into O(n²) of heavy read/write interleaving. This made the write phase far longer
and more contended, widening the window for A and B. Removing it (deferStats)
is a genuine fix for *that* contributor.

## 4. It is bidirectional — the hazard is receiver-side

The risk belongs to **whichever side receives a bulk write**, independent of
direction:

- **Pull (mirror):** a mirror receives central's whole history → the *mirror's*
  DB is at risk. (This is what failed in the test.)
- **Push (backfill):** a remote with years of history doing its first backfill
  makes the *central* apply millions of rows in the same tight loop → the
  *central's* DB is at risk. This was not observed only because the test client
  was tiny (12 sessions). A large remote onto a FUSE-mounted central would hit
  the identical shape.

Any complete fix must cover **both** receive paths.

## 5. What has been shipped as stopgaps (and their limits)

On `sync/phase-4-fix-mirror-fuse`:

| Change | Kind | Covers | Limit |
|---|---|---|---|
| `ApplierOptions.deferStats` (pull snapshot **and** push apply) | real fix | the O(n²) stats amplifier, both directions | doesn't touch the substrate |
| Puller paces between snapshot pages (`LAYMAN_SYNC_SNAPSHOT_PACING_MS`, default 40 ms) | mitigation | reduces sustained write rate on pull | probability reduction only; pull only |
| Push apply defers stats; server recomputes the pushing host's counters on a per-host 3 s debounce | real fix | the O(n²) amplifier on the push receive path | no pacing on push yet |
| Container warning at snapshot start | diagnosability | — | — |

**These do not make bulk transfer corruption-proof.** They remove a large,
pointless I/O amplifier and throttle one path. Mechanism B (single-process fsync
ordering over FUSE) is untouched. Do not describe the current state as "fixed";
describe it as "much less likely, root cause outstanding."

**Honesty caveat about the passing re-test:** the successful 180k-event re-test
changed *two* variables at once — it added the fix **and** removed the concurrent
host-side `sqlite3` reader. So the pass demonstrates the fix *helps* but does
**not** prove deferStats+pacing alone would survive a bulk import while another
process touches the file, nor that it addresses mechanism B. A controlled
single-variable repro is the first thing the future work should do (see §8).

## 6. Options considered (for the planner to weigh — not decisions)

**Option 1 — Storage placement (get the DB off the FUSE bind mount).**
- 1a. A Docker/Podman **named volume** (ext4/overlay inside the VM) → WAL becomes
  safe, bulk imports are fine. *Cost:* the DB is no longer a host-inspectable
  file, which breaks the current backup/restore model (`migrateLegacyData`,
  "drop a backed-up `layman.db` in `~/.claude` to restore", direct `sqlite3`
  access). Would need a first-class export/import path to compensate (one exists
  for sessions: `/api/sessions/:id/export` ↔ `/api/bookmarks/sessions/import`).
- 1b. **Native install** (no container) → real filesystem → WAL. Not the primary
  deployment, but the `db/database.ts` comment already anticipates this: *"If
  Layman is ever run natively … WAL would be safe and faster. Detect that before
  changing it back."*
- 1c. **Detect real-FS vs FUSE at startup** and choose DELETE vs WAL accordingly.
  Detection is non-trivial and fragile (how do you reliably tell virtiofs from
  ext4 from inside the container?), and getting it wrong re-introduces the exact
  corruption. High risk.

**Option 2 — Single-owner architecture (the "sync sidecar", reframed).**
The valuable kernel is an **invariant: exactly one process ever opens the SQLite
file.** That would eliminate mechanism A entirely (no cross-process locking to
get wrong). Note two things the planner must not miss:
- The **JSON transport between central and remote already exists** (the
  `/api/sync/*` HTTP protocol). A sidecar adds nothing there.
- A *naive* sidecar (a second process writing the same file) makes things
  **worse** — now there are definitely 2+ processes contending. It only helps if
  it becomes the **sole** owner of the file and every other component (the
  dashboard server, the sync loops) goes through it over IPC.
- It does **not**, by itself, fix mechanism B — a sole owner still needs a
  filesystem that honors `fsync`. So Option 2 likely needs Option 1 underneath to
  be truly durable.
- Cost: touches every DB call site in the server; a significant re-architecture.

**Option 3 — Substrate-independent bulk import.** Import to a scratch DB on a
guaranteed-real FS path *inside* the container (the container's own overlay, not
the bind mount), then atomically move/attach it into the bind-mounted DB in a
single operation — collapsing hundreds of FUSE transactions into one file move.
Swap semantics over a live DB are tricky (open handles, in-flight hook writes);
needs careful design.

**Option 4 — Different store for a central collecting a fleet.** If a central is
expected to aggregate many large hosts, a single-file SQLite over a bind mount
may be the wrong substrate entirely; a server database (e.g. Postgres) for the
*central* role sidesteps all of this. Large scope, contradicts the single-file
simplicity, probably overkill for small setups — but the planner should at least
rule it in or out for the large-fleet case.

## 7. Invariants any solution must preserve

- **Recoverability/inspectability** of the data, or an equivalent (export/import).
  The current "the DB is just a host file you can back up, copy, and `sqlite3`"
  property is load-bearing for support and for `migrateLegacyData`.
- **No remote data through `EventStore`** (re-record/eviction hazard; see CLAUDE.md).
- **The journal is written by SQLite triggers**, and origin ownership via
  `host_id` / `trustRowOrigin` (see CLAUDE.md "Multi-host sync").
- **Do not naively enable WAL over a FUSE bind mount** — that is the documented
  corruption path, not a fix.

## 8. Open questions the future planning must answer first

1. **Which mechanism dominates — A or B?** Run the decisive experiment: a
   single-process bulk import (≥1M rows) onto the receiving DB over the *actual*
   deployment substrate, with **no** other process touching the file. If it still
   corrupts → mechanism B is real and storage placement (Option 1) is mandatory.
   If it never corrupts → single-owner discipline (Option 2) may suffice. This
   experiment gates the whole design.
2. Is keeping the DB a host-inspectable file a hard requirement, or is a
   first-class export/import path an acceptable trade for a named volume?
3. Is `central` expected to scale to large fleets (→ weigh Option 4)?
4. Interim: should bulk transfer (mirror bootstrap, large first backfill) be
   **gated/refused** on a detected container/FUSE mount until the real fix lands,
   rather than shipped with only probabilistic mitigations?

## 9. Acceptance criteria for a *complete* fix

- A single-process bulk import of **≥1M events** onto the receiving DB, over the
  real deployment substrate, completes with `integrity_check ok`, **repeatably**.
- It survives a **mid-import process kill + restart** without corruption
  (resume-safe, which the cursor logic already targets — verify under the fix).
- Identical guarantee for **both** receive paths: mirror-pull (large central →
  mirror) and push-backfill (large remote → central).
- Backup/restore is preserved, or replaced by an equivalent documented path.

## 10. Where the code is

- Apply path (both directions): `packages/server/src/sync/applier.ts`
  (`apply()`, `ApplierOptions.deferStats`).
- Pull/snapshot: `packages/server/src/sync/puller.ts` (`runSnapshot`, pacing,
  end-of-snapshot `recomputeHostStats`).
- Push receive: `packages/server/src/sync/routes.ts` (`/api/sync/push`,
  `deferStats: true`) + throttled recompute in `packages/server/src/server.ts`
  (`scheduleHostStats`).
- Stats scans: `packages/server/src/sync/stats.ts` (`computeHostStats`).
- Journal-mode rationale + prior incident: `packages/server/src/db/database.ts`.
- Storage location + restore model: `packages/server/src/config/paths.ts`
  (`laymanDbPath`, `migrateLegacyData`), `docker-compose.yml` (the bind mount).

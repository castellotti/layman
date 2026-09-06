# Multi-host sync: central store and remote instances

**Status:** planned, not started · **Written:** 2026-09-04 · **Target:** Layman 0.9

This document is a complete, self-contained implementation plan. It is written to be executed
by a Claude Code instance working in this repository with no other context. Read it top to
bottom once before starting Phase 0; every later section assumes the vocabulary of §2 and §3.

---

## 1. Goal and decisions

### 1.1 What we are building

Today one Layman instance runs next to the harnesses on one machine and records everything
into its own SQLite database. We want:

1. A **central** instance that acts as the data store and monitor for many machines.
2. **Remote** instances on each machine that keep recording locally, exactly as today, and
   **push** their data to the central instance whenever it is reachable. Interruptions must be
   recovered without loss or duplication.
3. Clear **host attribution** in the UI: which machine a session came from, when browsing or
   searching sessions and prompts, and on the live dashboard.
4. An optional **mirror** mode so a remote can **pull** the central's full history (every other
   host's data) and search it offline.
5. Settings controls for all of the above, with **per-host statistics** (sessions, events, size,
   last sync).

### 1.2 Decisions already made (do not re-open)

| Question | Decision |
|---|---|
| Network | Private network (LAN / Tailscale / VPN). Sync routes use per-host bearer tokens over plain HTTP. The dashboard itself stays unauthenticated and must not be exposed to the public internet; document this loudly. |
| Live scope on central | **Near-real-time recorded data.** Remotes push every few seconds while a session is active. Central shows remote sessions in Sessions / Prompts / search, and as read-only rows on the Dashboard with an active indicator. No approvals and no live token streams cross hosts. |
| Curation | **Bookmarks, bookmark folders, highlights and highlight folders sync too**, alongside sessions, events, analyses, layman's explanations and Q&A. Conflict rule in §3.6. |
| Auth | **Per-host tokens issued on central.** Central generates a token, the user pastes it into the remote, the token binds to that remote's host id on first use and can be revoked individually. |

### 1.3 Test environment

Two machines, both running the Docker image:

- **Central**: an existing install with many months of session data in `layman.db`.
- **Remote**: a machine that has never run Layman, with a couple of weeks of Claude Code
  transcripts under `~/.claude/projects/` to import.

The manual acceptance script in §11 is written against exactly this setup.

---

## 2. Repository facts the executor needs

Everything here was verified against the code on 2026-09-04. File paths are relative to the
repo root. Read `CLAUDE.md` first; this section only adds what the plan depends on.

### 2.1 Layout and commands

- pnpm monorepo: `packages/server` (Fastify + WebSocket + better-sqlite3, ESM via tsup),
  `packages/web` (React 18 + Vite + Zustand), plus `packages/opencode-plugin` and
  `packages/pi-extension` (not touched by this plan).
- `pnpm -r typecheck`, `pnpm -r test` (vitest), `pnpm build`. Docker:
  `make docker-stop docker-build docker-run` (the Makefile now auto-detects Podman via
  `CONTAINER_ENGINE`). **Server and web changes need a rebuilt image to take effect.**
- Tests: `packages/server/src/**/*.test.ts`. `db/recorder.count.test.ts` uses a real
  `better-sqlite3` `:memory:` database, so native SQLite tests work; `turns/store.test.ts` uses a
  hand-written fake because it predates that. Prefer `:memory:` databases for everything in this
  plan.
- `CHANGELOG.md` has an `## Unreleased` section; entries are prose bullets that explain *why*.
- `docs/planning/` is where this plan lives. `docs/plans/` is git-ignored; do not use it.

### 2.2 Database (`packages/server/src/db/database.ts`)

`journal_mode = DELETE` on purpose (bind-mounted DB; see the long comment there). Migrations are
ad hoc `PRAGMA table_info` checks followed by `ALTER TABLE ADD COLUMN`; there is no schema
version table. Tables:

```
recorded_sessions(session_id PK, cwd, agent_type, started_at, last_seen,
                  session_model, session_model_display_name, session_name, source DEFAULT 'live')
recorded_events(id PK, session_id, type, timestamp, agent_type, data_json,
                analysis_json, laymans_json, risk_level)      -- idx (session_id,timestamp), idx (type)
recorded_qa(id INTEGER PK AUTOINCREMENT, event_id, session_id, question, answer, model,
            tokens_in, tokens_out, latency_ms, created_at)
bookmark_folders(id PK, name, sort_order, created_at)
bookmarks(id PK, folder_id FK→bookmark_folders ON DELETE SET NULL, session_id, name, sort_order, created_at)
highlight_folders(id PK, name, sort_order, created_at)
highlights(id PK, folder_id FK, session_id, prompt_event_id, response_event_id, name, sort_order, created_at)
```

Note: `CLAUDE.md` mentions FTS5, but `db/search.ts` actually uses `LIKE` over JSON columns.
There is no FTS table. Do not add one in this plan.

Ids: live events get `randomUUID()` (`events/store.ts`), imported events get deterministic ids
derived from the transcript (`hooks/recovery.ts`). Session ids come from the harness (UUIDs for
Claude Code and pi; `chat_id` for Open WebUI). Bookmarks, folders, highlights use `randomUUID()`.
**`recorded_qa.id` is a local autoincrement integer and is not globally unique.**

### 2.3 Every write site that touches recorded data

The sync journal must observe all of these. The plan uses SQLite triggers (§3.4) precisely so
that none of them needs editing to be captured; the list is here so the executor can verify
coverage in tests.

| Site | Writes |
|---|---|
| `db/recorder.ts` `SessionRecorder.attach()` | `INSERT recorded_sessions` (upsert last_seen), `INSERT OR IGNORE recorded_events`, `UPDATE recorded_events` (analysis/laymans/type/data), `UPDATE recorded_sessions` (model, name, cwd) |
| `db/recorder.ts` `saveEventsFromMemory()`, `importSession()` | batched session upsert + event inserts in one transaction |
| `db/recorder.ts` `recordQA()` | `INSERT recorded_qa` |
| `db/bookmarks.ts` | folder create/rename/delete/reorder, bookmark create/rename/move/delete/reorder, `deleteSession()` (deletes qa + events + session) |
| `db/highlights.ts` | folder + highlight CRUD and reorder |
| `server.ts` import route (`POST /api/bookmarks/sessions/import`) | `saveEventsFromMemory` + raw `UPDATE recorded_sessions SET last_seen` |
| `server.ts` save-current route | raw `UPDATE recorded_sessions SET cwd, agent_type, last_seen` |
| `pii/purge.ts` `executePurge()` | raw `UPDATE` of `cwd`, `data_json`, `analysis_json`, `laymans_json`, qa, bookmark/folder names |
| `hooks/recovery.ts` `importHistoricalSessions()` | via `recorder.importSession()` and `eventStore.addRaw()` → recorder |

### 2.4 Read paths that must learn about hosts

- `db/bookmarks.ts` `listRecordedSessions()` → `GET /api/bookmarks/sessions` (polled every 15 s
  by `SessionsView.tsx`); `getRecordedSession()`; `getEventsForSession()`.
- `db/search.ts` `searchEvents()` → `POST /api/search` and `GET /api/bookmarks/search?q=`
  (sidebar match counts). Session summaries already `LEFT JOIN recorded_sessions`.
- `turns/store.ts` `resolveId()` → `GET /api/resolve` (used by deep links `/s/`, `/h/`, `/b/`).
- `routes/turns.ts` export/markdown; `export/urls.ts` `resolveInstanceUrl()`.
- `server.ts` `buildSessionsList()` → WebSocket `sessions:list` (live sessions from
  `EventStore.getSessions()` + gate active flag). Sent on connect and on `sessions:changed`.
- `server.ts` `mergeRecordedCounts()` / `countRecordedSessionsByAgentType()` for Settings →
  Harness "N recorded sessions kept".

### 2.5 Client state and UI

- `packages/web/src/stores/sessionStore.ts`: Zustand store. `sessions: SessionInfo[]` (live, from
  WS), `events` (live ring, deduped by id in `addEvent`), `historicalEvents` (fetched per viewed
  session), `config`, bookmarks/highlights state, route hydration.
- `packages/web/src/lib/types.ts` and `ws-protocol.ts` mirror server types by hand (see
  `CLAUDE.md` "Type duplication"). `LaymanConfig` in `types.ts` must be updated in lock-step with
  `config/schema.ts`; the server `handler.test.ts` `MOCK_CONFIG` literal must also gain new keys.
- Views: `components/sessions/SessionsView.tsx` (sidebar folders + History list,
  `SidebarSessionRow` shows date · model · event count), `components/sessions/PromptsView.tsx`
  (highlights; `sessionLabelById` is built from **live** sessions only, so recorded-only sessions
  currently have no label), `components/dashboard/DashboardView.tsx` + `SessionListRow.tsx`
  (live sessions, `deriveSessionState(events, active)`), `components/layout/Header.tsx`
  (session picker with `[CC]`/`[PI]` agent prefixes).
- Settings: `components/controls/SettingsDrawer.tsx` has a `SECTIONS` array grouped into
  Connection / Automation / Data / Stream / Extensions. Sections are small components in
  `components/controls/settings/`, built from `primitives.tsx` (`SectionTitle`, `SectionIntro`,
  `ToggleRow`, `FieldRow`, `InfoRow`, `ActionRow`, `SegmentRow`, `CustomRow`). `GloveSection.tsx`
  is the model for a section that edits a nested config object; `HarnessSection.tsx` shows the
  pill-button and StatusPip patterns for per-row actions.
- glove already sets a precedent for "sessions from somewhere else": the passive watchers pass a
  sandbox `label` into `trackSession()` and it surfaces as the session name. Host attribution is
  a first-class column instead (§3.3), not a name prefix.

### 2.6 Config (`packages/server/src/config/schema.ts`, `config/config.ts`)

Zod schema; runtime values persisted to `~/.local/share/layman/layman.json` (`saveConfig`), except
`EPHEMERAL_KEYS` (`port`, `host`, `open`, `hookUrl`). `updateConfig()` only deep-merges
`analysis` and `autoAllow`; nested objects like `glove` are replaced whole, so the client sends the
full nested object (see `GloveSection.tsx`). New nested config in this plan follows the same
pattern. `LAYMAN_API_KEY` exists in compose but is only a fallback API key for the analysis
provider; it is **not** server auth. There is no authentication anywhere today.

### 2.7 Docker

`docker-compose.yml` / `docker-compose.ghcr.yml` bind `127.0.0.1:8880:8880` and mount
`${HOME}/.local/share/layman` (DB + config) plus the harness config dirs. Inside the container
`os.hostname()` returns the **container id**, not the machine name. `HOST_HOME` is already passed
in for the same class of problem.

### 2.8 Things that are easy to get wrong here

- `EventStore.add()/addRaw()` triggers the PII filter, the SQLite recorder, the WebSocket
  broadcast, and the 10,000-entry ring eviction. Remote data must **not** be fed through it
  (§3.8): it would re-record already-recorded rows, and a historical backfill of 50k events would
  evict every live event. The drift monitor is driven from the hook handler, not from
  `EventStore`, so it is unaffected either way.
- `SessionRecorder` only writes when `sessionRecording` is on. Sync reads from SQLite, so **both
  roles require session recording to be enabled**; the Settings section must say so and refuse
  to enable sync without it.
- Fastify `bodyLimit` is 10 MB. Individual `PostToolUse` events can be hundreds of KB. Batches
  are sized by bytes, not by count.
- PII redaction happens at `EventStore` time on the origin host, so synced payloads are already
  redacted by the origin's settings. Central additionally runs `filterPii` on ingest when its own
  `piiFilter` is on (cheap, defence in depth).

---

## 3. Design

### 3.1 Topology and roles

```
   remote A ──push──▶ ┌─────────┐ ◀──push── remote B
   (pull ◀────────────│ central │────────▶ pull, optional "mirror")
                      └─────────┘
```

`sync.role` is one of:

- `standalone` (default): today's behaviour, nothing new runs.
- `central`: accepts pushes from enrolled remotes, serves pull, issues tokens.
- `remote`: pushes its own-origin data to `sync.centralUrl`; optionally mirrors (pulls) everything
  else.

A host is never both in v1. Chaining (a remote that is also a central for others) is out of
scope, but nothing in the protocol forbids it later because every row carries its origin (§3.3).

### 3.2 Host identity

- `hostId`: a UUID generated once and persisted in `layman.json` (`sync.hostId`). Also written to
  the `sync_state` table (§4) so SQLite triggers can read it.
- `hostName`: `sync.hostName` if set; else `LAYMAN_HOST_NAME` env (compose passes
  `${LAYMAN_HOST_NAME:-}` and `make docker-run` sets it to `$(hostname)`); else, when running in a
  container (`/.dockerenv` or `/run/.containerenv` exists), `layman-<first 8 of hostId>` with a
  Settings nag to name it; else `os.hostname()`.
- Every instance, including standalone, has an identity from Phase 0 onward. That is what makes
  later enrolment painless: rows are stamped with the local host id from day one.

### 3.3 Origin attribution in the schema

Add `host_id TEXT` to `recorded_sessions`, `bookmark_folders`, `bookmarks`, `highlight_folders`,
`highlights`. **Not** to `recorded_events` or `recorded_qa`: they belong to a session and inherit
its host through a join, and a months-old central database should not have every event row
rewritten by a migration. Add `sync_id TEXT` to `recorded_qa` (a UUID) because its integer id is
not portable.

A new `sync_hosts` table records every host id ever seen with its name, kind, platform, version,
first/last seen and running counters (§4.1). The local host is a row in it too.

### 3.4 The journal: SQLite triggers, not application code

Every recorded-data write must produce a journal entry, and §2.3 shows how scattered those writes
are (including raw `UPDATE`s in `server.ts` and `pii/purge.ts`). Rather than instrumenting each
site and inevitably missing the next one, the journal is written by `AFTER INSERT/UPDATE/DELETE`
triggers into `sync_log`:

```
sync_log(seq INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT, entity_id TEXT, origin_host_id TEXT, op TEXT ('upsert'|'delete'),
         session_id TEXT, created_at INTEGER)
```

- Triggers run inside the writer's transaction, so a journal entry exists if and only if the
  write committed. Interrupted transactions leave nothing behind.
- Origin: for tables with a `host_id` column, `NEW.host_id` (or `OLD.host_id` on delete); for
  events and qa, `(SELECT host_id FROM recorded_sessions WHERE session_id = NEW.session_id)`,
  falling back to the local id from `sync_state`.
- A separate `AFTER INSERT ... WHEN NEW.host_id IS NULL` trigger on each `host_id` table
  back-fills the local host id, so no existing insert site needs to set it.
- No trigger on `recorded_events` DELETE. The only event deletion path is `deleteSession()`,
  which is journaled as a single `session` delete that receivers apply as a cascade. Do not add
  a per-event delete trigger: deleting a 5,000-event session would journal 5,000 rows.
- Because the applier (§3.7) writes through the same tables, remote data applied on central is
  journaled automatically **with its true origin**, which is exactly what mirror pull needs.

The push side sends an entity's **current state** for each `upsert` entry, not a diff, so
duplicate entries for the same entity are harmless and can be compacted (§3.10).

### 3.5 Entity registry

`packages/server/src/sync/entities.ts` defines one `SyncEntity` per kind, in apply order:

```
session → event → qa → bookmark_folder → bookmark → highlight_folder → highlight
```

Each entry provides: `table`, `idColumn`, `originColumnOrJoin`, `load(ids)` (current rows as
wire objects), `page(cursor, limit, originFilter)` for backfill and snapshot, `upsert(row)`,
`remove(id)` (cascade for `session`), and `approxBytes(row)`. Adding a kind later (for
example `qa_folder`, or the dismissed-drift-items table if it is ever persisted) means adding
one registry entry and one trigger; nothing in the transport changes. Wire rows pass
`data_json` / `analysis_json` / `laymans_json` through as strings without parsing.

### 3.6 Ownership and conflict rules

- **Sessions, events, Q&A**: only the origin host produces them. Central and mirrors never edit
  them except through PII purge (§3.9). Rows are upserted whole; a newer entry for the same id
  replaces the older one.
- **Curation** (folders, bookmarks, highlights): rows are **owned by the host that created
  them**, recorded in `host_id`. Ownership decides who may edit: a curation row is editable only
  on its origin host and rendered read-only elsewhere (no rename, move, reorder or delete
  affordances; the row shows a host chip). Anyone may create *new* curation on any host that
  references *any* session, including a remote one, so the central user can file remote
  sessions into central folders. Two hosts therefore never write the same row, and there is
  nothing to merge. A later phase may relax this to last-writer-wins; the `updated_at` column
  added in Phase 0 exists for that.
- A bookmark or highlight that arrives before the session or events it references is stored
  anyway (there are no foreign keys to those tables) and becomes visible when they arrive.
  `SessionsView` already drops bookmarks whose session is unknown, so nothing renders broken.
- **Session-id collisions** across hosts are not expected (harness UUIDs) but are guarded: if an
  incoming session's `host_id` differs from the stored row's `host_id`, the entry is rejected
  with a `conflict` count reported back to the pusher and surfaced in the hosts table. Nothing
  is overwritten.

### 3.7 Push protocol (remote → central)

All sync routes live under `/api/sync/` and require `Authorization: Bearer <token>` except the
local-only management routes marked *local* in §6. Requests and responses are JSON.

**Enrolment.** On central, Settings → Sync → *Add remote host* creates a `sync_peers` row with a
name and a token: `lmk_` + 32 random bytes base64url. Only its SHA-256 is stored; the plaintext
is shown once. The remote stores the token in `sync.token` and calls `POST /api/sync/hello` with
`{ hostId, hostName, platform, laymanVersion, protocolVersion }`. Central binds the token to that
`hostId` on first use (trust on first use) and rejects any later hello presenting the same token
with a different host id. `hello` returns `{ centralHostId, centralHostName, protocolVersion,
lastAckedSeq, headSeq }` so a remote can resume without a separate call.

**Backfill, then incremental.** The remote keeps `sync_state.push_acked_seq` and
`sync_state.push_backfill_cursor`.

- If `push_acked_seq` is null the remote is in **backfill**: it records the current
  `MAX(seq)` of `sync_log` as `push_backfill_head`, then pages through every registry kind in
  order, own-origin rows only, posting batches of `upsert` entries without seq numbers. The
  cursor `{ kind, lastId }` is persisted after each acknowledged batch, so an interrupted backfill
  resumes at the next page. When all kinds are exhausted, `push_acked_seq = push_backfill_head`
  and the cursor is cleared. Anything journaled during backfill has a higher seq and is replayed
  incrementally, which is safe because every apply is an idempotent upsert.
- **Incremental**: read `sync_log WHERE seq > push_acked_seq AND origin_host_id = <self>`
  ordered by seq, dedupe by `(kind, entity_id)` keeping the highest seq, load current entity
  state, and post. Central replies `{ ackSeq }`. The remote advances `push_acked_seq` only on a
  2xx with an `ackSeq`. A batch is applied atomically on central, so a failed request leaves
  the cursor untouched and the same entries are simply re-sent.
- A `delete` entry whose row is already gone is sent as `{ op: 'delete', kind, id }`; an
  `upsert` entry whose row no longer exists (deleted after being journaled) is skipped.

**Batching.** Up to 500 entries or ~1.5 MB of serialized rows, whichever first, well under
Fastify's 10 MB limit. Batches are gzip-compressed by the client (`Content-Encoding: gzip`)
and decompressed on the server with `@fastify/compress` configured for request decompression
(`requestEncodings: ['gzip']`, scoped to the sync routes).

**Cadence.** A `SyncPusher` loop runs when `role === 'remote'`: wake on new journal entries
(1 s debounce), or on a timer (`sync.intervalSeconds`, default 5) while there are unsent entries
or active sessions, otherwise every 60 s to refresh presence. On failure: exponential backoff
from 2 s to 60 s with jitter, status reported over WebSocket (§7). Central rejections that mean
"stop and tell the user" (401 revoked, 409 host id mismatch, 426 protocol version) pause the loop
and surface an error rather than retrying.

**Presence.** Every push (including an empty one) carries
`live: { activeSessionIds, sessions: [{ sessionId, cwd, agentType, sessionName, lastSeen }] }`
from the remote's `SessionGate` and `EventStore.getSessions()`. Central keeps this in an
in-memory `RemoteSessionRegistry` with a TTL of 3 × the remote's interval (§3.8).

### 3.8 What central does with a batch

`SyncApplier.apply(peer, batch)` in one transaction, entries in registry order regardless of
arrival order:

1. Validate shape, reject unknown kinds and entries whose origin is not the authenticated peer's
   host id (a peer may only push its own data).
2. For `session`: collision check (§3.6), then upsert including `host_id`. Bump
   `sync_hosts.last_seen`.
3. For `event`: `INSERT ... ON CONFLICT(id) DO UPDATE` all mutable columns. When central's
   `piiFilter` is on, run `filterPii` over parsed `data_json` and `redactString` over
   `laymans_json` first.
4. For `qa`: insert on `sync_id` unique index, ignore duplicates.
5. Curation: upsert whole rows including `host_id` and `folder_id`.
6. `delete`: registry `remove()`; for `session` this cascades to qa, events, and central-side
   curation rows pointing at it is **not** deleted (they belong to whoever made them).
7. Update `sync_peers.last_push_seq`, `sync_hosts` counters, return `{ ackSeq, applied,
   conflicts }`.

**Live tail.** After commit, for each applied event whose timestamp is within the last 10 minutes
and whose session is in the pusher's `activeSessionIds`, the applier appends it to the registry's
per-session ring (last 50) and broadcasts `event:new` to WebSocket clients. Remote events never
enter `EventStore`. `buildSessionsList()` merges `RemoteSessionRegistry.list()` into the
`sessions:list` frame with `hostId`, `hostName`, `remote: true`, `active`. On WebSocket connect
the server also replays each remote active session's ring after the local 100-event replay. This
is what makes the Dashboard show a remote session as running, with its last few events, at no
cost to the local pipeline.

### 3.9 Deletions and PII purge

- A delete on the **origin** host journals normally and propagates outward: to central by push,
  and from central to mirrors by pull.
- A delete on a **non-origin** host (central deleting a remote session, or a mirror deleting
  something it pulled) is local. It still journals, so *other* mirrors follow it, but the origin
  never sees it because pull excludes own-origin entries (§3.10). To stop the origin's next update
  from resurrecting the row, the deleting host writes `sync_suppressions(kind, entity_id)` and the
  applier ignores upserts for suppressed ids. Settings → Sync → *Danger zone* has "Forget
  suppressions". This is deliberately simple; revisit if it proves confusing.
- **PII purge** on any host rewrites rows in place; the triggers journal each rewritten row with
  its true origin. From central, redacted copies flow to mirrors by pull. From a remote, they flow
  to central by push (own-origin rows only; purge of mirrored rows on a remote stays local).
  `executePurge()` should therefore not be special-cased, but it must run inside a transaction
  (verify; wrap if not) so a purge is journaled atomically.

### 3.10 Pull protocol (central → mirror)

Symmetric to push, initiated by the remote when `sync.mirror` is on:

- **Bootstrap**: `GET /api/sync/snapshot?kind=&cursor=&limit=` pages every kind in registry order
  with `WHERE host_id != <requester>` (events and qa via session join). The remote persists
  `pull_snapshot_cursor` and `pull_snapshot_head` (central's `headSeq` at bootstrap start,
  returned by `hello`), applies pages through the same `SyncApplier` (host-collision and
  suppression rules apply), and on completion sets `pull_acked_seq = pull_snapshot_head`.
- **Incremental**: `GET /api/sync/changes?since=<pull_acked_seq>&limit=` returns
  `sync_log` entries with `seq > since AND origin_host_id != <requester>` plus current entity
  state (deduped per entity), and `headSeq`. If `since` is older than central's oldest retained
  seq the response is `{ resync: true }` and the remote restarts bootstrap (idempotent, only
  bandwidth).
- Pull cadence: `sync.mirrorIntervalSeconds`, default 60; immediately after a successful push
  when something changed on central since the last pull (central includes `headSeq` in the push
  response, so the remote knows).

**Compaction and retention** (both roles): a maintenance tick every 10 minutes deletes from
`sync_log` (a) older duplicates for the same `(kind, entity_id)` when a newer entry exists, and
(b) on a remote, every own-origin entry with `seq <= push_acked_seq`; on central, entries older
than `sync.logRetentionDays` (default 30). A puller further behind than retention is told to
resync. Compaction never touches the entity tables.

### 3.11 Statistics

`sync_hosts` carries `session_count`, `event_count`, `content_bytes`
(`length(data_json)+length(analysis_json)+length(laymans_json)`), `first_activity`,
`last_activity`, maintained incrementally by the applier and the recorder (a small
`SyncStats.bump(hostId, delta)` helper; the recorder calls it on insert and the applier per
batch). `POST /api/sync/hosts/recompute` rebuilds them from the tables (local only). Bytes are
content bytes, not on-disk pages; the UI labels them "content".

### 3.12 Versioning and compatibility

- `SYNC_PROTOCOL_VERSION = 1` in `sync/protocol.ts`, sent in `hello` and checked on both sides.
  A mismatch returns 426 with both versions in the body; the remote shows it in Settings.
- Layman versions may differ between hosts. Unknown event `type` values or `EventData` keys from
  a newer remote are stored as-is (JSON passthrough) and rendered by the client's existing
  fallback paths. Do not validate event payload shape on ingest beyond the row envelope.
- `schema_migrations(version INTEGER PRIMARY KEY, applied_at)` is introduced in Phase 0 and the
  existing ad hoc migrations are wrapped as version 1 so future migrations have a home.

---

## 4. Schema changes (Phase 0)

Add to `applyMigrations()` in `db/database.ts`, as migration 2, idempotent (use `IF NOT EXISTS`
and `PRAGMA table_info` guards exactly as the existing code does):

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);
-- keys: hostId, push_acked_seq, push_backfill_head, push_backfill_cursor,
--       pull_acked_seq, pull_snapshot_head, pull_snapshot_cursor

CREATE TABLE IF NOT EXISTS sync_hosts (
  host_id        TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- 'local' | 'remote' | 'central'
  platform       TEXT, layman_version TEXT,
  first_seen     INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  session_count  INTEGER NOT NULL DEFAULT 0,
  event_count    INTEGER NOT NULL DEFAULT 0,
  content_bytes  INTEGER NOT NULL DEFAULT 0,
  first_activity INTEGER, last_activity INTEGER
);

CREATE TABLE IF NOT EXISTS sync_peers (        -- central only, one row per issued token
  token_hash     TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  host_id        TEXT,                         -- NULL until first hello (TOFU)
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER, last_push_seq INTEGER, last_pull_seq INTEGER,
  interval_seconds INTEGER,                    -- reported by the remote, drives presence TTL
  revoked_at     INTEGER,
  last_error     TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  origin_host_id TEXT NOT NULL,
  op             TEXT NOT NULL,                -- 'upsert' | 'delete'
  session_id     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_log_origin ON sync_log(origin_host_id, seq);
CREATE INDEX IF NOT EXISTS idx_sync_log_entity ON sync_log(kind, entity_id);

CREATE TABLE IF NOT EXISTS sync_suppressions (kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (kind, entity_id));

ALTER TABLE recorded_sessions ADD COLUMN host_id TEXT;          -- + updated_at INTEGER
ALTER TABLE bookmark_folders  ADD COLUMN host_id TEXT;          -- + updated_at
ALTER TABLE bookmarks         ADD COLUMN host_id TEXT;          -- + updated_at
ALTER TABLE highlight_folders ADD COLUMN host_id TEXT;          -- + updated_at
ALTER TABLE highlights        ADD COLUMN host_id TEXT;          -- + updated_at
ALTER TABLE recorded_qa       ADD COLUMN sync_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_recorded_qa_sync_id ON recorded_qa(sync_id);
CREATE INDEX IF NOT EXISTS idx_recorded_sessions_host ON recorded_sessions(host_id);
```

Backfill in the same migration, after `sync_state.hostId` has been written by
`ensureHostIdentity()` (§5): `UPDATE <each host_id table> SET host_id = :local WHERE host_id IS
NULL`; `UPDATE recorded_qa SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL`;
`updated_at` defaults to `last_seen` / `created_at`. Insert the local row into `sync_hosts` and
compute its counters once.

Triggers (all `IF NOT EXISTS`), with the pattern shown for sessions and events; replicate for the
curation tables and qa:

```sql
CREATE TRIGGER IF NOT EXISTS trg_sessions_host_default AFTER INSERT ON recorded_sessions
WHEN NEW.host_id IS NULL BEGIN
  UPDATE recorded_sessions SET host_id = (SELECT value FROM sync_state WHERE key = 'hostId')
  WHERE session_id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_log_ins AFTER INSERT ON recorded_sessions BEGIN
  INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
  VALUES ('session', NEW.session_id,
          COALESCE(NEW.host_id, (SELECT value FROM sync_state WHERE key = 'hostId')),
          'upsert', NEW.session_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
-- trg_sessions_log_upd: AFTER UPDATE, same body using NEW; skip when only host_id changed
--   (WHEN NEW.host_id IS NOT OLD.host_id AND <no other column changed> is awkward in SQLite;
--    instead order the default-host trigger to fire first and accept one extra log row).
-- trg_sessions_log_del: AFTER DELETE, op 'delete', origin OLD.host_id.

CREATE TRIGGER IF NOT EXISTS trg_events_log_ins AFTER INSERT ON recorded_events BEGIN
  INSERT INTO sync_log(kind, entity_id, origin_host_id, op, session_id, created_at)
  VALUES ('event', NEW.id,
          COALESCE((SELECT host_id FROM recorded_sessions WHERE session_id = NEW.session_id),
                   (SELECT value FROM sync_state WHERE key = 'hostId')),
          'upsert', NEW.session_id, CAST(strftime('%s','now') AS INTEGER) * 1000);
END;
-- trg_events_log_upd: AFTER UPDATE OF type, data_json, analysis_json, laymans_json, risk_level
-- (no DELETE trigger on recorded_events: see §3.4)
```

Migration test (`db/database.test.ts`, new): open `:memory:`, run the **old** DDL verbatim (copy
the pre-plan `CREATE TABLE` block into the test), insert a few rows including two `recorded_qa`
rows, run `applyMigrations()`, assert columns, backfilled `host_id`, distinct `sync_id`s, trigger
presence (`sqlite_master`), and that a fresh database and an upgraded one end with identical
`sqlite_master` entries modulo order.

---

## 5. Config

`config/schema.ts`:

```ts
export const SyncConfigSchema = z.object({
  role: z.enum(['standalone', 'central', 'remote']).default('standalone'),
  hostId: z.string().default(''),          // filled by ensureHostIdentity(); never edited by UI
  hostName: z.string().default(''),
  centralUrl: z.string().default(''),      // remote only
  token: z.string().default(''),           // remote only; plaintext, same trust level as apiKey
  intervalSeconds: z.number().int().min(2).max(300).default(5),
  mirror: z.boolean().default(false),      // remote only: pull everything else from central
  mirrorIntervalSeconds: z.number().int().min(15).max(3600).default(60),
  logRetentionDays: z.number().int().min(1).max(365).default(30),
});
// in LaymanConfigSchema: sync: SyncConfigSchema.default({}),
```

`config/config.ts`: add `sync` to the deep-merge in `loadConfig()` and `updateConfig()`
(currently only `analysis` and `autoAllow` are deep-merged; the client will still send the whole
object, but deep-merging protects `hostId` from being blanked by a partial update). Add
`ensureHostIdentity(config, db)` in `sync/identity.ts`: generate `hostId` if empty, resolve
`hostName` per §3.2, `saveConfig`, write `sync_state.hostId`, upsert the local `sync_hosts` row.
Call it from `server.ts` right after `openDatabase()` and before `applyMigrations()` needs it;
simplest is to open the DB, ensure identity, then run migration 2 (split `openDatabase()` so
migrations can be run after identity is known, or have migration 2 read the id from a parameter).

Mirror in `packages/web/src/lib/types.ts` (`LaymanConfig.sync: SyncConfig`) and add `sync` to
`MOCK_CONFIG` in `hooks/handler.test.ts`.

---

## 6. Server modules and routes

New directory `packages/server/src/sync/`:

| File | Responsibility |
|---|---|
| `protocol.ts` | `SYNC_PROTOCOL_VERSION`, wire types: `HelloRequest/Response`, `PushBatch`, `PushEntry`, `PushResponse`, `SnapshotPage`, `ChangesResponse`, `HostStats`, `PeerDTO`, `SyncStatus`. These are the only types the web mirrors. |
| `identity.ts` | `ensureHostIdentity()`, `detectContainer()`, `defaultHostName()`. |
| `entities.ts` | The registry (§3.5). Pure SQL over a `Database`; no Fastify. |
| `journal.ts` | `SyncJournal`: read unsent entries (`readSince(originHostId, afterSeq, limit)`), dedupe, `headSeq()`, `compact()`, `suppress()/isSuppressed()`. |
| `state.ts` | Typed get/set over `sync_state`. |
| `tokens.ts` | `generateToken()`, `hashToken()`, `PeerStore` over `sync_peers` (create, bind host on first hello, revoke, list, touch). |
| `applier.ts` | `SyncApplier.apply(originHostId, entries, opts)` (§3.8), returns `{ applied, conflicts, ackSeq? }`; emits `applied:events` for the live tail. |
| `pusher.ts` | `SyncPusher` (remote role): backfill + incremental loop, presence payload, backoff, status events. Transport injected (`fetch`-shaped) for tests. |
| `puller.ts` | `SyncPuller` (remote role, mirror on): snapshot + changes loop. |
| `presence.ts` | `RemoteSessionRegistry`: per-host live sessions with TTL, per-session event ring (50), `list()` for `buildSessionsList()`, `replayFor(ws)`. |
| `stats.ts` | `SyncStats.bump()`, `recompute()`, `hostsWithStats()`. |
| `routes.ts` | `registerSyncRoutes(fastify, deps)`, registered from `server.ts` with one call like `registerTurnRoutes`. Contains the bearer-token preHandler. |

Routes (`local` = no token, intended for the dashboard on the same machine, same trust model as
every other `/api/*` route today):

```
POST /api/sync/hello                     token   §3.7
POST /api/sync/push                      token   body: PushBatch (gzip ok) → PushResponse
GET  /api/sync/snapshot?kind&cursor&limit token  §3.10
GET  /api/sync/changes?since&limit       token   §3.10

GET  /api/sync/status                    local   SyncStatus: role, hostId, hostName, push/pull cursors,
                                                 backlog (headSeq - acked), lastSuccessAt, lastError, state
POST /api/sync/test                      local   remote: dry-run hello against centralUrl+token
POST /api/sync/now                       local   remote: wake pusher (and puller if mirror)
POST /api/sync/reset-push                local   remote: clear push cursors → full backfill next tick
POST /api/sync/reset-pull                local   remote: clear pull cursors → snapshot next tick
GET  /api/sync/hosts                     local   HostStats[] (local + every known host)
POST /api/sync/hosts/recompute           local   rebuild counters
PATCH /api/sync/hosts/:hostId            local   { name } — central may rename how a remote is shown
GET  /api/sync/peers                     local   central: PeerDTO[] (never includes tokens)
POST /api/sync/peers                     local   central: { name } → { token, peer } (token shown once)
POST /api/sync/peers/:tokenHash/revoke   local   central
DELETE /api/sync/peers/:tokenHash        local   central: forget peer row; data stays
DELETE /api/sync/suppressions            local   "Forget suppressions"
```

Existing routes to extend:

- `GET /api/bookmarks/sessions`: `RecordedSession` gains `hostId`, `hostName` (join
  `sync_hosts`). Accept `?host=<hostId|local>` filter.
- `POST /api/search` (`SearchRequest.hostIds?: string[]`) and `GET /api/bookmarks/search?q=&host=`:
  filter events by `session_id IN (SELECT session_id FROM recorded_sessions WHERE host_id IN (...))`;
  `SearchSessionSummary` gains `hostId`, `hostName`.
- `GET /api/resolve`: `ResolvedId` gains `hostId` for sessions/bookmarks/highlights (join).
- `GET /api/bookmarks`, `/api/highlights` and their `:state` WebSocket frames: rows gain `hostId`.
  Mutating routes (`PATCH`/`DELETE`/reorder on bookmarks, folders, highlights) return 403 when
  the row's `host_id` is not the local host (§3.6).
- `DELETE /api/bookmarks/sessions/:sessionId`: when the session's `host_id` is not local, also
  write a suppression (§3.9).
- `GET /api/setup/status`: unchanged; recorded counts remain per agent type (all hosts).

`server.ts` wiring: construct `SyncJournal`, `SyncApplier`, `RemoteSessionRegistry`, `SyncStats`;
construct `SyncPusher`/`SyncPuller` and start/stop them based on `config.sync.role` and
`config.sync.mirror`, re-evaluated on every `config:update` (start, stop, or reconfigure in place,
mirroring how `analysisEngine.configure()` is called). `buildSessionsList()` merges the registry.
The WebSocket connect handler replays remote rings after local events. Register
`@fastify/compress` with request decompression on the sync plugin scope only.

---

## 7. WebSocket protocol additions

Server `types/index.ts` and web `ws-protocol.ts`, kept in sync by hand as today:

```ts
| { type: 'sync:status'; status: SyncStatus }          // pusher/puller state changes, throttled to 1/s
| { type: 'sync:hosts'; hosts: HostStats[] }           // after each applied batch (throttled 5 s) and on connect
```

`SessionInfo` gains `hostId?: string; hostName?: string; remote?: boolean`. `event:new` is reused
for remote live-tail events; `TimelineEvent` is unchanged (host is looked up via the session).

---

## 8. Client changes

### 8.1 Types and store

- `lib/types.ts`: `SyncConfig`, `SyncStatus`, `HostStats`, `PeerDTO`; `RecordedSession`,
  `Bookmark`, `BookmarkFolder`, `Highlight`, `HighlightFolder`, `ResolvedId` gain `hostId`
  (+ `hostName` on sessions and search summaries).
- `sessionStore.ts`: `syncStatus: SyncStatus | null`, `syncHosts: HostStats[]`,
  `localHostId` (from `config.sync.hostId`), setters wired in `useWebSocket.ts`. A selector
  `hostLabel(hostId)` returns `''` for local and the host name otherwise. `setSessions()` keeps
  working unchanged; remote rows simply carry `remote: true`.

### 8.2 Host attribution

- New `components/shared/HostChip.tsx`: a small mono-font pill (`var(--bg-card)` background,
  `var(--border)` edge, `var(--text-muted)` text) showing the host name, with a title tooltip
  "Recorded on <name>". Renders nothing for the local host, so single-machine installs look
  exactly as they do today. Deterministic accent per host: hash the host id to one of the six
  existing semantic colours (`--info`, `--agent`, `--warn`, `--ok`, `--accent`, `--error`) used as
  a 2 px left border on the chip, so the same host is recognisable across views.
- `SessionsView.tsx`: `SidebarSessionRow` shows `HostChip` after the date line; the transcript
  header shows "on <host>" beside the model; a **host filter** (`SegmentedControl` when ≤ 3 hosts,
  `<select>` otherwise) sits under All/Bookmarked, sending `?host=` to the sessions list and
  `/api/bookmarks/search`. Remote-owned folders and bookmarks render with the chip and without
  rename/delete/drag affordances. `handleQuickBookmark` works for any session.
- `PromptsView.tsx`: build `sessionLabelById` from `/api/bookmarks/sessions` as well as live
  sessions (fixes an existing gap), render `HostChip` on highlight rows and remote folder
  headers, read-only affordances as above.
- `DashboardView.tsx` / `SessionListRow.tsx`: remote rows show the chip between the status dot and
  the name; `PreviewPane` hides Investigate/approval actions for `remote` sessions (there are no
  approvals, and analysis of a remote event would run on central's model against central's
  database copy, which is fine but not v1). Drag-reorder works as for local rows.
- `Header.tsx` session picker: prefix remote sessions with the host name.
- `lib/layman-url.ts`, `layout/RouteErrorPanel.tsx`: on a remote with `centralUrl` set, "Not
  found on this instance" also offers **Open on central**, built with `buildUrl(centralUrl,
  route)`. On central, when the resolved session has a `hostId`, the panel is not involved; the
  chip in the transcript header is enough.
- Search results (`SessionsView` sidebar match list) show the chip on each session row; no other
  search UI changes.

### 8.3 Settings → Connection → "Multi-host sync" (`settings/SyncSection.tsx`)

Follows `GloveSection.tsx` for config editing and `HarnessSection.tsx` for per-row actions.

1. **This host**: `FieldRow` name (editable), `InfoRow` host id (short, copy button), `SegmentRow`
   role: Standalone / Central / Remote. Switching role is a plain config update; the server
   starts/stops loops. If `sessionRecording` is off, the role control is disabled with the hint
   "Turn on session recording in Data → Recording & import first".
2. **Remote** (role = remote): `FieldRow` central URL, `FieldRow` token (password), `ActionRow`
   Test connection (calls `/api/sync/test`, shows central name/version or the error), status
   block from `syncStatus` (state dot: idle/syncing/backoff/error; last success; backlog "N
   changes pending"; backfill progress "Backfilling events 12,400 / 51,020"), `FieldRow` interval
   seconds, `ToggleRow` "Mirror central history to this host" with pull status, `ActionRow` Sync
   now. Danger zone: Re-send everything (`reset-push`), Re-download mirror (`reset-pull`), Forget
   suppressions; each behind `ConfirmDialog`.
3. **Central** (role = central): warning `SectionIntro`: "Remote hosts connect to this port.
   The compose file binds 127.0.0.1 by default; bind to your LAN or Tailscale address only. The
   dashboard has no authentication." Then **Remote hosts** table (from `/api/sync/peers` joined
   with `/api/sync/hosts`): name, status dot (seen within 3 × interval → green; else grey;
   revoked → red), last seen, sessions, events, content size, backlog unknown (central cannot
   know), actions Rename / Revoke / Remove. **Add remote host** → name input → shows the token
   once with a copy button and the three-step instruction ("On the remote: Settings → Sync →
   role Remote → paste URL and token → Test connection").
4. **Hosts** (all roles once more than one host exists): table of `HostStats` for local + every
   known host: sessions, events, content, first/last activity; footer totals; `ActionRow`
   Recompute.

Add `sync` to the `SECTIONS` array with search terms `['sync', 'central', 'remote', 'host',
'mirror', 'token', 'multi-host', 'replicate']`.

### 8.4 Setup wizard

No new step. A one-line hint on the wizard's final step ("Running Layman on more than one
machine? See Settings → Multi-host sync") is enough.

---

## 9. Docker and deployment

- Both compose files: add `- LAYMAN_HOST_NAME=${LAYMAN_HOST_NAME:-}` to `environment`.
  `Makefile` `docker-run` and `start` export `LAYMAN_HOST_NAME=$(hostname)` when unset.
- `docs/installation.md`: new section **Running a central instance** covering: change the port
  binding from `127.0.0.1:8880:8880` to `<lan-or-tailscale-ip>:8880:8880` (never `0.0.0.0` on a
  machine with a public interface), the no-dashboard-auth warning, enrolment steps, and the
  `LAYMAN_HOST_NAME` variable. New section **Syncing a remote to central** for the remote side.
- `README.md`: one paragraph under "And more" and a row in the Documentation table.
- No new mounts. The DB stays a bind mount in DELETE journal mode; sync adds one writer
  (the applier) inside the same process, which is fine.

---

## 10. Phases

Each phase is a separate PR, leaves the suite green, and is usable on its own. Do not start a
phase before the previous one is merged and rebuilt into the image on both test machines.

### Phase 0: identity and schema (no behaviour change)

- `sync/identity.ts`, `sync/state.ts`, config `sync` block (+ web mirror, + `MOCK_CONFIG`),
  migration 2 with triggers, `sync_hosts` local row, `SyncStats.recompute()`.
- `RecordedSession.hostId/hostName` in API responses (always local for now).
- `LAYMAN_HOST_NAME` plumbing in compose and Makefile.
- Tests: migration (fresh + upgrade), trigger journaling for every write site in §2.3 (drive
  `SessionRecorder`, `BookmarkStore`, `HighlightStore`, `executePurge` against `:memory:` and
  assert `sync_log` contents), identity resolution order.
- Acceptance: existing installs upgrade in place; `sqlite3 layman.db "select count(*) from
  sync_log"` grows as sessions are recorded; nothing visible changes in the UI.

### Phase 1: push (remote → central), management API, tokens

- `protocol.ts`, `entities.ts`, `journal.ts`, `tokens.ts`, `applier.ts`, `pusher.ts`, `routes.ts`,
  `@fastify/compress` request decompression, role-driven start/stop in `server.ts`.
- Tests: entity registry page/load/upsert round trip per kind; applier idempotency (apply the
  same batch twice → same row count), apply order (bookmark before its session), collision
  rejection, suppression; pusher against an in-memory fake transport: backfill pages then
  incremental, interruption mid-backfill resumes at the cursor, non-2xx leaves the cursor
  untouched, 401 pauses; routes via `fastify.inject()`: missing/invalid/revoked token → 401,
  host-id mismatch → 409, protocol mismatch → 426, gzip body accepted.
- Acceptance (§11 steps 1–6): the remote's imported history appears on central within one
  backfill; new remote sessions appear on central within `intervalSeconds`.

### Phase 2: attribution UI and Settings

- `HostChip`, Sessions/Prompts/Header changes, host filter, search `hostIds`, resolve `hostId`,
  read-only remote curation, `SyncSection` with Remote and Central panels, hosts stats table,
  `sync:status` / `sync:hosts` frames.
- Tests: `sessionStore.test.ts` merge of remote `SessionInfo`; `db/search.test.ts` (new) host
  filter; a snapshot-free render test is not required (the repo has no DOM test setup); keep UI
  logic in small pure helpers (`hostAccent(hostId)`, `isEditableCuration(row, localHostId)`) and
  unit-test those.
- Acceptance (§11 steps 7–10).

### Phase 3: live presence on the Dashboard

- `presence.ts`, presence payload in push, live-tail broadcast + ring replay, Dashboard/Preview
  changes.
- Tests: registry TTL expiry, ring cap, `buildSessionsList()` merge order (local first, then
  remote by lastSeen), and that a backfilled 10,000-event session broadcasts nothing (timestamps
  older than 10 minutes).
- Acceptance (§11 step 11).

### Phase 4: mirror pull

- `puller.ts`, snapshot/changes routes, retention + compaction tick, `resync` handling,
  mirror controls in Settings, "Open on central" in the route-error panel.
- Tests: puller bootstrap → incremental with interruption; `changes` excludes own-origin;
  `resync` when behind retention; compaction keeps the newest entry per entity and never drops
  unacked own-origin entries on a remote.
- Acceptance (§11 steps 12–14).

### Phase 5: docs, changelog, hardening

- `CLAUDE.md`: a new "Multi-host sync" subsection under Architecture (pipeline summary, the
  trigger-journal decision, the ownership rule, the "never through EventStore" rule, pointer to
  `docs/features.md#multi-host-sync` and this plan). Keep it under ~40 lines; the detail lives in
  `docs/features.md` and `docs/installation.md`.
- `docs/features.md`: "Multi-host sync" section with a screenshot placeholder.
- `CHANGELOG.md` Unreleased entries (one per phase, written as the phases land).
- Hardening: rate-limit `hello` failures per IP (simple in-memory counter, 10/min), cap
  `snapshot`/`changes` `limit` at 1,000, log a warning when central receives a push while
  `sessionRecording` is off (the applier writes regardless; recording only gates the live
  recorder).

---

## 11. Manual acceptance script (two machines)

Prerequisites: both machines on the same private network; central's compose file changed to bind
its LAN/Tailscale address; both images rebuilt from the same commit; `LAYMAN_HOST_NAME` set on
both (`make docker-run` does it).

1. **Central upgrade.** Start central. Confirm in the container log that migration 2 ran once and
   `select count(*) from sync_hosts` is 1 with `kind='local'`, `session_count` equal to
   `select count(*) from recorded_sessions`. Open Settings → Multi-host sync: role Standalone,
   host name correct.
2. **Central role.** Set role Central. Click Add remote host, name it after the remote machine,
   copy the token.
3. **Remote first run.** Start the remote. Complete the setup wizard, enable **Session recording**
   (Data → Recording & import), then run **Import session history → Scan**. Expect the two weeks
   of Claude Code sessions to appear in Sessions. Check `select count(*) from sync_log` ≈ sessions
   + events imported.
4. **Enrol.** Settings → Multi-host sync: role Remote, central URL `http://<central>:8880`, paste
   token, Test connection → shows central's host name. Expect the status block to go through
   "Backfilling sessions…", "Backfilling events N / M", then "Up to date".
5. **Verify on central.** Sessions view: the remote's sessions appear with the host chip; the host
   filter lists both hosts; search for a term that only occurs in a remote session finds it and
   the result row carries the chip. Settings → Multi-host sync → Hosts shows both hosts with
   plausible counts and content sizes; the Remote hosts table shows the peer green.
6. **Interrupt and recover.** On the remote, start a Claude Code session with `/layman`, do a few
   tool calls. Stop the central container. Continue working on the remote for a minute (status
   goes to "backoff"). Start central. Expect the backlog to drain with no duplicate events on
   central (`select id, count(*) from recorded_events group by id having count(*) > 1` is empty)
   and the remote status back to "Up to date".
7. **Curation.** On the remote, bookmark one of its sessions into a new folder and highlight one
   prompt. On central, expect the folder, bookmark and highlight to appear with the remote's chip
   and no rename/delete controls. On central, bookmark a remote session into a central folder;
   expect the remote to **not** receive it (mirror is off).
8. **Deletion.** Delete a remote-origin session on central. Expect it gone on central, still
   present on the remote, and not resurrected after the remote's next push. Delete a session on
   the remote; expect it removed on central within one interval.
9. **PII purge.** Run Purge all PII on the remote; expect redacted copies on central within one
   interval (pick an event containing an email beforehand and compare).
10. **Links.** Copy a session link on the remote and open it on central: "Not found on this
    instance" (ids are the same, but the remote's `publicUrl` points at the remote). Open the
    same session id on central via `/s/<id>`: it opens with the chip. Set `publicUrl` on the
    remote to central's URL if you want copied links to resolve on central.
11. **Live presence.** Run a session on the remote. On central's Dashboard, expect a row with the
    chip, a running status dot, and the last few events in its preview within `intervalSeconds`;
    no Allow/Deny controls appear. Stop the session; the row goes idle within 3 × interval.
12. **Mirror.** On the remote, turn on Mirror. Expect "Downloading snapshot" then "Up to date",
    and central's months of sessions to appear in the remote's Sessions view with central's chip.
    Search on the remote for a term that exists only in central's data. The central-origin
    bookmark from step 7 now appears on the remote, read-only.
13. **Offline mirror.** Stop central. Search on the remote still works over mirrored data. Start
    central; the remote catches up.
14. **Retention.** Set `logRetentionDays` to 1 on central, wait for the maintenance tick (or
    trigger it via a test hook), stop the remote for > 1 day equivalent by setting its
    `pull_acked_seq` far behind (`update sync_state set value='1' where key='pull_acked_seq'`),
    restart: expect "Re-downloading snapshot" rather than an error.

---

## 12. Risks and notes

- **Trigger overhead on hot sessions**: each `session_metrics` event updates `recorded_sessions`
  (model/name) and journals a session row. Compaction (§3.10) and per-batch dedupe keep this
  cheap. Measure with a 10-minute pi session before Phase 1 lands; if `sync_log` grows faster
  than `recorded_events`, narrow the UPDATE trigger with `AFTER UPDATE OF` on the columns that
  matter.
- **Migration on a large central DB**: `UPDATE recorded_sessions SET host_id` and the qa
  backfill are small. Nothing touches `recorded_events`. Still, log start/end of migration 2 with
  timings.
- **`updateConfig()` shallow merge**: forgetting the deep-merge for `sync` will blank `hostId` on
  the first Settings change and mint a new identity, orphaning every row. The identity test in
  Phase 0 must cover "config update without `sync.hostId` keeps the persisted id".
- **Clock skew** between hosts affects only the 10-minute live-tail window and presence TTL, never
  correctness; both are computed against timestamps the origin produced plus a generous window.
- **No dashboard auth**: unchanged from today, but central is now reachable from the network.
  The Settings warning and the docs must be blunt about this. A future phase could gate
  everything behind the same token scheme.
- **Future**: last-writer-wins curation, chained hubs, analysis on central for remote events,
  syncing the dismissed drift items if they are ever persisted. None require protocol changes.

---

## 13. Kickoff prompt

Paste the following into a Claude Code session opened at the repository root to begin.

```
Read docs/planning/multi-host-sync.md in full, then CLAUDE.md. Implement the plan phase by
phase, starting with Phase 0. Rules:

- Work on a branch named sync/phase-0 (then sync/phase-1, and so on), one phase per branch and
  PR. Do not start the next phase until I have merged the previous one; stop and report when a
  phase is complete and green.
- Before writing code for a phase, list the files you will create or change and the tests you
  will add, then proceed without waiting.
- Keep the server and web type mirrors in sync (types/index.ts ↔ lib/types.ts and ws-protocol.ts,
  config/schema.ts ↔ LaymanConfig, and MOCK_CONFIG in hooks/handler.test.ts). Add new nested
  config to the deep-merge in config/config.ts.
- Never feed remote data through EventStore; follow §3.8. Journal by SQLite triggers as in §3.4
  and §4; do not instrument write sites by hand.
- Use real better-sqlite3 :memory: databases in tests (see db/recorder.count.test.ts). Run
  pnpm -r typecheck and pnpm -r test before declaring a phase done, and paste the summary lines.
- Add a CHANGELOG.md "Unreleased" entry per phase in the existing prose style (what changed and
  why). Update CLAUDE.md only in Phase 5 as the plan specifies.
- When the plan and the code disagree, the code wins for existing behaviour and the plan wins
  for new behaviour; note any such disagreement in your phase report so the plan can be
  corrected.

Begin with Phase 0.
```

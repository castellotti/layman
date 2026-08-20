# Development

Building, testing, and contributing to Layman.

## Prerequisites

- Node.js 22+
- pnpm 10 (`corepack enable && corepack prepare pnpm@10.29.3 --activate`)
- Docker (for container builds)

## Workspace layout

pnpm workspace with three packages:

| Package | What it is |
|---|---|
| `packages/server` | Fastify HTTP + WebSocket server, SQLite storage (better-sqlite3), analysis engine, hook/command installers. Builds with tsup. |
| `packages/web` | React 18 + Vite dashboard. Zustand stores, @xyflow/react flowchart, token-based dark theme with locally-served IBM Plex Sans/Mono. |
| `packages/opencode-plugin` | Bidirectional OpenCode plugin. |

## Common tasks

```bash
make install     # pnpm install
make dev         # server + web in parallel watch mode
make build       # pnpm -r build
make test        # vitest across the workspace
make typecheck   # tsc --noEmit across the workspace
```

## Turns and addressable URLs

A **turn** is one `user_prompt`, every event it owns up to (but not including) the next
`user_prompt`, and the *last* `agent_response` in that window. The last one matters: an agent
emits several interstitial messages between tool calls, and the final one is the answer.

The rule is implemented once per package and the two must stay in sync -
`packages/server/src/turns/extract.ts` and `packages/web/src/lib/turns.ts`. `pairFor()` in
`event-pairing.ts` delegates to the client copy rather than reimplementing the semantics.

`TurnStore` reads from SQLite rather than the in-memory `EventStore`, which caps at 10,000 events
and is exceeded by long sessions; it falls back to the live store for sessions that aren't
recorded, and memoizes per session until a new event arrives.

### Duplicate prompts

Recorded history contains ~800 `user_prompt` rows that were written twice by the hook
double-registration bug (see "Hook identity" below). Extraction collapses them: a `user_prompt`
whose trimmed text matches the open turn's and arrives within `DUPLICATE_PROMPT_WINDOW_MS` (1 s)
joins that turn instead of starting a new one.

The window is derived from the data, not chosen by feel - 741 same-text pairs are under 100 ms
apart and 794 under 1 s, then there is a gap until 1 s+ where the remaining 54 live, and those are
genuine re-sends of the same text. If you change the constant, **change it in both
`extract.ts` and `turns.ts`**, or the server and client will disagree about how many turns a
session has.

Left alone, each duplicate opens a phantom empty turn that also steals the previous turn's trailing
`agent_response`, because the `Stop` hook and the next `UserPromptSubmit` land within a few
milliseconds of each other and the response sorts between the two prompt copies. The turn keeps the
*first* copy's id as its address; the duplicate stays in `eventIds`, and `extractTurn()` /
`TurnStore.getTurn()` resolve it to the surviving turn so older links still work.

To inspect the duplicates yourself (a `sqlite3` CLI is the practical tool here, since
`better-sqlite3` has no prebuild for this machine's Node ABI):

```bash
sqlite3 ~/.claude/layman.db "
WITH p AS (
  SELECT session_id, timestamp, json_extract(data_json,'\$.prompt') AS txt,
         LAG(timestamp) OVER w AS prev_ts,
         LAG(json_extract(data_json,'\$.prompt')) OVER w AS prev_txt
  FROM recorded_events WHERE type='user_prompt'
  WINDOW w AS (PARTITION BY session_id ORDER BY timestamp, id))
SELECT count(*) FROM p WHERE prev_txt IS txt AND timestamp-prev_ts < 1000;"
```

### URL grammar

Defined in `packages/server/src/export/urls.ts`, mirrored in `packages/web/src/lib/layman-url.ts`.
A round-trip test (`parsePath(buildPath(x)) === x`) in each package guards against the copies
drifting.

```
/                                    dashboard
/s/{sessionId}                       session transcript
/s/{sessionId}/t/{promptEventId}     a turn - the primary addressable form
/s/{sessionId}/e/{eventId}           a single event
/h/{id}  /b/{id}  /f/{id}            highlight / bookmark / bookmark folder

?view=dashboard|logs|prompts|flow|sessions
?play=1        auto-speak the addressed turn (text-to-speech)
?t=<ms>        scroll to a timestamp rather than an id
```

Ids may be an unambiguous prefix of 8+ characters, so links stay readable when embedded in notes.
An ambiguous prefix returns 409 with the candidate list rather than guessing.

Deep links need the SPA fallback registered in `registerPlugins()`, which serves `index.html` for
any unmatched GET that isn't `/api/*`, `/hooks/*` or `/ws`. Without it, reloading `/s/<id>` 404s.

### Read API

```
GET /api/sessions/:sessionId/turns             turn list (text truncated at 2 KB)
GET /api/turns/:sessionId/:promptEventId       one turn; ?format=md for markdown
GET /api/sessions/:sessionId/export            ?format=md, or JSON
GET /api/resolve?id=<uuid-or-prefix>           resolve an id to its entity kind
```

The JSON export shape is deliberately the one `POST /api/bookmarks/sessions/import` accepts, so
export/import round-trips without translation. Markdown generation lives in
`packages/server/src/export/markdown.ts` and is pure and filesystem-free, so exporters can reuse
it. All generated links use the `publicUrl` config (falling back to `hookUrl`, then `host:port`) -
never hardcode `localhost` in a generated artifact.

`/api/resolve` also reports the `sessionId` an event, bookmark or highlight belongs to (and the
`promptEventId` a highlight names), because a `/b/` or `/h/` link is not navigable without it and
the client should not need two round-trips to follow one.

### Client-side routing

`packages/web/src/hooks/useLaymanRoute.ts`, called once from `App.tsx`. Inbound: on mount and on
`popstate`, `parsePath()` feeds `sessionStore.hydrateFromRoute()`. Outbound: on every store change,
`routeForState()` derives a path and writes it with `history.replaceState` (same addressed entity -
a view toggle) or `pushState` (different entity - opening a session or selecting a turn), so Back
leaves a session instead of unwinding panel toggles.

Two things are easy to break here:

- **The `applyingRoute` guard.** The outbound half must stay silent while the inbound half is
  applying. Without it the default store state (dashboard) races hydration and rewrites a deep link
  to `/` before it has loaded.
- **Round-tripping.** Anything `hydrateFromRoute` sets has to be readable back out by
  `routeForState`, or the URL decays on the first unrelated re-render. That is why
  `selectedTurnPromptEventId` and `selectedHighlightId` are store fields rather than component
  state. `packages/web/src/stores/routing.test.ts` asserts the property directly
  (`buildPath(routeForState(hydrated)) === originalPath`).

`?play=1` and `?t=` are arrival-only instructions and are never re-emitted; re-broadcasting `play`
would re-trigger speech on every state change.

Adding a new addressable thing means touching, in order: the grammar in both `urls.ts` and
`layman-url.ts` (+ their round-trip tests), `hydrateFromRoute`, `routeForState`, and a
`<CopyLinkButton route={...} />` wherever the thing is visible.

### Known: large archived transcripts block the main thread

Opening a very large recorded session (measured: 14,563 events) blocks the main thread for ~6 s. The
archived transcript renders every event unvirtualized and `expandedLogEventIds` defaults to `'all'`,
so it mounts every row with its detail body. This predates addressable URLs - clicking the session
in the sidebar does the same thing - but deep links make it easier to land on. Virtualizing the list,
or defaulting large archived sessions to collapsed, is the fix.

If you measure this, **interleave the variants within a single build**. Between-session drift on this
view is ~1 s against ~90 ms of within-session variance, so comparing two sequential builds
manufactures differences that are not real - it produced a phantom "+23% regression" once already.

## The database and why it is not in WAL mode

`~/.claude/layman.db` is a plain file on the host. In the Docker deployment it is reached through
the `${HOME}/.claude:/root/.claude` bind mount - it is **not** in a Docker volume, so it survives
`docker compose down -v`, can be backed up with `cp`, and is not affected by Docker's VM disk.

It runs in `journal_mode = DELETE`. On macOS a bind mount is FUSE-backed, and WAL depends on an
mmap-coordinated `-shm` file plus correct cross-process advisory locking - which FUSE mounts do not
reliably provide. This corrupted the database once already (2026-08-05: `btreeInitPage()` error 11
on two `recorded_events` pages, three indexes with wrong entry counts).

If it happens again, the recovery is non-destructive and lost nothing last time:

```bash
make docker-stop                                  # stop writes first
cd ~/.claude
mkdir -p layman-backup-$(date +%Y%m%d-%H%M%S)
cp -p layman.db layman.db-wal layman.db-shm layman-backup-*/   # -wal/-shm may not exist

sqlite3 layman.db "PRAGMA integrity_check;"       # confirm the damage
sqlite3 layman.db ".recover" | sqlite3 layman-recovered.db
sqlite3 layman-recovered.db "PRAGMA integrity_check;"          # expect: ok

# Compare before replacing. NOT INDEXED forces a table scan, which is the
# honest count - a corrupt index over-reports and looks like data loss.
sqlite3 layman.db "SELECT COUNT(id) FROM recorded_events NOT INDEXED;"
sqlite3 layman-recovered.db "SELECT COUNT(*) FROM recorded_events;"

mv layman.db layman-backup-*/layman.db.corrupt-original
mv layman-recovered.db layman.db
make docker-run
```

Then re-run the data-quality checks: `json_valid(data_json)=0`, NULL/empty required columns, events
whose `session_id` is not in `recorded_sessions`, and duplicate ids. All four should be zero.

Duplicate `user_prompt` rows are the one expected non-zero count (789 as of this writing) and are
**left in place deliberately** - see the duplicate-collapse decision in CLAUDE.md.

## Text to speech

Layman speaks agent responses through a [speaches](https://github.com/speaches-ai/speaches) server.
Off by default; Settings → Data → Text to speech.

### Running speaches locally

```bash
cd ~/development/ai/speaches
docker compose -f compose.cpu.yaml up -d          # CPU image; compose.cuda.yaml for NVIDIA

# Models are not bundled. Download one before anything can speak:
curl -X POST http://localhost:8000/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX
```

Kokoro ships 54 voices. `GET /api/tts/voices` lists whatever is actually installed - never hardcode
a voice list, it depends entirely on which models the user downloaded.

Layman running in Docker reaches a host-run speaches automatically: `resolveEndpoint()`
(`analysis/providers/openai-compat.ts`) rewrites `localhost` to `host.docker.internal` when
`/.dockerenv` exists. Use that helper rather than writing a second copy of the rewrite.

### Where the pieces live

| File | Role |
|---|---|
| `packages/server/src/routes/tts.ts` | proxy: `/api/tts/{speech,voices,models,test}` |
| `packages/web/src/lib/tts-text.ts` | markdown → speakable prose |
| `packages/web/src/lib/tts.ts` | `TtsPlayer`: queue, LRU blob cache, playback |
| `packages/web/src/hooks/useTTS.ts` | auto-speak, driven by the event stream |
| `packages/web/src/components/tts/` | `SpeakButton`, `TTSBar` |

### Why a proxy

speaches only installs CORS middleware when it was started with `allow_origins` (`main.py:182`), so
a browser fetch straight to it is blocked out of the box. The proxy also keeps the optional speaches
API key server-side. `tts.direct` bypasses it for users who *have* set `allow_origins`.

### Testing it

`TtsPlayer` takes a `TtsRuntime` (synthesize / createAudio / create+revokeObjectUrl). Web tests run
in node with no `Audio` and no `URL.createObjectURL`, so the tests inject a fake element whose
`ended` they fire by hand. That is what makes queue ordering, dedupe, the LRU cache, the autoplay
block and the generation guard testable at all - don't reach for the global `Audio` directly.

### Two things that surprise people

**Long turns take a while before any sound.** A 4,000-character response is several minutes of
audio, and synthesis is not instant - the transport bar sits on `◌` for 30-60 s first. That is
speaches working, not a hang. `maxChars` bounds it.

**speaches enforces speed 0.5-2.0** and returns a 422 outside that, even though the config schema
allows 0.25-4 (other backends differ). The settings slider is capped to the narrower range so the UI
cannot produce a rejected value. FastAPI's `{"detail": …}` envelope is unwrapped by
`upstreamErrorMessage()` so the panel shows the sentence rather than escaped JSON.

## Hook identity

`buildLaymanHooks()` writes `_layman: true` on each hook, but **claude-code strips unknown keys
when it rewrites `settings.json`**, so the tag does not survive and cannot be relied on for
identification. Matching on the configured `serverUrl` instead is also unsafe: when the URL
changes (port, `--hook-url`, `localhost` vs `host.docker.internal`) the old entries stop matching
and `install()` appends a *duplicate* hook set, so every event fires twice.

`isLaymanHook()` therefore matches structurally on the URL shape - any
`{origin}/hooks/{KnownLaymanEvent}` - which makes install idempotent and self-healing across URL
changes. `stripLaymanHooks()` filters individual hook entries rather than dropping whole matcher
objects, so a matcher holding both a Layman hook and a user's own hook doesn't lose the user's.

Layman installs globally; any Layman hook in a project's `.claude/settings.local.json` is a
leftover from before that and gets merged on top of the global set.
`findOrphanedProjectHooks()` / `repairOrphanedProjectHooks()` detect and remove them, scoped to a
named directory. Exposed as `layman repair-hooks` - a CLI command, because the container mounts
only `~/.claude` and friends and cannot see project directories. The
`GET /api/setup/orphaned-hooks` and `POST /api/setup/repair-hooks` routes serve native installs
and are restricted to directories Layman is actively tracking, so they can't rewrite arbitrary
paths.

## Running from source in Docker

```bash
make docker-build   # docker build -t layman .
make docker-run     # build + compose up, hooks scoped to the current directory
make docker-logs    # follow logs
make docker-stop
```

`make docker-run` points Layman at the current working directory's `.claude` folder; override with `LAYMAN_PROJECT_DIR=/path/to/project`.

The image builds on `node:22-slim`; `better-sqlite3` is a native module compiled during the image build (python3/make/g++ are installed in the build stage).

## Frontend conventions

- **Design tokens** - colors, spacing, and type come from CSS custom properties in `packages/web/src/index.css` (`--text`, `--text-muted`, `--accent`, `--bg-selected`, `--warn`, `--error`, …). Never hardcode palette hexes in components.
- **Shared primitives** - `StatusDot`, `StateChip`, `Meter`, `RiskTag`, `FilterChip`, `SearchInput`, `LiveChip`, `JumpToLatest` live in `packages/web/src/components/primitives/`. Reuse them before writing new controls.
- **Selection semantics** - radios render as segmented controls with exactly one selection (re-click is a no-op); toggles are chips that visibly clear on second click; visual state derives from a single store value.
- Fonts are served locally via `@fontsource` - no CDN requests at runtime.

## Contributing

- Read [`CLAUDE.md`](../CLAUDE.md) - it defines project conventions and is enforced for AI-assisted contributions (Layman's own drift monitoring watches it, too).
- Run `make typecheck && make test` before opening a PR.
- Keep [`CHANGELOG.md`](../CHANGELOG.md) entries in the existing format: one bullet per change with the PR link.
- Releases are cut with `scripts/release.sh` and published as Docker images to ghcr.io via GitHub Actions.

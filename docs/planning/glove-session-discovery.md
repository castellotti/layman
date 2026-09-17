# glove ↔ Layman session discovery

**Status:** proposed — needs a glove-side change (separate session) and a Layman-side consumer.
**Owner (Layman):** this repo. **Owner (glove):** `~/development/castellotti/glove` — a separate
working session; this doc is the handoff brief for it.
**Motivating case:** a gloved pi session in `~/development/ai/pi-search/` never appeared in Layman's
Sessions or Dashboard, despite writing valid transcripts.

---

## 1. The problem, precisely

Layman monitors gloved harnesses passively by tailing the transcript logs glove persists on the host
(`docs/extensions/glove.md`). `GloveSource` (`packages/server/src/monitor/sources.ts`) discovers
those logs by globbing **one fixed layout**:

```
~/.glove/envs/<env-id>/home/.pi/agent/sessions/     (gloved pi)
~/.glove/envs/<env-id>/home/.vibe/logs/session/     (gloved Vibe)
```

That assumes each env's harness home is the env's own `home/` subdir. glove lets a config relocate
it. From `glove/cli.py`:

```python
def _home_dir(cfg, edir: Path) -> Path:
    """The harness config home: the env's own `home/`, or a power-user override."""
    if cfg.config_home_source:
        return Path(os.path.realpath(cfg.config_home_source))
    return edir / "home"
```

The `pi-search` env sets exactly this. Its rendered config
(`~/.glove/envs/pi-search/sessions/pi-search/glove.effective.yaml`) contains:

```yaml
config_home_source: /Users/sc/development/ai/pi-search/state/home
```

and the generated `docker-compose.yml` binds that path to `/home/agent`. pi's transcripts are really
written to:

```
/Users/sc/development/ai/pi-search/state/home/.pi/agent/sessions/--work--/*.jsonl
```

Two independent failures follow, and **both** must be solved:

### 1a. Discovery (Layman code)
`GloveSource` only ever probes `<env-id>/home/…`. It has no knowledge of `config_home_source`, so it
never learns the relocated home exists. `pi-local` works only because it uses the default `home/`;
`pi-search` is invisible. This is a real, unimplemented case — `docs/extensions/glove.md` already
flags it: *"A power-user `config_home_source` override … relocates `home/` outside `~/.glove/envs/`,
where Layman's single-dir glob would not find it."*

### 1b. Access (Docker mount)
Layman runs in the `layman` container, which bind-mounts only `~/.glove/envs` (read-only). The
relocated home `/Users/sc/development/ai/pi-search/state/home` is **outside every mount**, so even a
perfect discovery fix cannot read that path from inside the container. This is inherent to
containers: Docker can only read host paths that are bind-mounted.

Prior fixes (#100/#101 — showing gloved sessions live on the Dashboard) addressed *activation*,
assuming the home was already discovered. For `pi-search` neither discovery nor access ever
succeeded, which is why the problem persisted through several attempts.

---

## 2. Design principles (from the project owner)

1. **Layman must not be customized around specific, possibly-temporary glove instances.** No
   hardcoded paths, no per-session config list inside Layman.
2. **glove should indicate, in a single canonical location, where each *registered* env's monitorable
   logs live.** Layman reads that one location. If achieving this needs a glove change, it happens in
   the glove repo (separate session) — this doc is that brief.
3. **Respect glove's security/privacy model.** glove sandboxes an AI harness and strictly controls
   what data the *agent* can read/modify (read-only source mounts, LLM key stripped from the agent's
   env, secrets redacted from persisted artifacts). Layman is a *trusted external observer*; the
   transcripts are exactly what it is meant to see. So exposing transcripts to Layman is not a
   privacy regression — but Layman must never gain a path that widens what the *sandboxed agent* can
   reach, and must stay read-only.

---

## 3. Proposed design

### 3.1 glove is the single source of truth for each env's home — via the registry

glove already maintains one canonical file binding every *registered* env to its identity:
`~/.glove/registry.json` (`glove/registry.py`, `EnvEntry`). Today each entry is:

```json
{ "dir": "/Users/sc/development/ai/pi-search/work", "harness": "pi", "env_id": "pi-search" }
```

**Proposal (glove side):** record the *resolved harness home* per env in the same registry, so the
single file that already answers "what envs exist" also answers "where does each one's monitorable
home live." Add a `home` field carrying the absolute, realpath-resolved home directory:

```json
{
  "dir": "/Users/sc/development/ai/pi-search/work",
  "harness": "pi",
  "env_id": "pi-search",
  "home": "/Users/sc/development/ai/pi-search/state/home"
}
```

Rules for glove:
- `home` = `_home_dir(cfg, edir)` resolved at **`glove run`** time (config_home_source can arrive via
  `--config` at run time and is not known at `init`), written back into the registry entry.
- For the default layout, `home` = `<env-id>/home` (absolute). Recording it unconditionally keeps
  Layman's consumer uniform (no "field sometimes absent" special-casing beyond back-compat).
- Keep it a realpath so Layman never has to resolve symlinks that wouldn't resolve inside a
  container.
- No secrets: `home` is a directory path, not sandbox contents.

Why the registry rather than the per-session `glove.effective.yaml`: the effective yaml is a
*rendered, per-run* artifact under `sessions/<name>/`, one per named session, redacted for secrets.
It is fine as an interim read (§3.4) but it is not "a single canonical location" — the registry is.
One env can have several named sessions sharing one home; the registry has exactly one entry per env.

### 3.2 Layman consumer

`GloveSource.roots()` changes from "glob `<env-id>/home`" to "read the registry, and for each entry
probe `<home>/.pi/agent/sessions` and `<home>/.vibe/logs/session`":

- Read `<glove_home>/registry.json` (glove_home = `$GLOVE_HOME` or `~/.glove`; Layman already has a
  configured `glove.sessionsDir` pointing at `…/envs`, so derive the parent, or add a
  `glove.home`-style resolution — see §3.3).
- For each entry, use `entry.home` when present; **fall back to `<sessionsDir>/<env-id>/home`** when
  it is absent (old glove, or an env registered before this field existed). This preserves today's
  behavior byte-for-byte for the default layout and for pre-upgrade registries.
- Keep the existing `statSync().isDirectory()` / `existsSync()` guards and the `label = env-id`
  tagging. Everything downstream (activation via `shouldActivateWatchedSession`, the two passive
  watchers filtering by agent type, history import via `discoverTranscriptFiles`) is unchanged
  because it consumes `WatchRoot`s, not the discovery mechanism.
- The registry may list envs whose home is currently unreadable (never run, or not mounted — §3.3);
  a non-existent path simply yields no root, exactly as a missing `home/` does today.

This is fully general: it discovers *any* relocation glove records, with zero per-instance Layman
configuration.

### 3.3 Access / mount contract (the Docker half) — DECIDED: convention under `~/.glove`

Discovery (§3.1–3.2) is necessary but not sufficient in Docker: the container must also be able to
*read* the home path. Three sub-points:

1. **The registry file itself.** `registry.json` sits at `~/.glove/registry.json`, a sibling of
   `envs/`. Layman currently mounts only `~/.glove/envs`. Change the mount to `~/.glove` (read-only)
   so the registry is readable. This is a clean superset of the current mount and still read-only —
   `docker-compose.yml` and the "Docker mounts" note in `CLAUDE.md` both need the one-line change.

2. **Host→container path translation.** The registry records **absolute host paths**
   (`/Users/sc/.glove/…`), but inside the container the same tree is mounted at `/root/.glove/…`.
   Layman's consumer must therefore translate a registry `home` path from the host home prefix to the
   container home before probing it — Layman already receives the real host home as the `HOST_HOME`
   env var (used today by the Codex installer) and its own home is `homedir()` (`/root` in the
   container). Rule: if `home` starts with `HOST_HOME`, replace that prefix with `homedir()`; a
   translated path that isn't under a mount simply won't exist and yields no root (graceful, same as
   a missing `home/`). Native Layman sets `HOST_HOME == homedir()` so the translation is a no-op.

3. **The relocated home must live under a mounted root — chosen contract (B).** An arbitrary host
   path is reachable from the container only if bind-mounted; a static compose file cannot mount a
   path it cannot know in advance, and Layman must not carry per-instance mounts (principle 1). The
   **decided contract:** a home that glove relocates *and that a containerized Layman should watch*
   lives under `~/.glove` — the single root Layman mounts (§3.3.1). The default env home
   (`~/.glove/envs/<env-id>/home`) already satisfies this; a deliberately-relocated home is pointed
   somewhere under `~/.glove` too. `pi-search` therefore moves its home out of the in-project
   `state/home` and under `~/.glove` (see §4b).

   Alternatives considered and rejected as the default: **(A) native Layman** (reads any host path,
   no mount change — kept as the escape hatch for anyone not running the container) and **(C) a broad
   read-only mount** of a common ancestor like `~/development` (keeps in-project homes but widens
   Layman's read-only filesystem view; it does *not* widen the sandboxed agent's view, since the
   mount is on the trusted Layman container, but it is more filesystem exposure than the convention
   needs). (C) remains the escape hatch when an in-project home is a hard requirement and native
   Layman is not an option.

### 3.4 Interim bridge (optional, Layman-only, no glove change)

Until glove ships the registry `home` field, Layman *can* resolve a relocated home generally — not
per-instance — by reading `config_home_source` from the env's newest
`sessions/*/glove.effective.yaml`. This is a general rule keyed on glove's own rendered artifact
(already under the mounted `~/.glove/envs`, already secret-redacted), not a hardcoded path, so it
respects principle 1. It makes `pi-search` discoverable immediately for a **native** Layman and for
any Docker deployment that already satisfies §3.3.2. Treat it as a fallback that the registry field
supersedes; it can be deleted once glove ships §3.1. A tiny scalar read (`config_home_source:` line)
avoids adding a YAML dependency to the server, which currently has none.

---

## 4. Handoff checklist for the glove session

Implement in `~/development/castellotti/glove`:

1. **`glove/registry.py`** — add `home: str | None = None` to `EnvEntry`. `load_registry` already
   tolerates extra/missing keys only if you keep the dataclass permissive; ensure
   `EnvEntry(**e)` won't break on old entries lacking `home` (default `None`) and on this new field.
2. **`glove/cli.py` (`run`)** — after `home_dir = _home_dir(cfg, edir)` (currently ~line 247),
   persist the resolved absolute `home_dir` into the registry entry for `env_id` (load, update the
   matching entry's `home`, save). Write realpath. This is the only place the run-time-resolved home
   is known.
3. **Back-compat** — an env registered before this change has `home == None` until its next `run`;
   Layman falls back to `<env-id>/home` (§3.2), so nothing regresses in the meantime.
4. **Docs** — note in glove's own docs that `registry.json` now records the resolved home and that
   external monitors (Layman) rely on it.
5. **No secret exposure** — `home` is a directory path only; do not add config contents to the
   registry.

Current on-disk facts for reference:
- Registry today: `~/.glove/registry.json` — array of `{dir, harness, env_id}`.
- `pi-search` env dir: `~/.glove/envs/pi-search/` — contains `glove.yaml` (`harness: pi`,
  `name: pi-search` only), `sessions/pi-search/{docker-compose.yml,glove.effective.yaml,enforcer/}`,
  and **no** `home/` (it is relocated).
- Relocated home: `/Users/sc/development/ai/pi-search/state/home` (from `config_home_source`).
- Launcher pattern that produces relocation: `~/development/ai/pi-search/` configs + scripts, run
  from the invocation dir, `--config <file>` at run time (so `config_home_source` is a run-time
  input, not in the env's `glove.yaml`).

### 4b. pi-search change (its own session)

Under contract (B), pi-search stops relocating its home into the repo and puts it under `~/.glove`.
Concretely (`~/development/ai/pi-search/`):
- `configs/pi-search.glove.yaml:54` — change `config_home_source:
  /Users/sc/development/ai/pi-search/state/home` to a path under `~/.glove` (e.g.
  `${HOME}/.glove/homes/pi-search`), or drop it to accept glove's default
  `~/.glove/envs/pi-search/home`. Either is under the single mounted root.
- `scripts/install.sh:43` — retarget `EXT_DST` (currently `$REPO/state/home/.pi/agent/extensions/
  webfetch`) to the new home's `.pi/agent/extensions/webfetch`, and create it there.
- **Tradeoff to accept:** sandbox home state (including the installed `webfetch` extension) moves out
  of the git-ignored in-repo `state/home` and lives under `~/.glove`. The security posture is
  unchanged (the agent still only sees its own home; the LLM key is still stripped/redacted); only
  the *persistence location* moves. If keeping home in-repo is a hard requirement, use contract (C)
  (broad ro mount) instead and pi-search needs no change.

---

## 5. Layman-side work items (this repo, after §3.1 or via §3.4 interim)

1. `packages/server/src/monitor/sources.ts` — `GloveSource.roots()` reads the registry (with
   `<env-id>/home` fallback), optionally the §3.4 effective-yaml bridge. Add unit tests covering:
   default layout (unchanged), relocated home via registry `home`, relocated home via the interim
   bridge, missing/old registry (fallback), and a registry entry whose home does not exist (no root,
   no throw).
2. `docker-compose.yml` + `CLAUDE.md` "Docker mounts" note — widen `~/.glove/envs:ro` to
   `~/.glove:ro` so `registry.json` is readable (§3.3.1).
3. `docs/extensions/glove.md` — replace the "single-dir glob would not find it" limitation note with
   the registry-based discovery description and the §3.3.2 mount contract.
4. Whichever §3.3.2 option is chosen — corresponding compose/mount change (none for A/B-under-glove;
   one broad ro mount for C) plus a doc line.

---

## 6. Decision record

**§3.3.3 — how a containerized Layman reaches a relocated home:** chosen **contract (B)** — a
relocated home that a containerized Layman should watch lives under `~/.glove` (the single mounted
root), with host→container path translation (§3.3.2). (A) native Layman and (C) broad ro mount remain
escape hatches. pi-search conforms by moving its home under `~/.glove` (§4b).

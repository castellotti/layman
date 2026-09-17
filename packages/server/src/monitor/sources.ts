/**
 * Monitor sources — where the passive file watcher looks for harness logs.
 *
 * Layman's passive monitoring (currently Mistral Vibe) tails on-disk transcripts
 * rather than receiving network hooks. Historically the watch path was a single
 * hardcoded directory (`~/.vibe/logs/session`). A `MonitorSource` generalises
 * that: it enumerates *watch roots* on demand, so several roots — the native
 * home plus any number of sandboxed ones — can be watched at once without any
 * one of them displacing the others.
 *
 * The interface deliberately separates *where* to watch (a source) from *how* to
 * parse (the watcher's format logic). Each root declares its `agentType`, so a
 * single glove sandbox can yield both a Vibe root and a pi root; each passive
 * watcher filters `roots()` down to the agent type it knows how to parse.
 *
 * `roots()` is re-queried on every scan tick, so sources are dynamic: a glove
 * sandbox that appears or disappears mid-run is picked up or dropped on the next
 * scan without a restart.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, sep } from 'path';
import { homedir } from 'os';

/** A single directory the watcher should tail, plus how to attribute what it finds. */
export interface WatchRoot {
  /** Absolute path to a harness session-log directory (e.g. `.../.vibe/logs/session`). */
  path: string;
  /** Layman agent type sessions from this root are attributed to. */
  agentType: string;
  /**
   * Human label for the origin of this root, surfaced as the session name so
   * sandboxed sessions are distinguishable from native ones in the UI. Undefined
   * for native roots (they carry no extra label).
   */
  label?: string;
}

/** Supplies watch roots for the passive file watcher. Queried on every scan tick. */
export interface MonitorSource {
  /** Stable identifier, for logging (`'native-vibe'`, `'native-pi'`, `'glove'`). */
  readonly id: string;
  /** Current set of roots. May change between calls; empty is valid. */
  roots(): WatchRoot[];
}

/**
 * Whether a freshly-tracked session should be gate-activated (i.e. surfaced live
 * on the Dashboard). A glove-sandboxed session — one whose root carries a `label`
 * — has no other activation path: `/layman` runs inside the sandbox and cannot
 * reach the host, so `autoActivateClients` is the only switch, and a
 * passively-tailed sandbox is observe-only by construction. Such sessions
 * therefore always activate. Native roots (no label) keep the
 * `autoActivateClients` gate.
 *
 * Shared by both passive watchers (`VibeSessionWatcher`, `PiSessionWatcher`) so
 * this load-bearing rule lives in exactly one place. Note this governs only the
 * *initial* activation — resume re-activation is handled by
 * `SessionGate.suspend`/`resume`, which restore the activation state captured at
 * tombstone time so a manual deactivation survives an idle-timeout+resume rather
 * than being silently undone.
 */
export function shouldActivateWatchedSession(
  agentType: string,
  label: string | undefined,
  autoActivateClients: readonly string[],
): boolean {
  return !!label || autoActivateClients.includes(agentType);
}

const VIBE_AGENT_TYPE = 'mistral-vibe';
/** Relative path from a home directory to the Vibe session-log dir. */
const VIBE_SESSION_SUBPATH = join('.vibe', 'logs', 'session');

const PI_AGENT_TYPE = 'pi';
/** Relative path from a home directory to pi's session-log dir. */
const PI_SESSION_SUBPATH = join('.pi', 'agent', 'sessions');
/**
 * Relative path from a home directory to the installed Layman pi extension. Its
 * presence means the live extension is recording native pi over hooks, so the
 * passive watcher must not also tail the native transcript (see NativePiSource).
 */
const PI_EXTENSION_SUBPATH = join('.pi', 'agent', 'extensions', 'layman', 'index.ts');

/**
 * The native (non-sandboxed) Vibe logs — the historical single root. Tries the
 * Docker bind-mount path first, then the real host home, matching the watcher's
 * original `resolveSessionLogDir()`. Carries no label: native sessions are the
 * baseline the sandboxed ones are distinguished *from*.
 */
export class NativeVibeSource implements MonitorSource {
  readonly id = 'native-vibe';

  roots(): WatchRoot[] {
    const dockerPath = join('/root', VIBE_SESSION_SUBPATH);
    const hostPath = join(homedir(), VIBE_SESSION_SUBPATH);
    const path = existsSync(dockerPath) ? dockerPath : existsSync(hostPath) ? hostPath : null;
    if (!path) return [];
    return [{ path, agentType: VIBE_AGENT_TYPE }];
  }
}

/**
 * The native (non-sandboxed) pi logs. Mirrors `NativeVibeSource`: tries the
 * Docker bind-mount home first, then the real host home. Carries no label, so
 * native pi sessions are the baseline sandboxed ones are distinguished *from*.
 *
 * Unlike Vibe, native pi has a *live* integration — the Layman pi extension,
 * which records the same session over hooks. If that extension is installed,
 * this source returns no root: tailing the native transcript in addition would
 * record every turn twice (the passive path mints fresh ids, so the live-source
 * dedupe can't collapse them). The passive watcher is for glove-sandboxed pi
 * (which can't reach Layman) and native pi *without* the extension. Glove pi
 * roots come from GloveSource and are unaffected — a sandbox never runs the
 * host's extension.
 */
export class NativePiSource implements MonitorSource {
  readonly id = 'native-pi';

  roots(): WatchRoot[] {
    const dockerHome = '/root';
    const hostHome = homedir();
    const home = existsSync(join(dockerHome, PI_SESSION_SUBPATH))
      ? dockerHome
      : existsSync(join(hostHome, PI_SESSION_SUBPATH))
        ? hostHome
        : null;
    if (!home) return [];
    // The live extension owns native pi when installed; don't double-record.
    if (existsSync(join(home, PI_EXTENSION_SUBPATH))) return [];
    return [{ path: join(home, PI_SESSION_SUBPATH), agentType: PI_AGENT_TYPE }];
  }
}

/**
 * Sandboxed harness logs produced by glove (github.com/castellotti/glove).
 *
 * glove's unit of identity is an *environment* — the pair `(invocation_dir,
 * harness)` bound to a stable `env-id` — and all its state lives under
 * `<sessionsDir>/<env-id>/` (glove v2's `~/.glove/envs/<env-id>/`). That dir
 * holds `glove.yaml`, per-run `sessions/<name>/` subtrees (compose file,
 * enforcer policies, browser media — no transcripts), and a `home/` tree that
 * glove bind-mounts as the harness home. Transcripts live in `home/`, mirroring
 * the real dotfile layout: a gloved Vibe writes
 * `<sessionsDir>/<env-id>/home/.vibe/logs/session/...` and a gloved pi writes
 * `<sessionsDir>/<env-id>/home/.pi/agent/sessions/...` — exactly the layouts the
 * passive watchers already understand, only rooted elsewhere. glove pre-creates
 * the Vibe log dir on launch so a monitor can attach before the first turn; pi's
 * sessions dir appears at runtime and is picked up on the next scan tick.
 *
 * A home is not always the env's own `home/`. A config can set
 * `config_home_source` to relocate it (glove's `_home_dir()`), and glove records
 * the *resolved* home per env in `~/.glove/registry.json` — the single canonical
 * pointer this source reads (see `docs/planning/glove-session-discovery.md`).
 * `roots()` therefore resolves each env's home from two places and lets the
 * registry win:
 *   - **enumeration** of `<sessionsDir>/<env-id>/home` — the default layout, and
 *     the back-compat path for an old glove whose registry lacks the `home` field
 *     or an env not yet re-run since glove started recording it; and
 *   - the **registry's** recorded `home`, which overrides the default and also
 *     contributes envs whose home is relocated outside `<sessionsDir>`.
 * Each resolved home is probed for the two known subpaths and labelled with the
 * env id (e.g. `pi-local`, or `myrepo-pi` / `myrepo-1a2b3c` when glove
 * disambiguates a name clash). Because several named glove sessions of one env
 * share one home, they all carry the env-id label rather than the glove session
 * name; a single env may run both harnesses, so it can yield a vibe root *and* a
 * pi root. Non-`home/` siblings (`glove.yaml`, `sessions/`, a stray `.DS_Store`)
 * are ignored — the `statSync().isDirectory()` guard skips non-dirs, and only the
 * two known subpaths are probed. It reads only what the sandbox already
 * persisted: no new mount into the container, no egress, nothing added to what
 * the sandboxed agent can see — read-only "outside looking in".
 *
 * The registry records **absolute host paths** (`/Users/you/.glove/...`), but in
 * the Docker deployment the same tree is mounted at `/root/.glove/...`, so a
 * registry `home` is translated from the host home prefix (`HOST_HOME`, the env
 * var Layman already receives for exactly this) to the container home
 * (`homedir()`) before probing. Native Layman leaves `HOST_HOME` unset (or equal
 * to `homedir()`), so the translation is a no-op. A translated path that isn't
 * under a mount simply won't exist and yields no root — the same graceful outcome
 * as a missing `home/`. The mount contract (relocated homes that a containerized
 * Layman watches live under `~/.glove`) is documented in the planning doc.
 *
 * Vibe and pi are discovered because both persist a tailable transcript on the
 * host. The other network-hook harnesses (codex, cline, opencode) POST *to*
 * Layman, which a net-restricted sandbox cannot reach, and persist nothing to
 * tail — monitoring those from a sandbox is a separate mechanism (a
 * glove-provided forwarder), not this source.
 */

/** One entry of glove's `registry.json`. Extra fields tolerated; `home` is new. */
interface GloveRegistryEntry {
  env_id?: string;
  harness?: string;
  dir?: string;
  /** Absolute, realpath-resolved harness home; absent on pre-upgrade glove. */
  home?: string;
}

export class GloveSource implements MonitorSource {
  readonly id = 'glove';
  private getSessionsDir: () => string | null;

  /** @param getSessionsDir resolves the current glove sessions dir, or null when disabled. */
  constructor(getSessionsDir: () => string | null) {
    this.getSessionsDir = getSessionsDir;
  }

  roots(): WatchRoot[] {
    const base = this.getSessionsDir();
    if (!base) return [];

    // env-id -> resolved home dir (container path). Enumeration supplies the
    // default `<env-id>/home`; the registry's recorded home overrides it and
    // adds envs whose home is relocated outside `base`. A Map dedupes the common
    // case where both name the same directory.
    const homes = new Map<string, string>();

    // Default layout: every env dir directly under the sessions dir. `base` may
    // not exist at all (registry-only relocation, or `envs/` not yet created);
    // enumeration then yields nothing and the registry carries discovery, so a
    // missing/unreadable dir is not an early return.
    let sandboxes: string[] = [];
    try {
      sandboxes = readdirSync(base);
    } catch {
      sandboxes = []; // missing/unreadable dir; the registry may still supply homes
    }
    for (const sandbox of sandboxes) {
      const sandboxDir = join(base, sandbox);
      try {
        if (!statSync(sandboxDir).isDirectory()) continue;
      } catch {
        continue; // vanished between readdir and stat
      }
      homes.set(sandbox, join(sandboxDir, 'home'));
    }

    // Registry: glove's canonical, run-time-resolved home per env (wins) — but
    // only when that home is actually readable from this process. A stale,
    // unmounted, or not-yet-created registry home must not clobber a default
    // `<env-id>/home` that does exist, or a discoverable session disappears.
    for (const entry of this.readRegistry(base)) {
      if (entry.env_id && entry.home) {
        const home = this.toContainerPath(entry.home);
        if (existsSync(home)) homes.set(entry.env_id, home);
      }
    }

    const roots: WatchRoot[] = [];
    for (const [label, home] of homes) {
      const vibeDir = join(home, VIBE_SESSION_SUBPATH);
      if (existsSync(vibeDir)) {
        roots.push({ path: vibeDir, agentType: VIBE_AGENT_TYPE, label });
      }
      const piDir = join(home, PI_SESSION_SUBPATH);
      if (existsSync(piDir)) {
        roots.push({ path: piDir, agentType: PI_AGENT_TYPE, label });
      }
    }
    return roots;
  }

  /**
   * Reads `<glove-home>/registry.json` (a sibling of the sessions dir), the
   * single file glove uses to bind each env to its identity and — since the
   * registry-resolved-home change — its resolved home. Best-effort: a missing or
   * malformed registry yields `[]`, leaving enumeration to carry discovery.
   */
  private readRegistry(base: string): GloveRegistryEntry[] {
    const path = join(dirname(base), 'registry.json');
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return []; // no registry (or unreadable) — enumeration still works
    }
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      // Keep only object entries: a stray `null` or primitive in the array would
      // otherwise throw on `entry.env_id` in roots(), which runs on every scan
      // tick — a bad element must degrade to enumeration, not crash the scan.
      return data.filter(
        (e): e is GloveRegistryEntry => typeof e === 'object' && e !== null,
      );
    } catch {
      return []; // malformed JSON — don't let it break discovery
    }
  }

  /**
   * Translates an absolute host path from the registry into the path this
   * process can read, using this process's `HOST_HOME` and `homedir()`.
   */
  private toContainerPath(hostPath: string): string {
    return rebaseGloveHome(hostPath, process.env.HOST_HOME, homedir());
  }
}

/**
 * Rebases an absolute host path onto the container home. In Docker the host home
 * (`hostHome`, from `HOST_HOME`) is bind-mounted at the container home
 * (`containerHome`, `homedir()`), so a registry `home` recorded as a host path is
 * rebased onto the container home. Native Layman (no `HOST_HOME`, or
 * `HOST_HOME === homedir()`) returns the path unchanged. The match is
 * path-boundary aware so `/Users/sc-other` is never treated as living under
 * `/Users/sc`. A trailing separator on `hostHome` is normalized away so the
 * translation does not depend on how `HOST_HOME` happens to be spelled.
 * Exported for direct testing.
 */
export function rebaseGloveHome(
  hostPath: string,
  hostHome: string | undefined,
  containerHome: string,
): string {
  if (!hostHome) return hostPath;
  let home = hostHome;
  while (home.length > 1 && home.endsWith(sep)) home = home.slice(0, -sep.length);
  if (home === containerHome) return hostPath;
  if (hostPath === home) return containerHome;
  if (hostPath.startsWith(home + sep)) {
    return join(containerHome, hostPath.slice(home.length + 1));
  }
  return hostPath;
}

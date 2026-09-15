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

import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
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
 * holds `glove.yaml` and a per-run `sessions/<name>/` subtree (compose file,
 * enforcer policies, browser media) that also carries the `home/` tree glove
 * bind-mounts as the harness home. **The home is per-session, not per-env**:
 * glove's `_home_dir()` resolves it to `<env-id>/sessions/<name>/home` because a
 * rendered harness config embeds session-scoped values (its own LLM sidecar URL),
 * so two live sessions of one env must not share a home. The default unnamed
 * session is named after the env, so its home is `<env-id>/sessions/<env-id>/home`.
 * Transcripts live under that home, mirroring the real dotfile layout: a gloved
 * Vibe writes `.../home/.vibe/logs/session/...` and a gloved pi writes
 * `.../home/.pi/agent/sessions/...` — exactly the layouts the passive watchers
 * already understand, only rooted elsewhere.
 *
 * Older glove (and a `config_home_source` override) instead bind-mounted a single
 * env-level `<env-id>/home/`, and envs created under it still hold their
 * transcripts there. We therefore probe per-session homes first and fall back to
 * the env-level `home/` only when an env has no session home — never both for one
 * env, or a session present under both (a stale env-level copy plus its live
 * per-session copy, as happens after a glove upgrade) would be tailed twice and
 * every turn recorded twice, since the passive path mints fresh ids the live
 * dedupe can't collapse across two roots.
 *
 * This source globs one or two levels of directories and returns a root for each
 * harness log tree it finds, labelled with glove's session token — the env id for
 * the default session (e.g. `pi-local`), else `<env-id>-<name>` (e.g.
 * `pi-local-myrepo`) — so its sessions are tagged and distinguishable in the UI. A
 * single env may run both harnesses, so it can yield a vibe root *and* a pi root.
 * Non-directory and unrelated siblings (`glove.yaml`, a stray `.DS_Store`) are
 * ignored — the `statSync().isDirectory()` guard skips non-dirs, and only the two
 * known subpaths are probed. It reads only what the sandbox already persisted: no
 * new mount into the container, no egress, nothing added to what the sandboxed
 * agent can see — read-only "outside looking in".
 *
 * Vibe and pi are discovered because both persist a tailable transcript on the
 * host. The other network-hook harnesses (codex, cline, opencode) POST *to*
 * Layman, which a net-restricted sandbox cannot reach, and persist nothing to
 * tail — monitoring those from a sandbox is a separate mechanism (a
 * glove-provided forwarder), not this source.
 */
export class GloveSource implements MonitorSource {
  readonly id = 'glove';
  private getSessionsDir: () => string | null;

  /** @param getSessionsDir resolves the current glove sessions dir, or null when disabled. */
  constructor(getSessionsDir: () => string | null) {
    this.getSessionsDir = getSessionsDir;
  }

  roots(): WatchRoot[] {
    const base = this.getSessionsDir();
    if (!base || !existsSync(base)) return [];

    let envs: string[];
    try {
      envs = readdirSync(base);
    } catch {
      return [];
    }

    const roots: WatchRoot[] = [];
    for (const env of envs) {
      const envDir = join(base, env);
      try {
        if (!statSync(envDir).isDirectory()) continue;
      } catch {
        continue; // vanished between readdir and stat
      }

      // Current glove: one home per session under `<env>/sessions/<name>/home`.
      const sessionHomes = this.sessionHomes(envDir, env);
      if (sessionHomes.length > 0) {
        for (const { home, label } of sessionHomes) this.probeHome(home, label, roots);
        continue;
      }

      // Legacy / `config_home_source` override: a single env-level `home/`.
      this.probeHome(join(envDir, 'home'), env, roots);
    }
    return roots;
  }

  /**
   * Per-session home dirs for an env: `<env>/sessions/<name>/home` for each
   * session subdir that has one, each labelled with glove's session token (the
   * env id for the default session named after the env, else `<env>-<name>`).
   * Empty when the env has no `sessions/` tree or no session home yet — the
   * caller then falls back to the env-level `home/`.
   */
  private sessionHomes(envDir: string, env: string): Array<{ home: string; label: string }> {
    const sessionsRoot = join(envDir, 'sessions');
    let names: string[];
    try {
      names = readdirSync(sessionsRoot);
    } catch {
      return []; // no sessions/ dir (or unreadable)
    }
    const homes: Array<{ home: string; label: string }> = [];
    for (const name of names) {
      const home = join(sessionsRoot, name, 'home');
      try {
        if (!statSync(home).isDirectory()) continue;
      } catch {
        continue;
      }
      homes.push({ home, label: name === env ? env : `${env}-${name}` });
    }
    return homes;
  }

  /** Probe a harness home for tailable Vibe and pi transcript dirs, appending roots. */
  private probeHome(home: string, label: string, roots: WatchRoot[]): void {
    const vibeDir = join(home, VIBE_SESSION_SUBPATH);
    if (existsSync(vibeDir)) {
      roots.push({ path: vibeDir, agentType: VIBE_AGENT_TYPE, label });
    }
    const piDir = join(home, PI_SESSION_SUBPATH);
    if (existsSync(piDir)) {
      roots.push({ path: piDir, agentType: PI_AGENT_TYPE, label });
    }
  }
}

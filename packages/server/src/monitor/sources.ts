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
 * parse (the watcher's format logic). Each root declares its `agentType`, so
 * one source can yield Vibe roots and pi roots; each passive watcher filters
 * `roots()` down to the agent type it knows how to parse.
 *
 * `roots()` is re-queried on every scan tick, so sources are dynamic: a glove
 * sandbox that appears or disappears mid-run is picked up or dropped on the next
 * scan without a restart.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { gloveExports, isDir, readSessionFacts } from '../glove/registry.js';
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
 * How long a `GloveSource.roots()` result is reused before `~/.glove` is read
 * again. The single shared instance feeds both passive watchers
 * (`VibeSessionWatcher` and `PiSessionWatcher`), each polling every ~2s, so
 * `roots()` is called about twice per scan tick against a read-only, FUSE-backed
 * bind mount on macOS. Memoizing for a window well under the scan interval
 * collapses those paired calls into one read while keeping discovery dynamic.
 */
export const GLOVE_ROOTS_TTL_MS = 1000;

/** glove's `harness` names → the Layman agent types whose transcripts a passive watcher parses. */
const GLOVE_HARNESS_AGENT: Record<string, string> = { pi: PI_AGENT_TYPE, vibe: VIBE_AGENT_TYPE };

/**
 * Sandboxed harness transcripts exported by glove v3 (github.com/castellotti/glove).
 *
 * A glove v3 session is a directory the user chose; its state is private to it.
 * The only transcripts Layman may read are the ones the session's **observe**
 * grant exports: with `transcripts: true`, glove bind-mounts
 * `~/.glove/observe/<id>/transcripts/` over the harness's transcript directory
 * (pi's `.pi/agent/sessions`, Vibe's `.vibe/logs/session`), so that export *is*
 * the transcript directory, in the layout the watchers already parse (pi's
 * per-cwd subdirectories such as `--work--/`, Vibe's per-session directories).
 * A session without the grant has no directory there and is never looked for
 * anywhere else.
 *
 * The harness comes from glove, never from the directory's layout: the registry
 * row's `harness`, else `session.json`'s. Harnesses without a passive watcher
 * (claude-code, whose transcripts glove does not export) yield no root.
 *
 * Each root is labelled with the session id, which is also the token in the
 * session's flow records, so Trace can join a transcript to its traffic. It
 * reads only what the sandbox already exported: no new mount, no egress,
 * nothing added to what the sandboxed agent can see.
 */
export class GloveSource implements MonitorSource {
  readonly id = 'glove';
  private cache: { at: number; roots: WatchRoot[] } | null = null;

  /**
   * @param getGloveHome resolves the glove home (`~/.glove`), or null when the extension is off.
   * @param now clock for the roots cache; injectable so tests can advance past the TTL.
   */
  constructor(private readonly getGloveHome: () => string | null, private readonly now: () => number = Date.now) {}

  roots(): WatchRoot[] {
    const at = this.now();
    if (this.cache && at - this.cache.at < GLOVE_ROOTS_TTL_MS) return this.cache.roots;
    const roots = this.scan();
    this.cache = { at, roots };
    return roots;
  }

  private scan(): WatchRoot[] {
    const home = this.getGloveHome();
    if (!home) return [];
    const roots: WatchRoot[] = [];
    for (const { id, dir, row } of gloveExports(home).exports) {
      const path = join(dir, 'transcripts');
      if (!isDir(path)) continue;
      const harness = row?.harness ?? readSessionFacts(join(dir, 'net'))?.harness ?? null;
      const agentType = harness ? GLOVE_HARNESS_AGENT[harness] : undefined;
      if (agentType) roots.push({ path, agentType, label: id });
    }
    return roots;
  }
}

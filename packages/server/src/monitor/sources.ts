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
 * glove runs each harness inside a container with a fake home persisted on the
 * host at `<sessionsDir>/<env-id>/home/`, mirroring the real dotfile layout.
 * So a gloved Vibe writes `<sessionsDir>/<env-id>/home/.vibe/logs/session/...`
 * and a gloved pi writes `<sessionsDir>/<env-id>/home/.pi/agent/sessions/...`
 * — exactly the layouts the passive watchers already understand, only rooted
 * elsewhere.
 *
 * This source globs one level of environment directories and returns a root for
 * each harness log tree it finds, labelled with the env id (`pi-local`) so its
 * sessions are tagged in the UI. A single sandbox may run both harnesses, so it
 * can yield a vibe root *and* a pi root. It reads only what the sandbox already
 * persisted: no new mount into the container, no egress, nothing added to what
 * the sandboxed agent can see — read-only "outside looking in".
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

    let sandboxes: string[];
    try {
      sandboxes = readdirSync(base);
    } catch {
      return [];
    }

    const roots: WatchRoot[] = [];
    for (const sandbox of sandboxes) {
      const sandboxDir = join(base, sandbox);
      try {
        if (!statSync(sandboxDir).isDirectory()) continue;
      } catch {
        continue; // vanished between readdir and stat
      }
      const vibeDir = join(sandboxDir, 'home', VIBE_SESSION_SUBPATH);
      if (existsSync(vibeDir)) {
        roots.push({ path: vibeDir, agentType: VIBE_AGENT_TYPE, label: sandbox });
      }
      const piDir = join(sandboxDir, 'home', PI_SESSION_SUBPATH);
      if (existsSync(piDir)) {
        roots.push({ path: piDir, agentType: PI_AGENT_TYPE, label: sandbox });
      }
    }
    return roots;
  }
}

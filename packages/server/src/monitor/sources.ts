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
 * parse (the watcher's format logic). Only Vibe is passive today, so every root
 * currently declares `agentType: 'mistral-vibe'`; a future passive harness adds
 * a parser branch in the watcher and a source here, and nothing else changes.
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
  /** Stable identifier, for logging (`'native'`, `'glove'`). */
  readonly id: string;
  /** Current set of roots. May change between calls; empty is valid. */
  roots(): WatchRoot[];
}

const VIBE_AGENT_TYPE = 'mistral-vibe';
/** Relative path from a home directory to the Vibe session-log dir. */
const VIBE_SESSION_SUBPATH = join('.vibe', 'logs', 'session');

/**
 * The native (non-sandboxed) Vibe logs — the historical single root. Tries the
 * Docker bind-mount path first, then the real host home, matching the watcher's
 * original `resolveSessionLogDir()`. Carries no label: native sessions are the
 * baseline the sandboxed ones are distinguished *from*.
 */
export class NativeVibeSource implements MonitorSource {
  readonly id = 'native';

  roots(): WatchRoot[] {
    const dockerPath = join('/root', VIBE_SESSION_SUBPATH);
    const hostPath = join(homedir(), VIBE_SESSION_SUBPATH);
    const path = existsSync(dockerPath) ? dockerPath : existsSync(hostPath) ? hostPath : null;
    if (!path) return [];
    return [{ path, agentType: VIBE_AGENT_TYPE }];
  }
}

/**
 * Sandboxed harness logs produced by glove (github.com/castellotti/glove).
 *
 * glove runs each harness inside a container with a fake home persisted on the
 * host at `<sessionsDir>/<sandbox>/home/`, mirroring the real dotfile layout.
 * So a gloved Vibe writes `<sessionsDir>/<sandbox>/home/.vibe/logs/session/...`
 * — exactly the layout the watcher already understands, only rooted elsewhere.
 *
 * This source globs one level of sandbox directories and returns a root for each
 * that actually contains Vibe logs, labelled with the sandbox name (`vibe-local`)
 * so its sessions are tagged in the UI. It reads only what the sandbox already
 * persisted: no new mount into the container, no egress, nothing added to what
 * the sandboxed agent can see — read-only "outside looking in".
 *
 * Only Vibe is discovered today. Network-hook harnesses (pi, codex, cline,
 * opencode) POST *to* Layman, which a net-restricted sandbox cannot reach, and
 * they persist no tailable transcript — monitoring those from a sandbox is a
 * separate mechanism (a glove-provided forwarder), not this source.
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
      const logDir = join(sandboxDir, 'home', VIBE_SESSION_SUBPATH);
      if (existsSync(logDir)) {
        roots.push({ path: logDir, agentType: VIBE_AGENT_TYPE, label: sandbox });
      }
    }
    return roots;
  }
}

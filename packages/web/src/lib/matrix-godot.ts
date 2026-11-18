/**
 * The Matrix (Godot) tab: the frame's address, and what the tab shows before it may start the engine
 * (docs/extensions/styx.md). Pure.
 */
import { MATRIX_WINDOWS, type MatrixWindow } from './matrix-feed.js';
import type { SchemeId } from './gibson-schemes.js';

/** The two views of the one styx-godot build, chosen by its `viz` parameter. */
export type GodotViz = 'matrix' | 'gibson';

/**
 * The page styx-godot's web export serves under Layman: a same-origin path, never an absolute URL.
 * `poll=2` makes it ask every two seconds for destinations it is not showing yet and add them at once;
 * `relative` and `session` are the feed's own parameters, which it validates itself.
 */
export function godotFrameSrc(input: { sessionId: string | null; window: MatrixWindow; viz?: GodotViz; scheme?: SchemeId }): string {
  let src = '/styx/godot/index.html?embed=1&api=/api/styx&poll=2';
  // The Matrix's address stays what it was: a build from before Gibson knows no `viz`, and the cache keys on it.
  if (input.viz === 'gibson') {
    src += '&viz=gibson';
    if (input.scheme) src += `&scheme=${encodeURIComponent(input.scheme)}`;
  }
  // As the other tabs: no session and All is the longest window the feed answers for every live session.
  const relative = MATRIX_WINDOWS.find((w) => w.id === input.window)?.relative ?? (input.sessionId ? null : '1d');
  if (relative) src += `&relative=${encodeURIComponent(relative)}`;
  if (input.sessionId) src += `&session=${encodeURIComponent(input.sessionId)}`;
  return src;
}

export type GodotTabState =
  /** The page is not a secure context: Godot's shell refuses to start. */
  | 'insecure'
  /** The build's status has not arrived. */
  | 'checking'
  /** No build in the folder (or one the status could not read). */
  | 'no-build'
  /** Motion is not Full: the engine is not started unless the user says so. */
  | 'motion-off'
  | 'run';

/** What the tab shows, most basic reason first: the engine starts only when none applies. */
export function godotTabState(input: {
  secure: boolean;
  /** `present` from the status, or null while it is unknown. */
  buildPresent: boolean | null;
  motionFull: boolean;
  runAnyway: boolean;
}): GodotTabState {
  if (!input.secure) return 'insecure';
  if (input.buildPresent === null) return 'checking';
  if (!input.buildPresent) return 'no-build';
  if (!input.motionFull && !input.runAnyway) return 'motion-off';
  return 'run';
}

/** How long a page may take to say which views it has before a build is taken to be too old. */
export const VIEWS_WAIT_MS = 15_000;

/**
 * What the frame's page reports (`window.styxViews`) against the view we asked for. A build from before
 * styx-godot knew Gibson ignores `viz` and shows the Matrix, and reports nothing, so a view that never
 * reports is a build without it. The Matrix is in every build.
 */
export function godotViewState(views: unknown, wanted: GodotViz, waitedMs: number): 'ok' | 'waiting' | 'missing' {
  if (wanted === 'matrix') return 'ok';
  if (Array.isArray(views)) return views.includes(wanted) ? 'ok' : 'missing';
  return waitedMs < VIEWS_WAIT_MS ? 'waiting' : 'missing';
}

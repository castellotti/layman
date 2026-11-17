/**
 * The Matrix (Godot) tab: the frame's address, and what the tab shows before it may start the engine
 * (docs/extensions/styx.md). Pure.
 */
import { MATRIX_WINDOWS, type MatrixWindow } from './matrix-feed.js';

/**
 * The page styx-godot's web export serves under Layman: a same-origin path, never an absolute URL.
 * `poll=2` makes it ask every two seconds for destinations it is not showing yet and add them at once;
 * `relative` and `session` are the feed's own parameters, which it validates itself.
 */
export function godotFrameSrc(input: { sessionId: string | null; window: MatrixWindow }): string {
  let src = '/styx/godot/index.html?embed=1&api=/api/styx&poll=2';
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

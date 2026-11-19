/**
 * The one session every session tab shows (Logs, Activity, Matrix, Gibson) and the Network tabs follow.
 * Pure. A selection is a Layman session (`activeSessionId`) or, for a glove session that has had no
 * prompt yet, the glove itself (`awaitingGlove`): pi writes its transcript only at the first prompt, so
 * until then glove knows the session and Layman has no session to name. When its first Layman session
 * appears the selection moves to it, and the passive watcher replays it from the first prompt.
 */
import type { SessionInfo } from './ws-protocol.js';
import { newestSession } from './session-state.js';
import { pickSession } from './activity-view.js';

export interface Selection {
  activeSessionId: string | null;
  awaitingGlove: string | null;
}

/** The newest Layman session of a glove session (a gloved session's `sessionName` is its glove id), or null. */
export function gloveLaymanSession(token: string, sessions: readonly SessionInfo[]): string | null {
  return newestSession(sessions.filter((s) => s.sessionName === token))?.sessionId ?? null;
}

/** Choosing a glove session: its newest Layman session, else the glove itself, waiting for its first prompt. */
export function selectGlove(token: string, sessions: readonly SessionInfo[]): Selection {
  const id = gloveLaymanSession(token, sessions);
  return id ? { activeSessionId: id, awaitingGlove: null } : { activeSessionId: null, awaitingGlove: token };
}

/**
 * The glove sessions the header's picker lists beside Layman's, in the order given: live ones with no
 * Layman session yet, and the awaited one even when it is not live (so the picker can show its value).
 */
export function awaitingGloves(
  gloves: readonly { token: string; live: boolean }[],
  sessions: readonly SessionInfo[],
  awaiting: string | null,
): string[] {
  const named = new Set(sessions.map((s) => s.sessionName).filter((n): n is string => !!n));
  const out = gloves.filter((g) => g.live && !named.has(g.token)).map((g) => g.token);
  if (awaiting && !out.includes(awaiting) && !named.has(awaiting)) out.push(awaiting);
  return out;
}

/** The header picker's value for a glove waiting for its first prompt (a Layman session id never starts so). */
export const GLOVE_OPTION_PREFIX = 'glove:';

/**
 * What a session tab shows: the open Layman session, else a glove waiting for its first prompt, else the
 * newest live session (`pickSession`, as before). Never both: an awaited glove is not overruled by the fallback.
 */
export function viewTarget(
  activeSessionId: string | null, awaitingGlove: string | null, sessions: readonly SessionInfo[],
): { sessionId: string | null; glove: string | null } {
  if (activeSessionId) return { sessionId: activeSessionId, glove: null };
  if (awaitingGlove) return { sessionId: null, glove: awaitingGlove };
  return { sessionId: pickSession(null, sessions), glove: null };
}

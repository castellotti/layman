import { useSessionStore } from '../stores/sessionStore.js';
import { useNetStore } from '../stores/netStore.js';
import { getSessionDisplayName } from '../lib/session-state.js';
import { viewTarget } from '../lib/session-selection.js';

/**
 * The session a Styx tab (Matrix, Gibson) shows: `feedId` is what its feed's `session=` takes (a Layman
 * session id, or a glove id before the glove's first prompt, which the server reads as `glove=`), `title`
 * the bar's words, and `gloveToken` the glove its cards open Network on.
 */
export function useStyxSession(): { feedId: string | null; title: string; gloveToken: string | null } {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const awaitingGlove = useSessionStore((s) => s.awaitingGlove);
  const sessions = useSessionStore((s) => s.sessions);
  const { sessionId, glove } = viewTarget(activeSessionId, awaitingGlove, sessions);
  const session = sessionId ? sessions.find((x) => x.sessionId === sessionId) : undefined;
  const name = session?.sessionName ?? glove;
  const gloveToken = useNetStore((s) => (name && s.sessions.some((x) => x.token === name) ? name : null));
  const title = session ? getSessionDisplayName(session) : glove ? `${glove} · waiting for first prompt` : 'All live sessions';
  return { feedId: sessionId ?? glove, title, gloveToken };
}

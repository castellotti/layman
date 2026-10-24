/**
 * "Network for this turn": opens the Topology tab on the turn's glove session over the turn's
 * time range (`lib/turn-range.ts`). Shown only for a session glove sandboxed. The span is worked
 * out when the button is clicked, so a long live session does not recompute every turn's on
 * every event.
 */
import React from 'react';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { TURN_RANGE_TIP, turnRange, turnSpan, type TurnSpan } from '../../lib/turn-range.js';
import type { TimelineEvent } from '../../lib/types.js';
import { NetIcon } from './netui.js';
import { tipProps } from './NetTip.js';

/**
 * The glove session a Layman session ran in (its name is the glove token), or null. `name` is
 * the session's name where the caller knows it (a recorded session no longer in the live list).
 */
export function useGloveToken(sessionId: string | null | undefined, name?: string | null): string | null {
  const live = useSessionStore((s) => (sessionId ? s.sessions.find((x) => x.sessionId === sessionId)?.sessionName ?? null : null));
  const n = live ?? name ?? null;
  // Only a session Layman may read: a not-observable one has no traffic to show.
  return useNetStore((s) => (n && s.sessions.some((x) => x.token === n) ? n : null));
}

/** Whether a glove session's gate is running: what decides that a turn without an answer still runs. */
export const gloveLive = (token: string) => useNetStore.getState().sessions.some((s) => s.token === token && s.live);

/** A turn's span from the server, which has all its events and knows whether it is the last. */
export async function fetchTurnSpan(token: string, sessionId: string, promptEventId: string): Promise<TurnSpan | null> {
  const r = await fetch(`/api/turns/${encodeURIComponent(sessionId)}/${encodeURIComponent(promptEventId)}?events=1`);
  if (!r.ok) return null;
  const { events, last } = await r.json() as { events: TimelineEvent[]; last: boolean };
  return turnSpan(events, { last, live: gloveLive(token) });
}

export function NetworkForTurn({ token, span, size = 11, onOpen }: {
  token: string;
  span: () => TurnSpan | null | Promise<TurnSpan | null>;
  size?: number;
  /** Before the tab opens: Trace keeps the turn it showed. */
  onOpen?: () => void;
}) {
  const open = async () => {
    const s = await span();
    if (!s) return;
    onOpen?.();
    useSessionStore.getState().showNetworkRange(token, turnRange(s));
  };
  return (
    <button type="button" data-network-for-turn="" aria-label="Network for this turn"
      onClick={(e) => { e.stopPropagation(); void open(); }}
      {...tipProps({ heading: 'Network for this turn', body: `Opens Topology for ${token}, showing only the traffic during this turn. ${TURN_RANGE_TIP}` })}
      style={{ display: 'inline-flex', alignItems: 'center', padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', flexShrink: 0 }}>
      <NetIcon name="globe" size={size} />
    </button>
  );
}

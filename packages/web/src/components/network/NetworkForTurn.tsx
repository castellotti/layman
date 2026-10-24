/**
 * "Network for this turn": opens the Topology tab on the turn's glove session over the turn's
 * time range (`lib/turn-range.ts`). Shown only for a session glove sandboxed.
 */
import React from 'react';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { turnRange, turnRangeTip, type TurnSpan } from '../../lib/turn-range.js';
import { NetIcon } from './netui.js';
import { tipProps } from './NetTip.js';

/** The glove session a Layman session ran in (its name is the glove token), or null. */
export function useGloveToken(sessionId: string | null | undefined): string | null {
  const name = useSessionStore((s) => (sessionId ? s.sessions.find((x) => x.sessionId === sessionId)?.sessionName ?? null : null));
  return useNetStore((s) => (name && (s.sessions.some((x) => x.token === name) || s.notObservable.some((x) => x.token === name)) ? name : null));
}

export function NetworkForTurn({ token, span, size = 11 }: { token: string; span: TurnSpan; size?: number }) {
  return (
    <button type="button" data-network-for-turn="" aria-label="Network for this turn"
      onClick={(e) => { e.stopPropagation(); useSessionStore.getState().showNetworkRange(token, turnRange(span)); }}
      {...tipProps({ heading: 'Network for this turn', body: `Opens Topology for ${token}, showing only the traffic during this turn. ${turnRangeTip(span)}` })}
      style={{ display: 'inline-flex', alignItems: 'center', padding: 2, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-faint)', flexShrink: 0 }}>
      <NetIcon name="globe" size={size} />
    </button>
  );
}

import React, { useMemo } from 'react';
import type { HostRow } from '../../lib/gibson-feed.js';
import { TONE_WORDS, toneOf } from '../../lib/gibson-city.js';
import type { MatrixRow } from '../../lib/matrix-feed.js';

/** A tower as the Matrix card wants it: the card was written for a `MatrixRow`, and says what these say. */
export const cardRow = (h: HostRow): MatrixRow => ({
  address: h.host, sent: h.sent, received: h.received, count: Math.max(1, h.count), blocked: h.blocked, untunnelled: h.untunnelled,
});

/** The scene in words, for a screen reader: every tower with how often it was reached and its state. Hidden to the eye. */
export function GibsonHostList({ hosts }: { hosts: readonly HostRow[] }) {
  const tones = useMemo(() => new Map(hosts.map((h) => [h.host, TONE_WORDS[toneOf(h)]])), [hosts]);
  return (
    <ul style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
      {hosts.map((h) => {
        const words = tones.get(h.host);
        return <li key={h.host}>{h.host}, reached {h.count} {h.count === 1 ? 'time' : 'times'}{words ? `, ${words}` : ''}</li>;
      })}
    </ul>
  );
}

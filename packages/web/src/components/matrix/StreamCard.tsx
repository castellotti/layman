import React from 'react';
import type { MatrixRow } from '../../lib/matrix-feed.js';
import { formatBytes } from '../../lib/net-format.js';
import { rad, sp } from '../../lib/density.js';

/** What the pointer is on: an address and where, in the renderer's box. Pinned once clicked. */
export interface Hover { address: string; x: number; y: number; pinned: boolean }

/** How many destinations the hidden list names for screen readers. */
export const TOP_LIST = 20;

/** The card for the stream under the pointer, shared by the Matrix 2D and 3D tabs. A pinned card offers Open in Network for a sandboxed session. */
export function StreamCard({ hover, row, box, gloveToken, onOpenNetwork }: {
  hover: Hover;
  row: MatrixRow;
  box: { width: number; height: number };
  gloveToken: string | null;
  onOpenNetwork: (token: string, address: string) => void;
}) {
  return (
    <div
      data-print-hide
      style={{
        position: 'absolute', left: Math.min(hover.x + 14, Math.max(0, box.width - 260)), top: Math.min(hover.y + 14, Math.max(0, box.height - 130)),
        maxWidth: 250, padding: sp('6px 10px'), borderRadius: rad(6), background: 'var(--bg-raised)', color: 'var(--text-body)',
        border: 'var(--stroke) solid var(--border-strong)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5,
        pointerEvents: hover.pinned ? 'auto' : 'none',
      }}
    >
      <div style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{row.address}</div>
      <div>reached {row.count} {row.count === 1 ? 'time' : 'times'}</div>
      <div>sent {formatBytes(row.sent)} · received {formatBytes(row.received)}</div>
      {row.blocked > 0 && <div style={{ color: 'var(--error)' }}>refused by glove ({row.blocked})</div>}
      {row.untunnelled && <div style={{ color: 'var(--warn)' }}>not through the tunnel</div>}
      {gloveToken && hover.pinned && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenNetwork(gloveToken, row.address); }}
          style={{ marginTop: sp(4), padding: sp('2px 8px'), borderRadius: rad(4), background: 'transparent', color: 'var(--accent)', border: 'var(--stroke) solid var(--border-strong)', cursor: 'pointer', fontSize: 11 }}
        >
          Open in Network
        </button>
      )}
    </div>
  );
}

/** The destinations as text a screen reader can reach, since the canvas is a picture. */
export function TopList({ rows }: { rows: readonly MatrixRow[] }) {
  return (
    <ul style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
      {rows.slice(0, TOP_LIST).map((r) => <li key={r.address}>{r.address}, reached {r.count} {r.count === 1 ? 'time' : 'times'}</li>)}
    </ul>
  );
}

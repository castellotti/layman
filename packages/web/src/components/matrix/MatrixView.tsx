import React from 'react';
import { useSessionStore, type ViewMode } from '../../stores/sessionStore.js';
import { useNetStore } from '../../stores/netStore.js';
import { pickSession } from '../../lib/activity-view.js';
import { getSessionDisplayName } from '../../lib/session-state.js';
import { DEFAULT_MATRIX_WINDOW, MATRIX_WINDOWS, parseMatrixWindow, type MatrixWindow } from '../../lib/matrix-feed.js';
import { useStored } from '../../hooks/useStored.js';
import { useMatrixFeed } from '../../hooks/useMatrixFeed.js';
import { openNetwork } from '../../lib/open-network.js';
import { formatBytes } from '../../lib/net-format.js';
import { rad, sp } from '../../lib/density.js';
import { MatrixCanvas2D } from './MatrixCanvas2D.js';
import { MatrixCanvas3D } from './MatrixCanvas3D.js';
import { GodotFrame } from './GodotFrame.js';

export const MATRIX_WINDOW_KEY = 'layman.matrix.window';

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: sp(24), textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
      {children}
    </div>
  );
}

/** "Nothing reached in the last 15 minutes. Try a longer window." */
const WINDOW_PHRASE: Record<MatrixWindow, string> = { '1m': 'the last minute', '15m': 'the last 15 minutes', '1h': 'the last hour', all: 'this session' };

/**
 * The Matrix views of Styx: the bar (the session, a window picker, a count) over the renderer for the
 * tab. The session is the one open in the app, else the newest live one (as Activity); with none, every
 * live session together.
 */
export default function MatrixView({ mode }: { mode: ViewMode }) {
  const enabled = useSessionStore((s) => s.config?.styx?.enabled === true);
  if (!enabled) {
    return <Centered>Styx is turned off. Turn it on in Settings → Extensions → Styx → Matrix views.</Centered>;
  }
  return <MatrixPane mode={mode} />;
}

/** The bar and the canvas of 2D or 3D. Its own component so the feed is read only while this tab is open. */
function MatrixPane({ mode }: { mode: ViewMode }) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionId = pickSession(activeSessionId, sessions);
  const session = sessions.find((x) => x.sessionId === sessionId);
  const [window, setWindow] = useStored<MatrixWindow>(MATRIX_WINDOW_KEY, DEFAULT_MATRIX_WINDOW, parseMatrixWindow);
  const { rows, loading, error } = useMatrixFeed(sessionId, window);
  const gloveToken = useNetStore((s) => (session?.sessionName && s.sessions.some((x) => x.token === session.sessionName) ? session.sessionName : null));

  const down = rows.reduce((n, r) => n + r.received, 0);
  const title = session ? getSessionDisplayName(session) : 'All live sessions';
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: sp(12), padding: sp('6px 16px'), flexShrink: 0, borderBottom: 'var(--stroke) solid var(--border)', fontSize: 12, color: 'var(--text-body)' }}
      >
        <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <div data-print-hide role="group" aria-label="Window" style={{ display: 'flex', gap: sp(2) }}>
          {MATRIX_WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              aria-pressed={window === w.id}
              onClick={() => setWindow(w.id)}
              style={{
                padding: sp('2px 8px'), borderRadius: rad(4), cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)',
                color: window === w.id ? 'var(--text)' : 'var(--text-muted)',
                background: window === w.id ? 'var(--bg-raised)' : 'transparent',
                border: 'var(--stroke) solid var(--border)',
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {rows.length} {rows.length === 1 ? 'destination' : 'destinations'}{down > 0 ? ` · ${formatBytes(down)} down` : ''}
        </span>
      </div>
      {mode === 'matrix' ? (
        // The frame reads the feed itself; the bar's count above is this page's own read.
        <GodotFrame sessionId={sessionId} window={window} />
      ) : loading ? (
        <Centered>Reading the feed…</Centered>
      ) : (
        // Mounted even with nothing to show: its streams and what it knows live in it, and an empty answer
        // or a failed poll must not make every host start again, or the next new one look old.
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
          {mode === 'matrix3d' ? (
            <MatrixCanvas3D
              rows={rows} ready resetKey={`${sessionId ?? ''}|${window}`} gloveToken={gloveToken} onOpenNetwork={openNetwork}
              onUse2D={() => useSessionStore.getState().setViewMode('matrix2d')}
            />
          ) : (
            <MatrixCanvas2D rows={rows} ready resetKey={`${sessionId ?? ''}|${window}`} gloveToken={gloveToken} onOpenNetwork={openNetwork} />
          )}
          {rows.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', pointerEvents: 'none' }}>
              <Centered>
                {error ? `The feed could not be read: ${error}` : `Nothing reached in ${WINDOW_PHRASE[window]}.${window === 'all' ? '' : ' Try a longer window.'}`}
              </Centered>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

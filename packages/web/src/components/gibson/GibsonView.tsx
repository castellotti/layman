import React from 'react';
import { useSessionStore, type ViewMode } from '../../stores/sessionStore.js';
import { pickSession } from '../../lib/activity-view.js';
import { getSessionDisplayName } from '../../lib/session-state.js';
import { DEFAULT_MATRIX_WINDOW, MATRIX_WINDOWS, parseMatrixWindow, type MatrixWindow } from '../../lib/matrix-feed.js';
import { DEFAULT_SCHEME, SCHEMES, parseScheme, type SchemeId } from '../../lib/gibson-schemes.js';
import { useStored } from '../../hooks/useStored.js';
import { useGibsonFeed } from '../../hooks/useGibsonFeed.js';
import { formatBytes } from '../../lib/net-format.js';
import { rad, sp } from '../../lib/density.js';

export const GIBSON_WINDOW_KEY = 'layman.gibson.window';
export const GIBSON_SCHEME_KEY = 'layman.gibson.scheme';

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: sp(24), textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
      {children}
    </div>
  );
}

/** A group of toggle buttons in the bar: one pressed. */
function Picker<T extends string>({ label, options, value, onPick }: {
  label: string; options: ReadonlyArray<{ id: T; label: string }>; value: T; onPick: (id: T) => void;
}) {
  return (
    <div data-print-hide role="group" aria-label={label} style={{ display: 'flex', gap: sp(2) }}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          onClick={() => onPick(o.id)}
          style={{
            padding: sp('2px 8px'), borderRadius: rad(4), cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-mono)',
            color: value === o.id ? 'var(--text)' : 'var(--text-muted)',
            background: value === o.id ? 'var(--bg-raised)' : 'transparent',
            border: 'var(--stroke) solid var(--border)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The Gibson views of Styx: the bar (the session, a window picker, a scheme picker, a count) over the
 * renderer for the tab. The session is the one open in the app, else the newest live one (as the Matrix);
 * with none, every live session together.
 */
export default function GibsonView({ mode }: { mode: ViewMode }) {
  const enabled = useSessionStore((s) => s.config?.styx?.enabled === true);
  if (!enabled) {
    return <Centered>Styx is turned off. Turn it on in Settings → Extensions → Styx → Matrix views.</Centered>;
  }
  return <GibsonPane mode={mode} />;
}

/** The bar and the tab. Its own component so the feed is read only while this tab is open. */
function GibsonPane({ mode }: { mode: ViewMode }) {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionId = pickSession(activeSessionId, sessions);
  const session = sessions.find((x) => x.sessionId === sessionId);
  const [window, setWindow] = useStored<MatrixWindow>(GIBSON_WINDOW_KEY, DEFAULT_MATRIX_WINDOW, parseMatrixWindow);
  const [scheme, setScheme] = useStored<SchemeId>(GIBSON_SCHEME_KEY, DEFAULT_SCHEME, parseScheme);
  const { hosts } = useGibsonFeed(sessionId, window);

  const down = hosts.reduce((n, h) => n + h.received, 0);
  const blocks = new Set(hosts.map((h) => h.block)).size;
  const title = session ? getSessionDisplayName(session) : 'All live sessions';

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: sp(12), padding: sp('6px 16px'), flexShrink: 0, borderBottom: 'var(--stroke) solid var(--border)', fontSize: 12, color: 'var(--text-body)' }}
      >
        <span style={{ color: 'var(--text)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        <Picker label="Window" options={MATRIX_WINDOWS} value={window} onPick={setWindow} />
        <Picker label="Scheme" options={SCHEMES} value={scheme} onPick={setScheme} />
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {hosts.length} {hosts.length === 1 ? 'tower' : 'towers'} · {blocks} {blocks === 1 ? 'block' : 'blocks'}{down > 0 ? ` · ${formatBytes(down)} down` : ''}
        </span>
      </div>
      {mode === 'gibson' ? (
        <Centered>The Gibson tab, the styx-godot build in a frame, is not built yet.</Centered>
      ) : mode === 'gibson3d' ? (
        <Centered>Gibson 3D is not built yet.</Centered>
      ) : (
        <Centered>Gibson 2D is not built yet.</Centered>
      )}
    </div>
  );
}

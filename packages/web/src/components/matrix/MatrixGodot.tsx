import React, { useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { godotFrameSrc, godotTabState } from '../../lib/matrix-godot.js';
import type { MatrixWindow } from '../../lib/matrix-feed.js';
import { motionIsFull } from '../../lib/theme-runtime.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';
import { useMatrixGodotStatus } from '../../hooks/useMatrixGodotStatus.js';
import { rad, sp } from '../../lib/density.js';

const SRC_DEBOUNCE_MS = 500;
/** How long after the page loads the engine may still take focus on its own. */
const FOCUS_GUARD_MS = 30_000;

const MAKE = 'make styx-godot-build';

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: sp(24) }}>
      <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: sp(10), color: 'var(--text-body)', fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

function Button({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ padding: sp('4px 10px'), borderRadius: rad(5), cursor: 'pointer', fontSize: 12, color: 'var(--text)', background: 'var(--bg-raised)', border: 'var(--stroke) solid var(--border-strong)' }}
    >
      {children}
    </button>
  );
}

/**
 * The Matrix (Godot) tab: styx-godot's own web export, running its shaders, in a frame. The build is
 * the user's, made locally and served by Layman under a policy that lets it talk to Layman only. What is
 * shown instead of the frame is decided by `godotTabState`; this only renders it.
 *
 * Unmounting removes the frame, which stops the engine: it is never kept alive hidden, where it would
 * render at full rate behind another view.
 */
export function MatrixGodot({ sessionId, window: range }: { sessionId: string | null; window: MatrixWindow }) {
  const { status, error, refresh } = useMatrixGodotStatus(true);
  const [runAnyway, setRunAnyway] = useState(false);
  useThemeVersion(); // Motion is applied with the theme: re-ask when it changes.
  const state = godotTabState({
    secure: typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : true,
    buildPresent: status ? status.present : error ? false : null,
    motionFull: motionIsFull(),
    runAnyway,
  });

  // A change of session or window reloads the engine, so a step through several sessions waits.
  const wanted = godotFrameSrc({ sessionId, window: range });
  const [src, setSrc] = useState(wanted);
  useEffect(() => {
    if (wanted === src) return;
    const t = setTimeout(() => setSrc(wanted), SRC_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [wanted, src]);

  const [loading, setLoading] = useState(true);
  useEffect(() => setLoading(true), [src]);
  const frame = useRef<HTMLIFrameElement>(null);
  const pointerIn = useRef(false);
  const onLoad = () => {
    setLoading(false);
    pointerIn.current = false;
    // The page loads first and the engine starts seconds later, focusing its canvas as it does
    // (`focus_canvas_on_start`), and Layman's shortcuts stop while a frame has focus. So keep handing
    // focus back for a while, until the pointer comes into the frame: after that it is the user's.
    const until = Date.now() + FOCUS_GUARD_MS;
    const t = setInterval(() => {
      if (pointerIn.current || Date.now() > until || !frame.current) return clearInterval(t);
      if (document.activeElement === frame.current) {
        frame.current.blur();
        window.focus();
      }
    }, 200);
    stopGuard.current?.();
    stopGuard.current = () => clearInterval(t);
  };
  const stopGuard = useRef<(() => void) | null>(null);
  useEffect(() => () => stopGuard.current?.(), []);

  if (state === 'insecure') {
    const go = (mode: 'matrix2d' | 'matrix3d') => useSessionStore.getState().setViewMode(mode);
    return (
      <Note>
        <span>
          The Godot view needs a secure page: open Layman as <code style={{ fontFamily: 'var(--font-mono)' }}>http://localhost:8880</code> on
          this machine, or serve it over HTTPS. Matrix 2D and Matrix 3D work here.
        </span>
        <div style={{ display: 'flex', gap: sp(8) }}>
          <Button onClick={() => go('matrix2d')}>Matrix 2D</Button>
          <Button onClick={() => go('matrix3d')}>Matrix 3D</Button>
        </div>
      </Note>
    );
  }
  if (state === 'checking') return <Note><span style={{ color: 'var(--text-faint)' }}>Looking for the Godot build…</span></Note>;
  if (state === 'no-build') {
    return (
      <Note>
        <strong style={{ color: 'var(--text)' }}>This tab needs a local build of styx-godot.</strong>
        <span>
          It shows the real styx-godot
          scene, shaders included, fed by this session. Layman does not ship it: export its &ldquo;Web (Layman)&rdquo; preset
          and Layman serves the folder.
        </span>
        <span>Looking in: <code style={{ fontFamily: 'var(--font-mono)' }}>{status?.dir ?? '(unknown)'}</code></span>
        <span>Build it with <code style={{ fontFamily: 'var(--font-mono)' }}>{MAKE}</code> in Layman&rsquo;s repository (see docs/extensions/styx.md).</span>
        {error && <span style={{ color: 'var(--warn)' }}>The status could not be read: {error}</span>}
        {status?.problems.map((p) => <span key={p} style={{ color: 'var(--warn)' }}>{p}</span>)}
        <div><Button onClick={refresh}>Check again</Button></div>
      </Note>
    );
  }
  if (state === 'motion-off') {
    return (
      <Note>
        <span>Motion is off (Settings → Motion), so the Godot scene is not started: it draws at full rate.</span>
        <div><Button onClick={() => setRunAnyway(true)}>Run anyway</Button></div>
      </Note>
    );
  }
  return (
    <div onPointerEnter={() => { pointerIn.current = true; }} style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      <iframe
        ref={frame}
        key={src}
        src={src}
        title="Styx Matrix (Godot)"
        sandbox="allow-scripts allow-same-origin"
        allow=""
        onLoad={onLoad}
        style={{ border: 0, width: '100%', height: '100%', background: 'var(--bg)' }}
      />
      {loading && (
        <div style={{ position: 'absolute', top: sp(8), left: sp(12), fontSize: 12, color: 'var(--text-muted)', pointerEvents: 'none' }}>Starting Godot…</div>
      )}
    </div>
  );
}

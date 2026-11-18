import React, { useEffect, useRef, useState } from 'react';
import { useSessionStore, type ViewMode } from '../../stores/sessionStore.js';
import { godotFrameSrc, godotTabState, godotViewState, type GodotViz } from '../../lib/matrix-godot.js';
import type { SchemeId } from '../../lib/gibson-schemes.js';
import type { MatrixWindow } from '../../lib/matrix-feed.js';
import { motionIsFull } from '../../lib/theme-runtime.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';
import { useMatrixGodotStatus } from '../../hooks/useMatrixGodotStatus.js';
import { rad, sp } from '../../lib/density.js';

const SRC_DEBOUNCE_MS = 500;
/** How long after the page loads the engine may still take focus on its own. */
const FOCUS_GUARD_MS = 30_000;
/** How often a Gibson frame is asked which views its page has, until it has said. */
const VIEWS_POLL_MS = 1000;

const TITLES: Record<GodotViz, string> = { matrix: 'Styx Matrix (Godot)', gibson: 'Styx Gibson (Godot)' };

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
 * The Godot tabs (Matrix and Gibson): styx-godot's own web export, running its shaders, in a frame. The build is
 * the user's, made locally and served by Layman under a policy that lets it talk to Layman only. What is
 * shown instead of the frame is decided by `godotTabState`; this only renders it.
 *
 * One build serves both tabs, chosen by `viz`. A build from before Gibson ignores `viz` and shows the Matrix,
 * so for Gibson the page is asked (`window.styxViews`, same origin) and a build without the view is said so.
 *
 * Unmounting removes the frame, which stops the engine: it is never kept alive hidden, where it would
 * render at full rate behind another view.
 */
export function GodotFrame({ viz = 'matrix', sessionId, window: range, scheme }: {
  viz?: GodotViz; sessionId: string | null; window: MatrixWindow; scheme?: SchemeId;
}) {
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
  const wanted = godotFrameSrc({ sessionId, window: range, viz, scheme });
  const [src, setSrc] = useState(wanted);
  useEffect(() => {
    if (wanted === src) return;
    const t = setTimeout(() => setSrc(wanted), SRC_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [wanted, src]);

  const [loading, setLoading] = useState(true);
  const [views, setViews] = useState<'ok' | 'waiting' | 'missing'>('ok');
  // Bumped by "Check again": a new frame, which asks its page again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { setLoading(true); setViews(viz === 'matrix' ? 'ok' : 'waiting'); }, [src, attempt, viz]);
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

    stopViews.current?.();
    if (viz === 'matrix') return;
    // The page says which views it has once the engine is up, seconds after `load`.
    const since = Date.now();
    const poll = setInterval(() => {
      let reported: unknown;
      try { reported = (frame.current?.contentWindow as (Window & { styxViews?: unknown }) | null)?.styxViews; } catch { reported = undefined; }
      const state = godotViewState(reported, viz, Date.now() - since);
      setViews(state);
      if (state !== 'waiting') clearInterval(poll);
    }, VIEWS_POLL_MS);
    stopViews.current = () => clearInterval(poll);
  };
  const stopGuard = useRef<(() => void) | null>(null);
  const stopViews = useRef<(() => void) | null>(null);
  useEffect(() => () => { stopGuard.current?.(); stopViews.current?.(); }, []);

  const go = (mode: ViewMode) => useSessionStore.getState().setViewMode(mode);
  const names = viz === 'gibson' ? (['Gibson 2D', 'Gibson 3D'] as const) : (['Matrix 2D', 'Matrix 3D'] as const);
  const modes: readonly ViewMode[] = viz === 'gibson' ? ['gibson2d', 'gibson3d'] : ['matrix2d', 'matrix3d'];

  if (state === 'insecure') {
    return (
      <Note>
        <span>
          The Godot view needs a secure page: open Layman as <code style={{ fontFamily: 'var(--font-mono)' }}>http://localhost:8880</code> on
          this machine, or serve it over HTTPS. {names[0]} and {names[1]} work here.
        </span>
        <div style={{ display: 'flex', gap: sp(8) }}>
          <Button onClick={() => go(modes[0])}>{names[0]}</Button>
          <Button onClick={() => go(modes[1])}>{names[1]}</Button>
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
        <div style={{ display: 'flex', gap: sp(8) }}>
          <Button onClick={() => setRunAnyway(true)}>Run anyway</Button>
          <Button onClick={() => go(modes[0])}>{names[0]}</Button>
          <Button onClick={() => go(modes[1])}>{names[1]}</Button>
        </div>
      </Note>
    );
  }
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {views === 'missing' && (
        <div
          role="status"
          style={{ display: 'flex', alignItems: 'center', gap: sp(12), padding: sp('6px 16px'), flexShrink: 0, fontSize: 12, color: 'var(--warn)', borderBottom: 'var(--stroke) solid var(--border)' }}
        >
          <span>
            This build of styx-godot has no Gibson view. Update styx-godot and run <code style={{ fontFamily: 'var(--font-mono)' }}>{MAKE}</code>.
          </span>
          <Button onClick={() => { refresh(); setAttempt((n) => n + 1); }}>Check again</Button>
        </div>
      )}
      <div onPointerEnter={() => { pointerIn.current = true; }} style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        <iframe
          ref={frame}
          key={`${src}|${attempt}`}
          src={src}
          title={TITLES[viz]}
          sandbox="allow-scripts allow-same-origin"
          allow=""
          onLoad={onLoad}
          style={{ border: 0, width: '100%', height: '100%', background: 'var(--bg)' }}
        />
        {loading && (
          <div style={{ position: 'absolute', top: sp(8), left: sp(12), fontSize: 12, color: 'var(--text-muted)', pointerEvents: 'none' }}>Starting Godot…</div>
        )}
      </div>
    </div>
  );
}

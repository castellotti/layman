import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MatrixRow } from '../../lib/matrix-feed.js';
import { hash01, planStreams, type Stream } from '../../lib/matrix-rain.js';
import {
  LAYERS, NEAR, gridOf, packColumns, packText, pick, rowsOf, streamsKey,
} from '../../lib/matrix-gpu.js';
import { HEX_COLOR, luminance, rgbOf } from '../../lib/color.js';
import { motionIsFull, readToken } from '../../lib/theme-runtime.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { rad, sp } from '../../lib/density.js';
import { createScene, type Scene, type SceneColours } from './matrix3d-gl.js';
import { StreamCard, TopList, type Hover } from './StreamCard.js';

/** The nearest layers drawn: 3 is the data plane alone (phase A); 0 is all four. */
const FIRST_LAYER = NEAR;
/** The simulation's step: new streams start and finished ones end at most this late. */
const PLAN_MS = 50;
/** The most the backing store may exceed CSS pixels by: crisp enough, far cheaper than a retina's 2-3×. */
const MAX_DPR = 1.5;

function readColours(): SceneColours {
  const bg = readToken('bg');
  return {
    bg: rgbOf(bg), rain: rgbOf(readToken('ok')), head: rgbOf(readToken('text'), [1, 1, 1]), fresh: rgbOf(readToken('accent-hot')),
    blocked: rgbOf(readToken('error')), untunnelled: rgbOf(readToken('warn')),
    light: HEX_COLOR.test(bg) && luminance(bg) > 0.5,
  };
}

type Problem = 'no-webgl2' | 'failed';

interface Api {
  rows(): void;
  size(): void;
  theme(): void;
  loop(): void;
}

/**
 * The Matrix 3D renderer: raw WebGL2, one full-screen triangle, the picture computed in the fragment shader
 * from two small textures that change only when a stream starts or ends (`matrix-gpu.ts`). A frame uploads a
 * few uniforms and nothing else; what falls is `planStreams`, as in 2D. Not in motion (reduced or off, or a
 * hidden page) it draws one still frame and redraws only when the data, size or theme changes.
 */
export function MatrixCanvas3D({ rows, ready, resetKey, gloveToken, onOpenNetwork, onUse2D }: {
  rows: MatrixRow[];
  /** The rows are the answer for `resetKey`, not a placeholder while it loads. */
  ready: boolean;
  /** Session and window: a change of either forgets what is falling and what is known. */
  resetKey: string;
  gloveToken: string | null;
  onOpenNetwork: (token: string, address: string) => void;
  /** Switch to the 2D tab (the fallback without WebGL2). */
  onUse2D: () => void;
}) {
  const [boxRef, box] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeVersion = useThemeVersion();
  const [hover, setHover] = useState<Hover | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const api = useRef<Api | null>(null);
  const rowsRef = useRef(rows);
  const readyRef = useRef(ready);
  const boxRef2 = useRef(box);
  const full = motionIsFull();
  const fullRef = useRef(full);
  const resetRef = useRef(resetKey);
  const byAddress = useMemo(() => new Map(rows.map((r) => [r.address, r])), [rows]);
  /** What the pointer tests against: the streams as packed, by layer, and the time and epoch they were drawn at. */
  const shown = useRef<Stream[][]>(Array.from({ length: LAYERS }, () => []));
  const clock = useRef({ t: 0, epoch: 0 });
  const hoverRef = useRef<Hover | null>(null);
  hoverRef.current = hover;

  rowsRef.current = rows;
  readyRef.current = ready;
  boxRef2.current = box;
  fullRef.current = full;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const epoch = performance.now();
    clock.current.epoch = epoch;
    let scene: Scene | null = null;
    let raf = 0;
    let lastPlan = -Infinity;
    let planned: Stream[] = [];
    let lastKey = '';
    let colours: SceneColours | null = null;
    let columns: Float32Array | null = null;
    let text: Uint8Array | null = null;
    let known: Set<string> | null = null;
    const lastColumn = new Map<string, number>();
    let seenReset = resetRef.current;

    const aspect = () => boxRef2.current.width / Math.max(1, boxRef2.current.height);

    const upload = () => {
      if (!scene) return;
      if (columns) scene.setColumns(columns);
      if (text) scene.setText(text);
    };

    /** Plan what falls; true when the set of streams changed (and the textures were rewritten). */
    const plan = (now: number): boolean => {
      if (resetRef.current !== seenReset) { seenReset = resetRef.current; planned = []; known = null; lastColumn.clear(); lastKey = ''; }
      const g = gridOf(aspect(), NEAR);
      // A still frame does not age: a new answer must not expire its streams and deal them out again.
      planned = planStreams({
        rows: rowsRef.current, columns: g.data, visibleRows: Math.ceil(rowsOf(NEAR)), now: fullRef.current ? now : epoch,
        current: planned, lastColumn, known, rand: Math.random,
      });
      for (const s of planned) lastColumn.set(s.address, s.column);
      // What the screen has been given. Not before the answer is in, or its first rows would all be new.
      if (readyRef.current) known = new Set([...(known ?? []), ...rowsRef.current.map((r) => r.address)]);
      let layers: Stream[][] = Array.from({ length: LAYERS }, () => []);
      layers[NEAR] = planned;
      if (!fullRef.current) {
        // A still frame: each stream's text at a place from a hash of its address, the clock at 0.
        layers = layers.map((l, layer) => l.map((s) => {
          const rowsShown = Math.ceil(rowsOf(layer));
          const top = Math.floor(hash01(s.address) * Math.max(1, rowsShown - s.text.length));
          return { ...s, startAt: epoch - (1000 * (top + s.text.length - 0.5)) / s.speed };
        }));
      }
      const key = streamsKey(layers);
      if (key === lastKey) return false;
      lastKey = key;
      shown.current = layers;
      columns = packColumns(layers, epoch);
      text = packText(layers);
      upload();
      return true;
    };

    const time = () => (fullRef.current ? (performance.now() - epoch) / 1000 : 0);
    const draw = () => {
      if (!scene) return;
      const t = time();
      clock.current.t = t;
      scene.draw(t);
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - lastPlan >= PLAN_MS) { lastPlan = now; plan(now); }
      draw();
    };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const loop = () => {
      stop();
      if (!scene) return;
      if (fullRef.current && document.visibilityState === 'visible') {
        raf = requestAnimationFrame(frame);
      } else {
        lastKey = '';
        plan(performance.now());
        draw();
      }
    };

    const theme = () => {
      colours = readColours();
      scene?.setColours(colours);
      scene?.setFont(readToken('font-mono'));
      if (!raf) draw();
    };
    const size = () => {
      const b = boxRef2.current;
      if (!scene || b.width === 0 || b.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      canvas.width = Math.floor(b.width * dpr);
      canvas.height = Math.floor(b.height * dpr);
      scene.resize(canvas.width, canvas.height);
      lastKey = '';
      plan(performance.now());
      if (!raf) draw();
    };

    /** Every GL object, from one place: also what a restored context calls. */
    const create = (restored: boolean) => {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
      if (!gl) { setProblem('no-webgl2'); return; }
      try {
        scene = createScene(gl, FIRST_LAYER);
      } catch (e) {
        console.error(e);
        setProblem('failed');
        return;
      }
      setProblem(null);
      upload();
      // At mount the effects below do these; after a lost context nothing else would.
      if (restored) { theme(); size(); loop(); }
    };

    const onLost = (e: Event) => { e.preventDefault(); stop(); scene = null; };
    const onRestored = () => create(true);
    const onVisible = () => loop();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    document.addEventListener('visibilitychange', onVisible);
    create(false);

    api.current = {
      rows: () => { if (plan(performance.now()) && !raf) draw(); },
      size, theme, loop,
    };
    return () => {
      api.current = null;
      stop();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVisible);
      scene?.destroy();
      scene = null;
    };
  }, []);

  // New rows: plan at once, so a new address does not wait for the next step.
  useEffect(() => { api.current?.rows(); }, [rows, ready]);
  useEffect(() => { resetRef.current = resetKey; api.current?.rows(); }, [resetKey]);
  useEffect(() => { api.current?.size(); }, [box.width, box.height]);
  useEffect(() => { api.current?.theme(); }, [themeVersion]);
  useEffect(() => { api.current?.loop(); }, [full]);

  /** The stream under the pointer, with the pointer's place in the box. */
  const streamAt = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const s = pick([x / Math.max(1, rect.width), y / Math.max(1, rect.height)], clock.current.t, box.width / Math.max(1, box.height), shown.current, clock.current.epoch);
    return { s, x, y };
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (hoverRef.current?.pinned) return;
    const { s, x, y } = streamAt(e);
    if (!s) { if (hoverRef.current) setHover(null); return; }
    if (hoverRef.current?.address === s.address) return;
    setHover({ address: s.address, x, y, pinned: false });
  };
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const { s, x, y } = streamAt(e);
    if (!s || hover?.pinned) { setHover(null); return; }
    setHover({ address: s.address, x, y, pinned: true });
  };

  const card = hover ? byAddress.get(hover.address) : undefined;

  return (
    <div
      ref={boxRef}
      onPointerMove={onMove}
      onPointerLeave={() => { if (!hoverRef.current?.pinned) setHover(null); }}
      onClick={onClick}
      style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${rows.length} destinations falling as text`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: problem ? 'none' : 'block' }}
      />
      <TopList rows={rows} />
      {problem && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: sp(10), color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: sp(24) }}>
          <div>{problem === 'no-webgl2' ? 'This browser has no WebGL2. Matrix 2D shows the same data.' : 'Matrix 3D could not start on this browser. Matrix 2D shows the same data.'}</div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUse2D(); }}
            style={{ padding: sp('4px 12px'), borderRadius: rad(4), background: 'transparent', color: 'var(--accent)', border: 'var(--stroke) solid var(--border-strong)', cursor: 'pointer', fontSize: 12 }}
          >
            Show Matrix 2D
          </button>
        </div>
      )}
      {hover && card && <StreamCard hover={hover} row={card} box={box} gloveToken={gloveToken} onOpenNetwork={onOpenNetwork} />}
    </div>
  );
}

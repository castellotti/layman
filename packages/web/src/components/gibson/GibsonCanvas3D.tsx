import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostRow, LinkRow, LogRow } from '../../lib/gibson-feed.js';
import { pagesOf } from '../../lib/gibson-city.js';
import {
  MAX_PAGES, boundOf, cityKey, invert, lookFrom, moved, multiply, overhead, packPages, packTowers, perspective,
  pickTower3d, rayThrough, turned, type FlyCam, type Mat4,
} from '../../lib/gibson-gpu.js';
import { paletteOf, type Palette, type SchemeId } from '../../lib/gibson-schemes.js';
import { motionIsFull, readToken } from '../../lib/theme-runtime.js';
import { rad, sp } from '../../lib/density.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { useGibsonCity } from '../../hooks/useGibsonCity.js';
import { StreamCard, type Hover } from '../matrix/StreamCard.js';
import { CAR_STRIDE, MAX_ARRIVALS, BOARD_MARGIN, createScene, type Scene } from './gibson3d-gl.js';
import { GibsonHostList, cardRow } from './GibsonHostList.js';

/** The backing store may exceed CSS pixels by at most this: crisp enough, far cheaper than a retina's 2-3×. */
const MAX_DPR = 1.5;
const FOV = 1.0472;
const NEAR = 0.1;
const FAR = 900;
/** A press that moves farther than this is a drag, not a click. */
const DRAG_PX = 4;
/** Look: radians per pixel dragged (0.25°). */
const LOOK = (0.25 * Math.PI) / 180;
/** Flying: world units per second, tripled with Shift. */
const SPEED = 12;
/** One wheel notch moves this fraction of the camera's height, but at least `NOTCH_MIN`. */
const NOTCH = 0.08;
const NOTCH_MIN = 1.5;

type Problem = 'no-webgl2' | 'failed';

/** The keys that fly: the letters and the arrows. */
const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

interface Latest {
  towers: Float32Array;
  chips: Float32Array;
  half: number;
  pages: Uint8Array;
  pal: Palette;
  font: string;
}

interface Api {
  /** Upload what changed since the last call, and draw once if no loop is running. */
  sync(): void;
  loop(): void;
  /** Fly for `dt` seconds with the keys held (a still scene calls it once per key press). */
  nudge(dt: number): void;
  draw(): void;
}

/**
 * The Gibson 3D renderer: raw WebGL2, the city of `lib/gibson-city.ts` (the same placement, towers, traffic and pages
 * as Gibson 2D) in perspective, with a camera the user flies. The GPU data (instance buffer, page texture) is
 * rewritten only when the city changes (`cityKey`); a frame uploads the camera, the clock, the arrivals and the cars.
 * Not in motion (reduced or off, or a hidden page) it draws once and redraws only when the data, size, scheme or the
 * camera changes.
 */
export function GibsonCanvas3D({ hosts, links, resetKey, scheme, selected, onSelect, log, gloveToken, onOpenNetwork, onUse2D, failed = false }: {
  hosts: readonly HostRow[];
  links: readonly LinkRow[];
  /** Session and window: a change of either forgets who stands where and what is known. */
  resetKey: string;
  scheme: SchemeId;
  selected: string | null;
  onSelect: (host: string | null) => void;
  /** The selected tower's log: its faces gain these lines. */
  log: readonly LogRow[];
  gloveToken: string | null;
  onOpenNetwork: (token: string, address: string) => void;
  /** Switch to the 2D tab (the fallback without WebGL2). */
  onUse2D: () => void;
  /** The feed's first answer failed: there is nothing to know yet, so the next real one must not look all new. */
  failed?: boolean;
}) {
  const [sizeRef, box] = useElementSize<HTMLDivElement>();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // One stable callback: an inline one would be called with null and the node at every render.
  const mount = useCallback((node: HTMLDivElement | null) => { sizeRef(node); setEl(node); }, [sizeRef]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const themeVersion = useThemeVersion();
  const full = motionIsFull();
  const [hover, setHover] = useState<Hover | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const { city, freshAt, arrivedAt, traffic } = useGibsonCity({ hosts, links, resetKey, failed, beatArrivals: false });
  const pal = useMemo(() => paletteOf(scheme, readToken), [scheme, themeVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const font = useMemo(() => readToken('font-mono') || 'monospace', [themeVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The renderer's clock starts here: shaders get seconds since, never `Date.now()`. */
  const epoch = useRef(performance.now());

  // Each tower's page, and the texture they pack into. Rewritten when a line changes (a host's age ticks on).
  const pageLines = useMemo(() => pagesOf(hosts, selected, log), [hosts, selected, log]);
  // The age line (`SEEN 3S AGO`) is left out and refreshed every 10 s instead, or every poll would rewrite the texture.
  const pagesSig = useMemo(() => {
    const age = Math.floor(Date.now() / 10_000);
    const body = city.towers.map((t) => (pageLines.get(t.host) ?? []).filter((l) => !l.startsWith('SEEN ')).join('\n')).join('\u0001');
    return `${age}|${body}`;
  }, [city, pageLines]);
  const packed = useMemo(() => {
    const towers = city.towers.slice(0, MAX_PAGES);
    const { data, rows } = packPages(towers.map((t) => pageLines.get(t.host) ?? []));
    const index = new Map(towers.map((t, i) => [t.host, i]));
    const length = new Map(towers.map((t, i) => [t.host, rows[i]]));
    return { data, index, length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesSig]);

  // The instance buffer: rewritten when the city changed in a way that shows, not on every poll or beat.
  const key = cityKey(city, selected, log.length, `${scheme}|${themeVersion}|${full}|${pagesSig.length}`);
  const gpu = useMemo(() => {
    const rise = new Map<string, number>();
    if (full) {
      const now = Date.now();
      const clock = (performance.now() - epoch.current) / 1000;
      for (const [host, at] of freshAt) rise.set(host, clock - (now - at) / 1000);
    }
    const chips = new Float32Array(city.chips.length * 2);
    city.chips.forEach((c, i) => { chips[i * 2] = c.x; chips[i * 2 + 1] = c.z; });
    return { towers: packTowers(city, pal, selected, packed.index, packed.length, rise), chips, half: city.extent + BOARD_MARGIN };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, packed]);

  const latest = useRef<Latest | null>(null);
  latest.current = { towers: gpu.towers, chips: gpu.chips, half: gpu.half, pages: packed.data, pal, font };
  const cityRef = useRef(city);
  cityRef.current = city;
  const linksRef = useRef(links);
  linksRef.current = links;
  const palRef = useRef(pal);
  palRef.current = pal;
  const fullRef = useRef(full);
  fullRef.current = full;
  const boxRef = useRef(box);
  boxRef.current = box;
  const tower0 = useMemo(() => new Map(city.towers.map((t, i) => [t.host, i])), [city]);
  const indexRef = useRef(tower0);
  indexRef.current = tower0;

  // The camera and what steers it.
  const cam = useRef<FlyCam>(overhead(24));
  const placed = useRef(false);
  const keys = useRef(new Set<string>());
  const shift = useRef(false);
  const api = useRef<Api | null>(null);
  const populated = city.towers.length > 0;
  useEffect(() => { placed.current = false; setHover(null); }, [resetKey]);
  useEffect(() => {
    if (placed.current || !populated) return;
    placed.current = true;
    cam.current = overhead(cityRef.current.extent);
    api.current?.sync();
  }, [populated, resetKey]);

  const viewOf = (): { viewProj: Mat4; aspect: number } => {
    const b = boxRef.current;
    const aspect = b.width / Math.max(1, b.height);
    return { viewProj: multiply(perspective(FOV, aspect, NEAR, FAR), lookFrom(cam.current.pos, cam.current.yaw, cam.current.pitch)), aspect };
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: Scene | null = null;
    let raf = 0;
    let last = 0;
    let uploaded: { towers?: Float32Array; chips?: Float32Array; pages?: Uint8Array; pal?: Palette; font?: string; w?: number; h?: number } = {};
    const cars = new Float32Array(96 * CAR_STRIDE);
    const arrivals = new Float32Array(MAX_ARRIVALS * 2);

    const time = (): number => (fullRef.current ? (performance.now() - epoch.current) / 1000 : 0);

    const draw = (carCount = 0, arrivalCount = 0): void => {
      const b = boxRef.current;
      if (!scene || !latest.current || b.width === 0 || b.height === 0) return;
      const { viewProj, aspect } = viewOf();
      const sky = invert(multiply(perspective(FOV, aspect, NEAR, FAR), lookFrom([0, 0, 0], cam.current.yaw, cam.current.pitch)));
      if (!sky) return;
      const p = palRef.current;
      scene.draw({
        time: time(), viewProj, invSky: sky, eye: cam.current.pos, cars, carCount, arrivals, arrivalCount,
        flash: p.marks ? p.fresh : p.glass.blocked,
      });
    };

    const sync = (): void => {
      const l = latest.current;
      const b = boxRef.current;
      if (!scene || !l || b.width === 0 || b.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.floor(b.width * dpr);
      const h = Math.floor(b.height * dpr);
      if (uploaded.w !== w || uploaded.h !== h) {
        canvas.width = w;
        canvas.height = h;
        scene.resize(w, h);
        uploaded.w = w;
        uploaded.h = h;
      }
      if (uploaded.font !== l.font) { scene.setFont(l.font); uploaded.font = l.font; }
      if (uploaded.pal !== l.pal) { scene.setPalette(l.pal); uploaded.pal = l.pal; }
      if (uploaded.towers !== l.towers || uploaded.chips !== l.chips) { scene.setCity(l.towers, l.chips, l.half); uploaded.towers = l.towers; uploaded.chips = l.chips; }
      if (uploaded.pages !== l.pages) { scene.setPages(l.pages); uploaded.pages = l.pages; }
      if (!raf) draw();
    };

    /** The cars as the shader reads them, and the arrivals (tower index, start time). */
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - (last || now)) / 1000);
      last = now;
      if (keys.current.size > 0) nudge(dt);
      const live = traffic.current.step(dt, linksRef.current, cityRef.current);
      const stamp = Date.now();
      for (const host of traffic.current.arrivals()) arrivedAt.current.set(host, stamp);
      const p = palRef.current;
      const n = Math.min(live.length, 96);
      for (let i = 0; i < n; i++) {
        const c = live[i];
        const colour = p.traffic ?? p.glass[c.tone];
        const o = i * CAR_STRIDE;
        cars[o] = c.x; cars[o + 1] = c.z; cars[o + 2] = c.dx; cars[o + 3] = c.dz;
        cars[o + 4] = colour[0]; cars[o + 5] = colour[1]; cars[o + 6] = colour[2]; cars[o + 7] = c.flash;
      }
      let a = 0;
      const clock = (performance.now() - epoch.current) / 1000;
      for (const [host, at] of arrivedAt.current) {
        const idx = indexRef.current.get(host);
        if (idx === undefined || a >= MAX_ARRIVALS) continue;
        arrivals[a * 2] = idx;
        arrivals[a * 2 + 1] = clock - (stamp - at) / 1000;
        a++;
      }
      draw(n, a);
    };
    const stop = (): void => { cancelAnimationFrame(raf); raf = 0; };
    const loop = (): void => {
      stop();
      if (!scene) return;
      if (fullRef.current && document.visibilityState === 'visible') { last = 0; raf = requestAnimationFrame(frame); } else draw();
    };

    /** Fly for `dt` seconds with the keys held. */
    function nudge(dt: number): void {
      const k = keys.current;
      const v = SPEED * dt * (shift.current ? 3 : 1);
      const right = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
      const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
      const up = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
      if (right === 0 && fwd === 0 && up === 0) return;
      cam.current = moved(cam.current, right * v, up * v, fwd * v, boundOf(cityRef.current.extent));
      if (!raf) draw();
    }

    const create = (restored: boolean): void => {
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
      if (!gl) { setProblem('no-webgl2'); return; }
      try {
        scene = createScene(gl);
      } catch (e) {
        console.error(e);
        setProblem('failed');
        return;
      }
      setProblem(null);
      uploaded = {};
      sync();
      if (restored) loop();
    };

    const onLost = (e: Event): void => { e.preventDefault(); stop(); scene = null; };
    const onRestored = (): void => create(true);
    const onVisible = (): void => loop();
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    document.addEventListener('visibilitychange', onVisible);
    create(false);
    api.current = { sync, loop, nudge, draw: () => draw() };
    loop();
    return () => {
      api.current = null;
      stop();
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      document.removeEventListener('visibilitychange', onVisible);
      scene?.dispose();
      scene = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { api.current?.sync(); }, [gpu, packed, pal, font, box.width, box.height]);
  useEffect(() => { api.current?.loop(); }, [full]);

  // The wheel flies along the view. A native listener, because React's wheel is passive and could not stop the page scrolling.
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      // A notch is 100 px; Firefox's line mode reports about 3 lines, and a page mode 1.
      const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 800 : 1);
      const notches = -Math.max(-300, Math.min(300, px)) / 100;
      const step = Math.max(NOTCH_MIN, NOTCH * cam.current.pos[1]) * notches;
      cam.current = moved(cam.current, 0, 0, step, boundOf(cityRef.current.extent));
      api.current?.sync();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el]);

  const press = useRef<{ x: number; y: number; lx: number; ly: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  /** The tower under a point of the canvas (CSS px), by a ray through the box. */
  const towerAt = (x: number, y: number) => {
    const b = boxRef.current;
    if (b.width === 0 || b.height === 0) return null;
    const inv = invert(viewOf().viewProj);
    if (!inv) return null;
    const { origin, dir } = rayThrough(inv, (x / b.width) * 2 - 1, 1 - (y / b.height) * 2);
    return pickTower3d(origin, dir, cityRef.current.towers);
  };

  // Hover is one pick per frame, however many moves arrive.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const pickQueued = useRef(0);
  const queueHover = (x: number, y: number): void => {
    pointer.current = { x, y };
    if (pickQueued.current) return;
    pickQueued.current = requestAnimationFrame(() => {
      pickQueued.current = 0;
      const p = pointer.current;
      if (!p || press.current) return;
      const t = towerAt(p.x, p.y);
      // Not `if (hover)`: two moves can arrive before a render, and a test of the stale value would leave the card behind.
      if (!t) { setHover(null); return; }
      setHover({ address: t.host, x: p.x, y: p.y, pinned: false });
    });
  };
  useEffect(() => () => { if (pickQueued.current) cancelAnimationFrame(pickQueued.current); }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    press.current = { x, y, lx: x, ly: y, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    // A release that never arrived (ctrl+click's context menu, a touch cancel) must not leave the camera following the pointer.
    if (press.current && e.buttons === 0) press.current = null;
    const p = press.current;
    if (p) {
      if (!p.moved && Math.hypot(x - p.x, y - p.y) > DRAG_PX) p.moved = true;
      if (p.moved) {
        setHover(null);
        cam.current = turned(cam.current, (x - p.lx) * LOOK, -(y - p.ly) * LOOK);
        api.current?.sync();
      }
      p.lx = x;
      p.ly = y;
      return;
    }
    queueHover(x, y);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const p = press.current;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!p || p.moved) return;
    const { x, y } = local(e);
    onSelect(towerAt(x, y)?.host ?? null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // Browser zoom, Back and the like are not ours.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { if (selected) { e.stopPropagation(); onSelect(null); } return; }
    const k = e.key.toLowerCase();
    if (!FLY_KEYS.has(k)) return;
    // The header's shortcuts listen on the window: D, S and A would switch tabs under a flying camera.
    e.preventDefault();
    e.stopPropagation();
    shift.current = e.shiftKey;
    keys.current.add(k);
    // A still scene has no frame loop: each press (and its auto-repeat) is one step.
    if (!fullRef.current) api.current?.nudge(0.08);
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    shift.current = e.shiftKey;
    keys.current.delete(e.key.toLowerCase());
  };

  const hovered = hover ? hosts.find((h) => h.host === hover.address) : undefined;

  return (
    <div
      ref={mount}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { press.current = null; }}
      onLostPointerCapture={() => { press.current = null; }}
      onPointerLeave={() => { pointer.current = null; setHover(null); }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={() => { keys.current.clear(); }}
      style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--bg)', touchAction: 'none', cursor: hover ? 'pointer' : 'grab', outline: 'none' }}
    >
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${hosts.length} destinations drawn as towers on a city of blocks, in 3D`}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: problem ? 'none' : 'block' }}
      />
      <GibsonHostList hosts={hosts} />
      {problem && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: sp(10), color: 'var(--text-faint)', fontSize: 13, textAlign: 'center', padding: sp(24) }}>
          <div>{problem === 'no-webgl2' ? 'This browser has no WebGL2. Gibson 2D shows the same data.' : 'Gibson 3D could not start on this browser. Gibson 2D shows the same data.'}</div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUse2D(); }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ padding: sp('4px 12px'), borderRadius: rad(4), background: 'transparent', color: 'var(--accent)', border: 'var(--stroke) solid var(--border-strong)', cursor: 'pointer', fontSize: 12 }}
          >
            Show Gibson 2D
          </button>
        </div>
      )}
      {hover && hovered && !press.current?.moved && (
        <StreamCard hover={hover} row={cardRow(hovered)} box={box} gloveToken={gloveToken} onOpenNetwork={onOpenNetwork} />
      )}
    </div>
  );
}

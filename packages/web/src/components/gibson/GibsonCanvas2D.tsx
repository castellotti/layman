import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostRow, LinkRow, LogRow } from '../../lib/gibson-feed.js';
import {
  EMPTY_PLACEMENT, TONE_WORDS, buildCity, createTraffic, pageOf, place, toneOf, type Placement,
} from '../../lib/gibson-city.js';
import { fitCam, pickTower, zoomAt, type Cam } from '../../lib/gibson-2d.js';
import { paletteOf, type SchemeId } from '../../lib/gibson-schemes.js';
import type { MatrixRow } from '../../lib/matrix-feed.js';
import { motionIsFull, readToken } from '../../lib/theme-runtime.js';
import { sp, rad } from '../../lib/density.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';
import { useElementSize } from '../../hooks/useElementSize.js';
import { StreamCard, type Hover } from '../matrix/StreamCard.js';
import { ARRIVAL_MS, FRESH_MS, drawCars, drawCity } from './gibson2d-draw.js';

/** A press that moves farther than this is a drag, not a click. */
const DRAG_PX = 4;
/** Arrow keys pan by this much; `+` and `-` zoom by the wheel's step. */
const KEY_PAN_PX = 40;
const ZOOM_STEP = 1.1;
/** The beat of what has a clock but no data: a fresh tower's rise and fade, an arrival's glow. */
const BEAT_MS = 100;

/** A tower as the Matrix card wants it: the card was written for a `MatrixRow`, and says what these say. */
const cardRow = (h: HostRow): MatrixRow => ({
  address: h.host, sent: h.sent, received: h.received, count: Math.max(1, h.count), blocked: h.blocked, untunnelled: h.untunnelled,
});

/**
 * The Gibson 2D renderer: the city drawn plan-oblique on two stacked canvases. The city canvas (board, streets,
 * traces, chips, towers, labels) is redrawn only when something changed, never per frame; the traffic canvas above it
 * is redrawn every frame while motion is full. The geometry and the content are `lib/gibson-2d.ts` and
 * `lib/gibson-city.ts`, the looks are `gibson2d-draw.ts`; this holds the state that must outlive a refresh
 * (placement, what is known, the camera, the traffic) and the pointer.
 */
export function GibsonCanvas2D({ hosts, links, resetKey, scheme, selected, onSelect, log, gloveToken, onOpenNetwork }: {
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
}) {
  const [sizeRef, box] = useElementSize<HTMLDivElement>();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // One stable callback: an inline one would be called with null and the node at every render.
  const mount = useCallback((node: HTMLDivElement | null) => { sizeRef(node); setEl(node); }, [sizeRef]);
  const cityCanvas = useRef<HTMLCanvasElement | null>(null);
  const trafficCanvas = useRef<HTMLCanvasElement | null>(null);
  const themeVersion = useThemeVersion();
  const full = motionIsFull();
  const [tick, setTick] = useState(0);
  const [cam, setCam] = useState<Cam | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  // What outlives a refresh. Reset at render, so the answer for a new key is never placed on the old one's streets.
  const kept = useRef({ key: resetKey, placement: EMPTY_PLACEMENT as Placement, known: null as Set<string> | null, freshAt: new Map<string, number>() });
  if (kept.current.key !== resetKey) kept.current = { key: resetKey, placement: EMPTY_PLACEMENT, known: null, freshAt: new Map() };
  const arrivedAt = useRef(new Map<string, number>());
  const traffic = useRef(createTraffic());
  const userCam = useRef(false);

  const placement = useMemo(() => {
    const st = kept.current;
    st.placement = place(st.placement, hosts, links);
    // `known` is null until the first answer for this key, so nothing is fresh on the first draw.
    if (st.known === null) st.known = new Set(hosts.map((h) => h.host));
    else for (const h of hosts) if (!st.known.has(h.host)) { st.known.add(h.host); st.freshAt.set(h.host, Date.now()); }
    return st.placement;
  }, [hosts, links, resetKey]);

  // `tick` is in the dependencies: it is how a clock (a rise, a fresh colour ending) rebuilds the city.
  const city = useMemo(() => {
    const now = Date.now();
    const fresh = new Set<string>();
    for (const [h, at] of kept.current.freshAt) if (now - at < FRESH_MS) fresh.add(h);
    return buildCity(placement, hosts, links, fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placement, hosts, links, tick]);

  const pal = useMemo(() => paletteOf(scheme, readToken), [scheme, themeVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const font = useMemo(() => readToken('font-mono') || 'monospace', [themeVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const h of hosts) m.set(h.host, pageOf(h, h.host === selected ? log : undefined));
    return m;
  }, [hosts, selected, log]);

  const camRef = useRef(cam);
  camRef.current = cam;
  const cityRef = useRef(city);
  cityRef.current = city;
  const linksRef = useRef(links);
  linksRef.current = links;
  const palRef = useRef(pal);
  palRef.current = pal;
  const hostsRef = useRef(hosts);
  hostsRef.current = hosts;

  // A new session or window: the camera, the traffic and what a car reached belong to the last one.
  useEffect(() => {
    userCam.current = false;
    setCam(null);
    setHover(null);
    arrivedAt.current = new Map();
    traffic.current = createTraffic();
  }, [resetKey]);

  // Fit the first city and a resized box, until the user takes the camera: the city growing must not move the picture.
  const populated = city.towers.length > 0;
  useEffect(() => {
    if (box.width === 0 || box.height === 0 || userCam.current) return;
    const c = cityRef.current;
    setCam(fitCam(c.extent, c.towers.reduce((m, t) => Math.max(m, t.height), 0), box.width, box.height));
  }, [box.width, box.height, populated, resetKey]);

  // The clocks: while something is fresh or brightening, redraw the city every beat, and once more when it ends.
  useEffect(() => {
    let was = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      for (const [h, at] of kept.current.freshAt) if (now - at >= FRESH_MS) kept.current.freshAt.delete(h);
      for (const [h, at] of arrivedAt.current) if (now - at >= ARRIVAL_MS) arrivedAt.current.delete(h);
      const on = kept.current.freshAt.size > 0 || arrivedAt.current.size > 0;
      if (on || was) setTick((n) => n + 1);
      was = on;
    }, BEAT_MS);
    return () => clearInterval(timer);
  }, []);

  // The city canvas.
  useEffect(() => {
    const canvas = cityCanvas.current;
    if (!canvas || !cam || box.width === 0 || box.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(box.width * dpr);
    const h = Math.floor(box.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    drawCity(ctx, {
      width: box.width, height: box.height, dpr, cam, city, placement, links, pal, font, selected, pages,
      now: Date.now(), freshAt: kept.current.freshAt, arrivedAt: arrivedAt.current, full,
    });
  }, [city, cam, box.width, box.height, placement, links, pal, font, selected, pages, full, themeVersion]);

  // The traffic canvas: a frame per animation frame while motion is full and the tab is shown; nothing otherwise.
  const ready = cam !== null;
  useEffect(() => {
    const canvas = trafficCanvas.current;
    if (!canvas || box.width === 0 || box.height === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(box.width * dpr);
    canvas.height = Math.floor(box.height * dpr);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!full || !ready) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (document.visibilityState !== 'visible') { last = now; return; }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const cars = traffic.current.step(dt, linksRef.current, cityRef.current);
      const stamp = Date.now();
      for (const host of traffic.current.arrivals()) arrivedAt.current.set(host, stamp);
      if (camRef.current) drawCars(ctx, { width: box.width, height: box.height, dpr, cam: camRef.current, pal: palRef.current, cars });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [full, ready, box.width, box.height]);

  // The wheel zooms about the pointer. A native listener, because React's wheel is passive and could not stop the page scrolling.
  useEffect(() => {
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      const c = camRef.current;
      if (!c) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      userCam.current = true;
      setCam(zoomAt(c, e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [el]);

  const press = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const local = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const towerAt = (x: number, y: number) => (camRef.current ? pickTower(camRef.current, cityRef.current.towers, x, y) : null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !camRef.current) return;
    const { x, y } = local(e);
    press.current = { x, y, cx: camRef.current.cx, cy: camRef.current.cy, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const { x, y } = local(e);
    const p = press.current;
    if (p && camRef.current) {
      if (!p.moved && Math.hypot(x - p.x, y - p.y) > DRAG_PX) p.moved = true;
      if (p.moved) {
        userCam.current = true;
        setHover(null);
        setCam({ ...camRef.current, cx: p.cx + (x - p.x), cy: p.cy + (y - p.y) });
      }
      return;
    }
    const t = towerAt(x, y);
    // Not `if (hover)`: two moves can arrive before a render, and a test of the stale value would leave the card behind.
    if (!t) { setHover(null); return; }
    setHover({ address: t.host, x, y, pinned: false });
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
    const c = camRef.current;
    if (e.key === 'Escape') { if (selected) { e.stopPropagation(); onSelect(null); } return; }
    if (!c) return;
    const pan: Record<string, [number, number]> = { ArrowLeft: [KEY_PAN_PX, 0], ArrowRight: [-KEY_PAN_PX, 0], ArrowUp: [0, KEY_PAN_PX], ArrowDown: [0, -KEY_PAN_PX] };
    const move = pan[e.key];
    if (move) {
      e.preventDefault();
      e.stopPropagation();
      userCam.current = true;
      setCam({ ...c, cx: c.cx + move[0], cy: c.cy + move[1] });
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault();
      e.stopPropagation();
      userCam.current = true;
      setCam(zoomAt(c, box.width / 2, box.height / 2, e.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP));
    }
  };

  const fit = (): void => {
    userCam.current = false;
    const c = cityRef.current;
    if (box.width > 0 && box.height > 0) setCam(fitCam(c.extent, c.towers.reduce((m, t) => Math.max(m, t.height), 0), box.width, box.height));
  };

  const hovered = hover ? hosts.find((h) => h.host === hover.address) : undefined;
  const tonesOf = useMemo(() => new Map(hosts.map((h) => [h.host, TONE_WORDS[toneOf(h)]])), [hosts]);

  return (
    <div
      ref={mount}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={onKeyDown}
      style={{ position: 'relative', flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--bg)', touchAction: 'none', cursor: hover ? 'pointer' : 'grab' }}
    >
      <canvas
        ref={cityCanvas}
        role="img"
        aria-label={`${hosts.length} destinations drawn as towers on a city of blocks`}
        style={{ position: 'absolute', left: 0, top: 0, width: box.width, height: box.height }}
      />
      <canvas ref={trafficCanvas} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: box.width, height: box.height, pointerEvents: 'none' }} />
      <ul style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {hosts.map((h) => {
          const words = tonesOf.get(h.host);
          return <li key={h.host}>{h.host}, reached {h.count} {h.count === 1 ? 'time' : 'times'}{words ? `, ${words}` : ''}</li>;
        })}
      </ul>
      <button
        type="button"
        data-print-hide
        onPointerDown={(e) => e.stopPropagation()}
        onClick={fit}
        style={{
          position: 'absolute', left: sp(12), bottom: sp(12), padding: sp('2px 8px'), borderRadius: rad(4), cursor: 'pointer', fontSize: 11,
          fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', background: 'var(--bg-raised)', border: 'var(--stroke) solid var(--border)',
        }}
      >
        Fit
      </button>
      {hover && hovered && !press.current?.moved && (
        <StreamCard hover={hover} row={cardRow(hovered)} box={box} gloveToken={gloveToken} onOpenNetwork={onOpenNetwork} />
      )}
    </div>
  );
}

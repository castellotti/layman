import React, { useRef, useCallback, useEffect } from 'react';
import type { TimelineEvent } from '../../lib/types.js';
import { EVENT_KIND_COLOR } from '../../lib/event-styles.js';
import { getThemeVersion, readToken } from '../../lib/theme-runtime.js';
import type { Token } from '../../lib/tokens.js';
import { useThemeVersion } from '../../hooks/useThemeVersion.js';

const CANVAS_W = 12;
const TICK_H = 4;

// Canvas 2D cannot read `var(--x)` (a fillStyle it cannot parse is a silent no-op that keeps the
// previous colour), so each tick's token is resolved to its value with `readToken`. The values are
// cached for one theme: the cache is dropped when the theme version changes, and the component
// redraws then because the version is in `draw`'s dependencies.
const resolved = new Map<Token, string>();
let resolvedFor = -1;

function resolveToken(token: Token): string {
  if (resolvedFor !== getThemeVersion()) {
    resolved.clear();
    resolvedFor = getThemeVersion();
  }
  let value = resolved.get(token);
  if (value === undefined) {
    value = typeof document !== 'undefined' ? readToken(token) : '';
    resolved.set(token, value);
  }
  return value;
}

function tickColor(type: string, highlighted: boolean): string {
  return resolveToken(highlighted ? 'warn' : EVENT_KIND_COLOR[type] ?? 'border-strong');
}

interface MinimapProps {
  events: TimelineEvent[];
  scrollRef: React.RefObject<HTMLDivElement>;
  highlightedEventIds?: Set<string>;
}

export function Minimap({ events, scrollRef, highlightedEventIds }: MinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const rafRef = useRef<number | null>(null);
  const themeVersion = useThemeVersion();

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const h = container.clientHeight;
    if (h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = CANVAS_W * dpr;
    const targetH = h * dpr;
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${CANVAS_W}px`;
      canvas.style.height = `${h}px`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS_W, h);

    const n = events.length;
    if (n > 0) {
      const maxTicks = Math.floor(h / (TICK_H + 1));
      const bucket = n > maxTicks ? Math.ceil(n / maxTicks) : 1;

      for (let i = 0; i < n; i += bucket) {
        const y = Math.floor((i / n) * h);
        const slice = events.slice(i, i + bucket);
        const highlighted = !!highlightedEventIds && slice.some((e) => highlightedEventIds.has(e.id));
        ctx.fillStyle = tickColor(events[i].type, highlighted);
        ctx.fillRect(2, y, CANVAS_W - 4, TICK_H);
      }
    }

    // Viewport rectangle overlay
    const scrollEl = scrollRef.current;
    if (scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight) {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const vpTop = (scrollTop / scrollHeight) * h;
      const vpH = Math.max(12, (clientHeight / scrollHeight) * h);
      ctx.fillStyle = ctx.strokeStyle = resolveToken('info');
      ctx.globalAlpha = 0.08;
      ctx.fillRect(1, vpTop, CANVAS_W - 2, vpH);
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 1;
      ctx.strokeRect(1.5, vpTop + 0.5, CANVAS_W - 3, Math.max(11, vpH - 1));
      ctx.globalAlpha = 1;
    }
  }, [events, scrollRef, highlightedEventIds, themeVersion]);

  // Redraw on scroll — coalesce bursts of scroll events into one draw per frame
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => {
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    };
    el.addEventListener('scroll', handler, { passive: true });
    return () => {
      el.removeEventListener('scroll', handler);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [draw, scrollRef]);

  // Redraw when events change or container resizes
  useEffect(() => {
    draw();
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw]);

  const getScrollFrac = useCallback((clientY: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }, []);

  const jumpTo = useCallback((frac: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = frac * el.scrollHeight;
  }, [scrollRef]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    jumpTo(getScrollFrac(e.clientY));
    e.preventDefault();
  }, [jumpTo, getScrollFrac]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      jumpTo(getScrollFrac(e.clientY));
    };
    const handleMouseUp = () => { dragging.current = false; };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [jumpTo, getScrollFrac]);

  return (
    <div
      ref={containerRef}
      data-print-hide
      style={{
        width: CANVAS_W,
        flexShrink: 0,
        background: 'var(--bg-raised)',
        borderRight: '1px solid var(--border)',
        position: 'relative',
        userSelect: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        style={{ display: 'block', cursor: 'pointer' }}
      />
    </div>
  );
}

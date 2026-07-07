import React, { useRef, useCallback, useEffect } from 'react';
import type { TimelineEvent } from '../../lib/types.js';

const CANVAS_W = 56;
const TICK_H = 4;

function tickColor(type: string): string {
  switch (type) {
    case 'user_prompt': return '#5A9CF8';
    case 'agent_response': return '#8B7CF6';
    case 'subagent_start':
    case 'subagent_stop': return '#8B7CF6';
    case 'permission_request': return '#E5A83B';
    case 'tool_call_failed':
    case 'stop_failure': return '#F0564A';
    default: return '#2A3242';
  }
}

interface MinimapProps {
  events: TimelineEvent[];
  scrollRef: React.RefObject<HTMLDivElement>;
}

export function Minimap({ events, scrollRef }: MinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

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
        ctx.fillStyle = tickColor(events[i].type);
        ctx.fillRect(12, y, CANVAS_W - 24, TICK_H);
      }
    }

    // Viewport rectangle overlay
    const scrollEl = scrollRef.current;
    if (scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight) {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      const vpTop = (scrollTop / scrollHeight) * h;
      const vpH = Math.max(12, (clientHeight / scrollHeight) * h);
      ctx.fillStyle = 'rgba(90,156,248,0.08)';
      ctx.fillRect(4, vpTop, CANVAS_W - 8, vpH);
      ctx.strokeStyle = 'rgba(90,156,248,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(4.5, vpTop + 0.5, CANVAS_W - 9, Math.max(11, vpH - 1));
    }
  }, [events, scrollRef]);

  // Redraw on scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handler = () => draw();
    el.addEventListener('scroll', handler, { passive: true });
    return () => el.removeEventListener('scroll', handler);
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

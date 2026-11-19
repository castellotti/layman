import React, { useCallback, useEffect, useRef, useState } from 'react';
import { scrollBehavior } from '../../lib/theme-runtime.js';
import { sp, rad } from '../../lib/density.js';

/**
 * The header's tab strip: scrolls sideways without a scrollbar (swipe, wheel, chevrons), keeps the
 * active tab in view, and shows a fade plus a chevron on each side that has more tabs.
 * `activeKey` changes whenever the active tab does; the active button carries `data-tab-active`.
 */
export function TabScroller({ activeKey, tabCount, children }: { activeKey: string; tabCount: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 0;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((p) => (p.left === left && p.right === right ? p : { left, right }));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    measure();
    return () => { el.removeEventListener('scroll', measure); ro?.disconnect(); };
  }, [measure]);

  useEffect(() => { measure(); }, [tabCount, measure]);

  // A vertical wheel scrolls the strip sideways when it overflows (React's onWheel is passive).
  // A horizontal swipe (deltaX dominant) is left to native scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      el.scrollLeft += e.deltaY * unit;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const active = ref.current?.querySelector<HTMLElement>('[data-tab-active="true"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: scrollBehavior() });
  }, [activeKey]);

  const by = (dir: -1 | 1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: scrollBehavior() });
  };

  return (
    <div style={{ position: 'relative', display: 'flex', height: '100%', minWidth: 0, flex: '0 1 auto' }}>
      <div
        ref={ref}
        className="header-tabs"
        style={{ display: 'flex', alignItems: 'stretch', height: '100%', minWidth: 0, overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain' }}
      >
        {children}
      </div>
      {edges.left && <Edge side="left" onClick={() => by(-1)} />}
      {edges.right && <Edge side="right" onClick={() => by(1)} />}
    </div>
  );
}

function Edge({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const left = side === 'left';
  return (
    <>
      <div
        aria-hidden
        data-print-hide
        style={{
          position: 'absolute', top: 0, bottom: 0, [side]: 0, width: sp(24), pointerEvents: 'none',
          background: `linear-gradient(to ${left ? 'right' : 'left'}, var(--bg-raised), transparent)`,
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        data-print-hide
        aria-label={left ? 'Scroll tabs left' : 'Scroll tabs right'}
        onClick={onClick}
        style={{
          position: 'absolute', top: '50%', transform: 'translateY(-50%)', [side]: 0,
          width: sp(16), height: sp(20), padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, lineHeight: 1, color: 'var(--text-muted)', background: 'transparent',
          border: 'none', borderRadius: rad(4), cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
      >
        {left ? '‹' : '›'}
      </button>
    </>
  );
}

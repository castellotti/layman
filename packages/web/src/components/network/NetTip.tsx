/**
 * Tooltips for the network tabs. One host, mounted by `NetworkView`, shows a tip
 * for any element carrying `data-tip` (and optionally `data-tip-heading` and
 * `data-tip-facts`, one fact per line; `tipProps` writes them), so every widget
 * gets the same tip by adding an attribute, SVG elements included.
 *
 * Not the browser's `title`: that appears after about a second, cannot be styled,
 * and never appears on keyboard focus, so the strip's chips read as unexplained
 * labels. This one appears almost at once on hover, at once on focus, and goes on
 * Escape, scroll or a click.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NetTip } from '../../lib/net-format.js';

/** The attributes that give an element a tip (none for an empty one). */
export function tipProps(tip: NetTip | string | null | undefined): Record<string, string> {
  if (!tip) return {};
  if (typeof tip === 'string') return { 'data-tip': tip };
  return {
    'data-tip': tip.body,
    ...(tip.heading ? { 'data-tip-heading': tip.heading } : {}),
    ...(tip.facts?.length ? { 'data-tip-facts': tip.facts.join('\n') } : {}),
  };
}

/** Hover this long before a tip shows: long enough not to flicker while the pointer crosses a row of chips. */
const HOVER_MS = 120;
const WIDTH = 320;
const GAP = 6;

interface Shown {
  el: Element;
  rect: DOMRect;
  tip: NetTip;
}

function tipOf(el: Element): NetTip | null {
  const body = el.getAttribute('data-tip');
  if (!body) return null;
  const facts = el.getAttribute('data-tip-facts');
  return { heading: el.getAttribute('data-tip-heading') ?? undefined, body, facts: facts ? facts.split('\n') : undefined };
}

const target = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);

export function NetTipHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const show = (el: Element) => {
      const tip = tipOf(el);
      if (!tip) return;
      current.current?.removeAttribute('aria-describedby');
      current.current = el;
      el.setAttribute('aria-describedby', id);
      setShown({ el, rect: el.getBoundingClientRect(), tip });
    };
    const hide = () => {
      clear();
      current.current?.removeAttribute('aria-describedby');
      current.current = null;
      setShown(null);
    };
    const over = (e: PointerEvent) => {
      const el = target(e);
      if (!el || el === current.current) return;
      clear();
      // Moving from one tip to the next swaps at once; a first tip waits a moment.
      if (current.current) show(el);
      else timer.current = setTimeout(() => show(el), HOVER_MS);
    };
    const out = (e: PointerEvent) => {
      const el = target(e);
      if (!el) return;
      const next = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null;
      if (next !== el) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = target(e);
      if (el) {
        clear();
        show(el);
      }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', hide);
    // A tip is placed where its element was: anything moving the page takes it away.
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [id]);

  if (!shown) return null;
  const { rect, tip } = shown;
  // Below its element, or above when there is no room; never off the side of the window.
  const below = rect.bottom + 140 < window.innerHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  return createPortal(
    <div
      id={id}
      role="tooltip"
      data-print-hide
      style={{
        position: 'fixed', left, zIndex: 1000, maxWidth: WIDTH, padding: '8px 10px', borderRadius: 6,
        ...(below ? { top: rect.bottom + GAP } : { bottom: window.innerHeight - rect.top + GAP }),
        background: 'var(--bg-elevated, var(--bg-card))', border: '1px solid var(--border-strong)',
        boxShadow: '0 10px 28px rgba(0,0,0,0.45)', fontFamily: 'var(--font-ui)', fontSize: 11.5,
        lineHeight: 1.45, color: 'var(--text-body)', pointerEvents: 'none', whiteSpace: 'pre-line',
      }}
    >
      {tip.heading && <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{tip.heading}</div>}
      <div>{tip.body}</div>
      {tip.facts && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 1, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>
          {tip.facts.map((f) => <div key={f}>{f}</div>)}
        </div>
      )}
    </div>,
    document.body,
  );
}

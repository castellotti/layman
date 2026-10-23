/**
 * Tooltips for the network tabs. One host, mounted by `NetworkView`, shows a tip
 * for any element carrying `data-tip` (and optionally `data-tip-heading` and
 * `data-tip-facts`, one fact per line; `tipProps` writes them), so every widget
 * gets the same tip by adding an attribute, SVG elements included.
 *
 * Not the browser's `title`: that appears after about a second, cannot be styled,
 * and never appears on keyboard focus, so the strip's chips read as unexplained
 * labels. This one appears almost at once on hover and at once on keyboard
 * focus (not on the focus a click gives, which would bring back the tip the
 * click dismissed), and goes on Escape or a click.
 *
 * While shown it follows its element: it re-reads the element's tip and place a
 * few times a second and on scroll, so a chip that relabels itself ("Gate
 * running" → "Gate stale") is not described by its old words, and a tip whose
 * element is gone (a marker ageing out, a node rebuilt) goes with it.
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

/**
 * A control that may be disabled, and why. A disabled button takes neither focus nor (in every
 * browser) pointer events, so its reason goes on a wrapper that does: focusable while the
 * control is disabled, with the control itself out of the pointer's way.
 */
export function TipWrap({ tip, disabled, children }: { tip: NetTip | string | null | undefined; disabled: boolean; children: React.ReactNode }) {
  return (
    <span {...tipProps(tip)} tabIndex={disabled && tip ? 0 : undefined} style={{ display: 'inline-flex', ...(disabled ? { cursor: 'not-allowed' } : {}) }}>
      {disabled ? <span style={{ display: 'inline-flex', pointerEvents: 'none' }}>{children}</span> : children}
    </span>
  );
}

/** Hover this long before a tip shows: long enough not to flicker while the pointer crosses a row of chips. */
const HOVER_MS = 120;
/** How often a shown tip re-reads its element. */
const FOLLOW_MS = 250;
const WIDTH = 320;
const GAP = 6;
/** A tip's text is cut to this, and its facts to `MAX_FACTS`, so a long prompt or host list stays a tip. */
const MAX_BODY = 600;
const MAX_FACTS = 12;

function tipOf(el: Element): NetTip | null {
  const body = el.getAttribute('data-tip');
  if (!body) return null;
  const facts = el.getAttribute('data-tip-facts');
  return { heading: el.getAttribute('data-tip-heading') ?? undefined, body, facts: facts ? facts.split('\n') : undefined };
}

const target = (e: Event) => (e.target instanceof Element ? e.target.closest('[data-tip]') : null);
const clip = (s: string) => (s.length > MAX_BODY ? `${s.slice(0, MAX_BODY - 1)}…` : s);

export function NetTipHost() {
  // The element whose tip is shown; its words and place are read from it at each render.
  const [el, setEl] = useState<Element | null>(null);
  const [, follow] = useState(0);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const show = (next: Element) => {
      if (!tipOf(next)) return;
      current.current?.removeAttribute('aria-describedby');
      current.current = next;
      next.setAttribute('aria-describedby', id);
      setEl(next);
    };
    const hide = () => {
      clear();
      current.current?.removeAttribute('aria-describedby');
      current.current = null;
      setEl(null);
    };
    const over = (e: PointerEvent) => {
      const next = target(e);
      if (!next || next === current.current) return;
      clear();
      // Moving from one tip to the next swaps at once; a first tip waits a moment.
      if (current.current) show(next);
      else timer.current = setTimeout(() => show(next), HOVER_MS);
    };
    const out = (e: PointerEvent) => {
      const from = target(e);
      if (!from) return;
      const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null;
      if (to !== from) hide();
    };
    const focus = (e: FocusEvent) => {
      const next = target(e);
      // Keyboard focus only: a click focuses what it hits, and must dismiss, not re-show.
      if (next && e.target instanceof Element && e.target.matches(':focus-visible')) {
        clear();
        show(next);
      }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    // Follow the element: a scroll moves it (focusing a clipped chip scrolls its row), and its tip can change.
    const refresh = () => {
      const shown = current.current;
      if (!shown) return;
      if (!shown.isConnected || !tipOf(shown)) hide();
      else follow((n) => n + 1);
    };
    const tick = setInterval(refresh, FOLLOW_MS);
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', hide);
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', hide);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('resize', refresh);
    return () => {
      hide();
      clearInterval(tick);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', hide);
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('resize', refresh);
    };
  }, [id]);

  const tip = el?.isConnected ? tipOf(el) : null;
  if (!el || !tip) return null;
  const rect = el.getBoundingClientRect();
  // On whichever side has more room, never taller than that room, never off the side of the window.
  const room = { below: window.innerHeight - rect.bottom - GAP - 8, above: rect.top - GAP - 8 };
  const below = room.below >= 140 || room.below >= room.above;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  const facts = tip.facts && tip.facts.length > MAX_FACTS
    ? [...tip.facts.slice(0, MAX_FACTS - 1), `+${tip.facts.length - MAX_FACTS + 1} more`]
    : tip.facts;
  return createPortal(
    <div
      id={id}
      role="tooltip"
      data-print-hide
      style={{
        position: 'fixed', left, zIndex: 1000, maxWidth: WIDTH, padding: '8px 10px', borderRadius: 6,
        ...(below ? { top: rect.bottom + GAP } : { bottom: window.innerHeight - rect.top + GAP }),
        maxHeight: Math.max(60, below ? room.below : room.above), overflow: 'hidden',
        background: 'var(--bg-elevated, var(--bg-card))', border: '1px solid var(--border-strong)',
        boxShadow: '0 10px 28px rgba(0,0,0,0.45)', fontFamily: 'var(--font-ui)', fontSize: 11.5,
        lineHeight: 1.45, color: 'var(--text-body)', pointerEvents: 'none', whiteSpace: 'pre-line',
      }}
    >
      {tip.heading && <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{tip.heading}</div>}
      <div>{clip(tip.body)}</div>
      {facts && (
        <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 1, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)' }}>
          {facts.map((f, i) => <div key={i}>{f}</div>)}
        </div>
      )}
    </div>,
    document.body,
  );
}

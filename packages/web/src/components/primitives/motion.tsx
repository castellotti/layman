import type { CSSProperties, ReactNode } from 'react';

/**
 * Motion that means something, and only that: a pulse out where a call starts, a smaller grey one
 * back when it ends, a ripple where it lands, clock hands while it runs, a slow breath at rest.
 * They are CSS animations (keyframes in `index.css`), so Appearance → Motion governs them: Reduced
 * and Off stop the loops, and a finished animation rests in its final state (a ring faded out).
 */

interface Base {
  /** Any colour: a `var(--…)` token. */
  color?: string;
  /** Diameter of the thing it marks, in px (a size, not spacing: it does not follow density). */
  size?: number;
}

const ring = (size: number): CSSProperties => ({
  position: 'absolute', inset: 0, width: size, height: size, borderRadius: '50%', pointerEvents: 'none',
});

/** A ring that grows out of its box and fades once: a call starts. `quiet` is the smaller grey one for its end. */
export function Pulse({ color = 'var(--accent)', size = 10, quiet = false }: Base & { quiet?: boolean }) {
  return (
    <span aria-hidden className="layman-pulse"
      style={{ ...ring(size), border: 'var(--stroke) solid ' + (quiet ? 'var(--text-faint)' : color), ['--pulse-to' as string]: quiet ? 1.8 : 2.6 }} />
  );
}

/** Two rings, one after the other: a call lands. */
export function Ripple({ color = 'var(--accent)', size = 10 }: Base) {
  const style = { ...ring(size), border: 'var(--stroke) solid ' + color };
  return (
    <>
      <span aria-hidden className="layman-ripple" style={style} />
      <span aria-hidden className="layman-ripple" style={{ ...style, animationDelay: 'calc(0.45s * var(--motion, 1))' }} />
    </>
  );
}

/** A thin ring with a hand that sweeps round while something runs. */
export function ClockRing({ color = 'var(--ok)', size = 14 }: Base) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.2" strokeLinecap="round" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="6.5" opacity="0.45" />
      <path className="layman-clock-hand" d="M8 8V3.5" style={{ transformOrigin: '8px 8px' }} />
    </svg>
  );
}

/** A dot that breathes: alive, nothing happening. */
export function BreathingDot({ color = 'var(--ok)', size = 8 }: Base) {
  return (
    <span aria-hidden className="layman-breathe"
      style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0 }} />
  );
}

/** A label with a thin rim that breathes, for a name that is live (a session, a sandbox). */
export function LabelRim({ children, color = 'var(--ok)', style }: { children: ReactNode; color?: string; style?: CSSProperties }) {
  return <span className="layman-rim" style={{ ['--rim' as string]: color, ...style }}>{children}</span>;
}

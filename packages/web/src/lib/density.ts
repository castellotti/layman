/**
 * Spacing and corner radius that follow the appearance. Inline styles can't use Tailwind's scale,
 * so they write `sp(8)` / `sp('4px 8px')` and `rad(6)`; the CSS variables the theme writes
 * (`--density`, `--radius-scale`) then change them all at once. The numbers are the Compact design
 * (density 1) and Classic's corners (scale 1), so the default look is exactly what they say.
 */

const px = (n: number): string => `calc(${n}px * var(--density))`;
const LENGTH = /^(-?\d*\.?\d+)(px)?$/;

/** A padding, margin or gap, as a number (px) or a CSS string of px values, scaled by `--density`. */
export function sp(value: number | string): string {
  if (typeof value === 'number') return value === 0 ? '0' : px(value);
  return value
    .split(/\s+/)
    .map((part) => {
      const m = LENGTH.exec(part);
      return m && Number(m[1]) !== 0 ? px(Number(m[1])) : part;
    })
    .join(' ');
}

/** A corner radius, scaled by the theme's `--radius-scale` (Classic 1, Phosphor 0). */
export function rad(value: number | string): string {
  const n = typeof value === 'number' ? value : LENGTH.exec(value)?.[1];
  if (n === undefined) return String(value);
  return Number(n) === 0 ? '0' : `calc(${Number(n)}px * var(--radius-scale))`;
}

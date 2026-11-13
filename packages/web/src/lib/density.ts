/**
 * Spacing and corner radius that follow the appearance. Inline styles can't use Tailwind's scale,
 * so they write `sp(8)` / `sp('4px 8px')` and `rad(6)`; the CSS variables the theme writes
 * (`--density`, `--radius-scale`) then change them all at once. The numbers are the Compact design
 * (density 1) and Classic's corners (scale 1), so the default look is exactly what they say.
 */

const LENGTH = /^(-?\d*\.?\d+)(px)?$/;

/** Rewrite each bare px length in a space-separated CSS value; zero and non-lengths pass through. */
function scale(value: number | string, to: (n: number) => string): string {
  return String(value)
    .split(/\s+/)
    .map((part) => {
      const m = LENGTH.exec(part);
      return m && Number(m[1]) !== 0 ? to(Number(m[1])) : m ? '0' : part;
    })
    .join(' ');
}

/** A padding, margin or gap, as a number (px) or a CSS string of px values, scaled by `--density`. */
export const sp = (value: number | string): string => scale(value, (n) => `calc(${n}px * var(--density))`);

/** A corner radius (or several, `'5px 5px 0 0'`), scaled by the theme's `--radius-scale` (Classic 1, Phosphor 0). */
export const rad = (value: number | string): string => scale(value, (n) => `calc(${n}px * var(--radius-scale))`);

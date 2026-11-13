import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'
import { TOKENS, tokenColor } from './src/lib/tokens'

/**
 * Every theme colour, by its token name, as a reference to the CSS variable the active theme
 * writes (`bg-bg-card`, `text-text-muted`, `border-border-strong`, `text-ok/70`). Never a hex value:
 * a literal here would not follow the theme or print light. Mind the names: `bg-bg-code` is the
 * code background; `bg-code` paints with the code text colour.
 */
const colors = Object.fromEntries(
  TOKENS.map((t) => [t, ({ opacityValue }: { opacityValue?: string }) => tokenColor(t, opacityValue)]),
) as unknown as Record<string, string> // Tailwind 3 takes a colour function but does not type one

/** Tailwind's spacing scale (0.25rem steps), scaled by the appearance's density; sizes are not. */
const SPACING_KEYS = ['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24'];
const spacing = Object.fromEntries(SPACING_KEYS.map((k) => [k, `calc(${Number(k) * 0.25}rem * var(--density))`]));

/** Corners follow the theme's radius (Classic 6px = scale 1); `rounded-full` stays round. */
const scaled = (rem: number) => `calc(${rem}rem * var(--radius-scale))`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        ui:   ['var(--font-ui)'],
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      colors,
      padding: spacing,
      margin: spacing,
      gap: spacing,
      space: spacing,
      borderRadius: { sm: scaled(0.125), DEFAULT: scaled(0.25), md: scaled(0.375), lg: scaled(0.5), xl: scaled(0.75), '2xl': scaled(1) },
      borderWidth: { DEFAULT: 'var(--stroke)' },
    },
  },
  plugins: [typography],
} satisfies Config

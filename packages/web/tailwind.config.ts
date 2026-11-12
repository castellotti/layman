import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'
import { TOKENS } from './src/lib/tokens'

/**
 * A theme colour at an opacity, through `color-mix`, because Tailwind cannot split a `var()`
 * holding a hex colour into channels. Tailwind hands over the modifier as written: nothing (the
 * colour itself), a number or `var(--tw-*-opacity)` (0..1), or a percentage (`/[35%]`).
 */
export function tokenColor(token: string, opacity?: string): string {
  if (opacity === undefined) return `var(--${token})`
  const pct = opacity.trim().endsWith('%') ? opacity : `calc(${opacity} * 100%)`
  return `color-mix(in srgb, var(--${token}) ${pct}, transparent)`
}

/**
 * Every theme colour, by its token name, as a reference to the CSS variable the active theme
 * writes (`bg-bg-card`, `text-text-muted`, `border-border-strong`, `text-ok/70`). Never a hex value:
 * a literal here would not follow the theme or print light. Mind the names: `bg-bg-code` is the
 * code background; `bg-code` paints with the code text colour.
 */
const colors = Object.fromEntries(
  TOKENS.map((t) => [t, ({ opacityValue }: { opacityValue?: string }) => tokenColor(t, opacityValue)]),
) as unknown as Record<string, string> // Tailwind 3 takes a colour function but does not type one

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
    },
  },
  plugins: [typography],
} satisfies Config

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

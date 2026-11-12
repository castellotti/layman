import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'
import { TOKENS } from './src/lib/themes'

/**
 * Every theme colour, by its token name, as a reference to the CSS variable the active theme
 * writes (`bg-bg-card`, `text-text-muted`, `border-border-strong`, `text-ok/70`). Never a hex value:
 * a literal here would not follow the theme or print light. The opacity modifier goes through
 * `color-mix`, because Tailwind cannot split a `var()` holding a hex colour into channels. Mind the
 * names: `bg-bg-code` is the code background; `bg-code` paints with the code text colour.
 */
const colors = Object.fromEntries(
  TOKENS.map((t) => [t, `color-mix(in srgb, var(--${t}) calc(<alpha-value> * 100%), transparent)`]),
)

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        ui:   ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      colors,
    },
  },
  plugins: [typography],
} satisfies Config

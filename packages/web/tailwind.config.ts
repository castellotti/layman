import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-primary': '#0d1117',
        'bg-card': '#161b22',
        'bg-pending': '#1c1a0f',
        'border-default': '#30363d',
        'border-pending': '#d29922',
        'text-primary': '#e6edf3',
        'text-secondary': '#8b949e',
        'text-muted': '#484f58',
        'accent-green': '#3fb950',
        'accent-yellow': '#d29922',
        'accent-red': '#f85149',
        'accent-blue': '#58a6ff',
      },
    },
  },
  plugins: [typography],
} satisfies Config

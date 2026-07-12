import type { Config } from 'tailwindcss'
import typography from '@tailwindcss/typography'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        ui:   ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'SF Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        /* New design tokens */
        'bg':          '#0B0E14',
        'bg-raised':   '#0D1119',
        'bg-card':     '#11151D',
        'bg-selected': '#141B29',
        'border':        '#1D2330',
        'border-subtle': '#171C26',
        'border-strong': '#2A3242',
        'text-primary':  '#E6EAF2',
        'text-body':     '#B8C0CF',
        'text-muted':    '#8A94A6',
        'text-faint':    '#5A6478',
        'accent':  '#35C9B4',
        'ok':      '#4CC38A',
        'warn':    '#E5A83B',
        'error':   '#F0564A',
        'info':    '#5A9CF8',
        'agent':   '#8B7CF6',
        /* Keep legacy aliases for compatibility during migration */
        'bg-primary':     '#0B0E14',
        'border-default': '#1D2330',
        'text-secondary': '#8A94A6',
        'accent-green':   '#4CC38A',
        'accent-yellow':  '#E5A83B',
        'accent-red':     '#F0564A',
        'accent-blue':    '#5A9CF8',
      },
    },
  },
  plugins: [typography],
} satisfies Config

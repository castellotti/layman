/**
 * The colour token names, alone and with no imports, because the Tailwind config (loaded by Node
 * at build time) reads them too. Each is the CSS variable `--<name>`; every theme in `themes.ts`
 * and the `:root` block in `index.css` define all of them.
 */
export const TOKENS = [
  'bg', 'bg-raised', 'bg-card', 'bg-selected', 'bg-pill', 'text-on-fill',
  'border', 'border-subtle', 'border-strong',
  'text', 'text-body', 'text-muted', 'text-faint',
  'accent', 'accent-hot', 'ok', 'warn', 'error', 'info', 'agent', 'thinking',
  'severity-major', 'severity-minor',
  'code', 'bg-code', 'diff-add-bg', 'diff-add-text', 'diff-remove-bg', 'diff-remove-text',
  'net-tunnel', 'net-up', 'net-down', 'net-ocean', 'net-land', 'net-landline', 'net-fanout', 'net-local',
] as const;
export type Token = (typeof TOKENS)[number];

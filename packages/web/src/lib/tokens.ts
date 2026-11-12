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

/**
 * A theme colour as CSS, at an opacity through `color-mix`, because a `var()` holding a hex colour
 * cannot be split into channels. The opacity is written as Tailwind hands it over: nothing (the
 * colour itself), a number or `var(--tw-*-opacity)` (0..1), or a percentage (`'35%'`). The
 * Tailwind config builds every colour with it, and code that sets a colour in a style or an SVG
 * attribute uses it too (never a hex or `rgba()` literal, which would not follow the theme).
 */
export function tokenColor(token: Token, opacity?: string): string {
  if (opacity === undefined) return `var(--${token})`;
  const pct = opacity.trim().endsWith('%') ? opacity : `calc(${opacity} * 100%)`;
  return `color-mix(in srgb, var(--${token}) ${pct}, transparent)`;
}

/**
 * Themes as data. A theme is a full map of the colour tokens components already use
 * (`var(--bg)`, `var(--warn)`, …) plus its shape (corner radius, stroke width) and its own type.
 * Four independent axes sit on top: the theme, the type (the theme's own, sans UI, mono-forward),
 * the density and the motion. `resolveAppearance` turns those choices into CSS variables; it is
 * pure, so the rules every theme must hold are tested in node (`themes.test.ts`):
 *
 * - text, body text and muted text reach WCAG AA (4.5) on every ground a component draws on;
 * - the accent stays clear (OKLab ΔE ≥ 0.12) of the theme's own status colours, because `--warn`
 *   means MEDIUM risk and a pending permission, and an accent near it would read as one;
 * - every theme defines every token, as `#rgb` / `#rrggbb`;
 * - Classic equals the `:root` block in `index.css`, so the default changes nothing.
 *
 * `--accent` is an edge and an underline, never a fill behind text, in every theme.
 */
import { HEX_COLOR } from './color.js';

/** Every colour token a theme defines; each is the CSS variable `--<name>`. */
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
export type TokenMap = Record<Token, string>;

/** The grounds text is drawn on, and the text tokens that must read on each (WCAG AA). */
export const CONTRAST_GROUNDS: readonly Token[] = ['bg', 'bg-raised', 'bg-card'];
export const CONTRAST_TEXTS: readonly Token[] = ['text', 'text-body', 'text-muted'];
export const MIN_CONTRAST = 4.5;
/** Status colours the accent must stay clear of, and by how much (OKLab ΔE). */
export const ACCENT_CLEAR_OF: readonly Token[] = ['ok', 'warn', 'error', 'severity-major', 'severity-minor'];
export const MIN_ACCENT_DISTANCE = 0.12;

export type ThemeId = 'classic' | 'ember' | 'tide' | 'phosphor' | 'paper' | 'daylight' | 'contrast';
export type Scheme = 'dark' | 'light';
/** A theme's own type: sans UI with mono code, mono-forward, or mono for everything. */
export type ThemeType = 'sans' | 'mono' | 'mono-only';

export interface Theme {
  id: ThemeId;
  name: string;
  scheme: Scheme;
  /** One line for Settings → Appearance. */
  idea: string;
  type: ThemeType;
  /** Corner radius and line width, px. */
  radius: number;
  stroke: number;
  tokens: TokenMap;
}

export const THEMES: readonly Theme[] = [
  {
    id: 'classic', name: 'Classic', scheme: 'dark', type: 'sans', radius: 6, stroke: 1,
    idea: 'Cool blue-grey, blue accent, a colour for each kind of thing.',
    tokens: {
      'bg': '#0B0E14', 'bg-raised': '#0D1119', 'bg-card': '#11151D', 'bg-selected': '#141B29', 'bg-pill': '#161C28', 'text-on-fill': '#0B0E14',
      'border': '#1D2330', 'border-subtle': '#171C26', 'border-strong': '#2A3242',
      'text': '#E6EAF2', 'text-body': '#B8C0CF', 'text-muted': '#8A94A6', 'text-faint': '#5A6478',
      'accent': '#5A9CF8', 'accent-hot': '#8FBBFA', 'ok': '#4CC38A', 'warn': '#E5A83B', 'error': '#F0564A', 'info': '#5A9CF8', 'agent': '#8B7CF6', 'thinking': '#8957E5',
      'severity-major': '#FF9100', 'severity-minor': '#FFB300',
      'code': '#79C0FF', 'bg-code': '#0D1117', 'diff-add-bg': '#0F2A1A', 'diff-add-text': '#AFF5B4', 'diff-remove-bg': '#2A0F0F', 'diff-remove-text': '#FFC0C0',
      'net-tunnel': '#35C9B4', 'net-up': '#B58CF6', 'net-down': '#5A9CF8', 'net-ocean': '#090C12', 'net-land': '#151B27', 'net-landline': '#1F2736', 'net-fanout': '#7B6CE0', 'net-local': '#5B6477',
    },
  },
  {
    id: 'ember', name: 'Ember', scheme: 'dark', type: 'mono', radius: 3, stroke: 1,
    idea: 'Warm bone text on near-black and one pale copper accent; state is brightness.',
    tokens: {
      'bg': '#0F0D0B', 'bg-raised': '#14110E', 'bg-card': '#1A1612', 'bg-selected': '#241E18', 'bg-pill': '#221C17', 'text-on-fill': '#0F0D0B',
      'border': '#2A241D', 'border-subtle': '#1F1A15', 'border-strong': '#3A3229',
      'text': '#EEE6D8', 'text-body': '#C8BDAC', 'text-muted': '#9A8F7F', 'text-faint': '#6B6255',
      'accent': '#CC8B6C', 'accent-hot': '#EBA190', 'ok': '#86C08F', 'warn': '#E8C84E', 'error': '#F0506E', 'info': '#9DB4D6', 'agent': '#B9A3D9', 'thinking': '#9C86C9',
      'severity-major': '#F7E07A', 'severity-minor': '#E0BC3C',
      'code': '#D8C4A2', 'bg-code': '#0B0A08', 'diff-add-bg': '#142417', 'diff-add-text': '#B5E3B9', 'diff-remove-bg': '#2A1216', 'diff-remove-text': '#F6B8C2',
      'net-tunnel': '#6FC2B2', 'net-up': '#C3A6E0', 'net-down': '#9DB4D6', 'net-ocean': '#0B0A08', 'net-land': '#1C1813', 'net-landline': '#2E271F', 'net-fanout': '#A592CC', 'net-local': '#6B6255',
    },
  },
  {
    id: 'tide', name: 'Tide', scheme: 'dark', type: 'mono', radius: 3, stroke: 1,
    idea: 'The same discipline, cool: the tunnel teal is the one accent, and ok is lime.',
    tokens: {
      'bg': '#080C0F', 'bg-raised': '#0B1014', 'bg-card': '#0F151A', 'bg-selected': '#13202A', 'bg-pill': '#141C23', 'text-on-fill': '#080C0F',
      'border': '#1B252D', 'border-subtle': '#141C22', 'border-strong': '#283540',
      'text': '#DDE7EC', 'text-body': '#AEBCC4', 'text-muted': '#82919A', 'text-faint': '#56646D',
      'accent': '#3CC3B0', 'accent-hot': '#7FE0D2', 'ok': '#A2CF52', 'warn': '#E8AE45', 'error': '#F2596A', 'info': '#79A6F0', 'agent': '#A795F0', 'thinking': '#8F78D8',
      'severity-major': '#F28A4C', 'severity-minor': '#E8AE45',
      'code': '#8FD3F5', 'bg-code': '#070A0D', 'diff-add-bg': '#0F2618', 'diff-add-text': '#B6EFC0', 'diff-remove-bg': '#2A1015', 'diff-remove-text': '#FFC1C8',
      'net-tunnel': '#3CC3B0', 'net-up': '#A795F0', 'net-down': '#79A6F0', 'net-ocean': '#060A0C', 'net-land': '#121A20', 'net-landline': '#1C2830', 'net-fanout': '#8676D8', 'net-local': '#56646D',
    },
  },
  {
    id: 'phosphor', name: 'Phosphor', scheme: 'dark', type: 'mono-only', radius: 0, stroke: 1,
    idea: 'One terminal green, square corners, mono everywhere; ok is cyan because green is taken.',
    tokens: {
      'bg': '#050906', 'bg-raised': '#08100A', 'bg-card': '#0B150E', 'bg-selected': '#10241A', 'bg-pill': '#0E1D13', 'text-on-fill': '#050906',
      'border': '#173220', 'border-subtle': '#112619', 'border-strong': '#22482F',
      'text': '#C9F7D2', 'text-body': '#9DDBA9', 'text-muted': '#6FA77B', 'text-faint': '#4C7A57',
      'accent': '#4DF08A', 'accent-hot': '#9CFFC0', 'ok': '#62D2F0', 'warn': '#F2C14E', 'error': '#FF6464', 'info': '#B5F0C4', 'agent': '#9DDBA9', 'thinking': '#6FA77B',
      'severity-major': '#FF9A57', 'severity-minor': '#F2C14E',
      'code': '#86F2B4', 'bg-code': '#040805', 'diff-add-bg': '#0D2A15', 'diff-add-text': '#9CFFC0', 'diff-remove-bg': '#2A0D0D', 'diff-remove-text': '#FFB0B0',
      'net-tunnel': '#4DF08A', 'net-up': '#B5F0C4', 'net-down': '#7FE0A0', 'net-ocean': '#030604', 'net-land': '#0B150E', 'net-landline': '#173220', 'net-fanout': '#6FA77B', 'net-local': '#4C7A57',
    },
  },
  {
    id: 'paper', name: 'Paper', scheme: 'light', type: 'sans', radius: 4, stroke: 1,
    idea: 'Warm paper, ink-dark text and a dark umber accent.',
    tokens: {
      'bg': '#F3EFE5', 'bg-raised': '#F8F5EE', 'bg-card': '#FDFBF6', 'bg-selected': '#EAE3D3', 'bg-pill': '#ECE6D9', 'text-on-fill': '#FDFBF6',
      'border': '#DCD4C3', 'border-subtle': '#E7E1D4', 'border-strong': '#C4B9A4',
      'text': '#201D18', 'text-body': '#3B362F', 'text-muted': '#605A50', 'text-faint': '#857D70',
      'accent': '#6B3F33', 'accent-hot': '#4A2A22', 'ok': '#2E7D46', 'warn': '#8A6D00', 'error': '#B42340', 'info': '#2F5E9E', 'agent': '#5E3FA0', 'thinking': '#7A52B8',
      'severity-major': '#B85A12', 'severity-minor': '#8A6D00',
      'code': '#2F5E9E', 'bg-code': '#F0EBDF', 'diff-add-bg': '#DDEFD9', 'diff-add-text': '#1E5A2E', 'diff-remove-bg': '#F6DCDC', 'diff-remove-text': '#8A1C28',
      'net-tunnel': '#1E8577', 'net-up': '#6E4FB0', 'net-down': '#2F5E9E', 'net-ocean': '#E9E3D6', 'net-land': '#D9D0BE', 'net-landline': '#C4B9A4', 'net-fanout': '#6A5BB0', 'net-local': '#857D70',
    },
  },
  {
    id: 'daylight', name: 'Daylight', scheme: 'light', type: 'sans', radius: 6, stroke: 1,
    idea: 'Neutral white with a blue accent: the familiar code-host look.',
    tokens: {
      'bg': '#FFFFFF', 'bg-raised': '#FFFFFF', 'bg-card': '#F6F8FA', 'bg-selected': '#EEF2F7', 'bg-pill': '#EEF1F5', 'text-on-fill': '#FFFFFF',
      'border': '#D0D7DE', 'border-subtle': '#E4E8EE', 'border-strong': '#B8C0CC',
      'text': '#1F2328', 'text-body': '#2F363F', 'text-muted': '#57606A', 'text-faint': '#6E7781',
      'accent': '#0969DA', 'accent-hot': '#0550AE', 'ok': '#1A7F37', 'warn': '#9A6700', 'error': '#CF222E', 'info': '#0969DA', 'agent': '#6639BA', 'thinking': '#8250DF',
      'severity-major': '#BC4C00', 'severity-minor': '#9A6700',
      'code': '#0550AE', 'bg-code': '#F6F8FA', 'diff-add-bg': '#DAFBE1', 'diff-add-text': '#116329', 'diff-remove-bg': '#FFEBE9', 'diff-remove-text': '#82071E',
      'net-tunnel': '#0E8A7A', 'net-up': '#8250DF', 'net-down': '#0969DA', 'net-ocean': '#EEF2F6', 'net-land': '#D8DEE6', 'net-landline': '#B8C0CC', 'net-fanout': '#6E5BD0', 'net-local': '#6E7781',
    },
  },
  {
    id: 'contrast', name: 'Contrast', scheme: 'dark', type: 'sans', radius: 4, stroke: 2,
    idea: 'Black ground, AAA text, thicker lines and an ice-cyan accent.',
    tokens: {
      'bg': '#000000', 'bg-raised': '#0A0A0A', 'bg-card': '#101010', 'bg-selected': '#1F2A33', 'bg-pill': '#1A1A1A', 'text-on-fill': '#000000',
      'border': '#6A6A6A', 'border-subtle': '#404040', 'border-strong': '#A0A0A0',
      'text': '#FFFFFF', 'text-body': '#F2F2F2', 'text-muted': '#D0D0D0', 'text-faint': '#A8A8A8',
      'accent': '#7FE3FF', 'accent-hot': '#C2F2FF', 'ok': '#3BF07F', 'warn': '#FFB224', 'error': '#FF6B6B', 'info': '#8AB8FF', 'agent': '#C6A8FF', 'thinking': '#B48CFF',
      'severity-major': '#FF8F3F', 'severity-minor': '#FFB224',
      'code': '#9CD8FF', 'bg-code': '#050505', 'diff-add-bg': '#003A17', 'diff-add-text': '#BFFFD2', 'diff-remove-bg': '#4A0000', 'diff-remove-text': '#FFD0D0',
      'net-tunnel': '#3FE0C8', 'net-up': '#C6A8FF', 'net-down': '#8AB8FF', 'net-ocean': '#000000', 'net-land': '#1A1A1A', 'net-landline': '#5A5A5A', 'net-fanout': '#A58CFF', 'net-local': '#A8A8A8',
    },
  },
];

const BY_ID = new Map<string, Theme>(THEMES.map((t) => [t.id, t]));

/** The theme for an id, or Classic for one this version does not know (a cut or future theme). */
export function themeById(id: string): Theme {
  return BY_ID.get(id) ?? BY_ID.get('classic')!;
}

/** Which type the UI uses: the theme's own, sans UI (Plex Sans), or mono-forward (Plex Mono). */
export type FontChoice = 'theme' | 'sans' | 'mono';
export type Density = 'comfortable' | 'compact';
/** `reduced` keeps state changes but drops continuous animation; `off` drops transitions too. */
export type Motion = 'full' | 'reduced' | 'off';

export interface Appearance {
  /** A theme id, or `system` to follow the OS between `darkTheme` and `lightTheme`. */
  theme: ThemeId | 'system';
  darkTheme: ThemeId;
  lightTheme: ThemeId;
  font: FontChoice;
  density: Density;
  motion: Motion;
  /** Per-token colours on top of the chosen theme. Unknown tokens and non-hex values are ignored. */
  overrides: Partial<Record<string, string>>;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'classic',
  darkTheme: 'classic',
  lightTheme: 'daylight',
  font: 'sans',
  density: 'compact',
  motion: 'full',
  overrides: {},
};

export const FONT_SANS = "'IBM Plex Sans', system-ui, sans-serif";
export const FONT_MONO = "'IBM Plex Mono', 'SF Mono', 'Fira Code', monospace";
/** What `--density` multiplies spacing by. */
export const DENSITY_SCALE: Record<Density, number> = { comfortable: 1, compact: 0.72 };

/** What the browser reports, passed in so resolution stays pure. */
export interface Environment {
  prefersDark: boolean;
  prefersReducedMotion: boolean;
}

export interface ResolvedAppearance {
  theme: Theme;
  /** The motion actually in effect: the OS's reduced-motion setting caps it at `reduced`. */
  motion: Motion;
  /** CSS custom properties, names with the leading `--`. */
  vars: Record<string, string>;
}

export function resolveAppearance(a: Appearance, env: Environment): ResolvedAppearance {
  const id = a.theme === 'system' ? (env.prefersDark ? a.darkTheme : a.lightTheme) : a.theme;
  const theme = themeById(id);
  const motion: Motion = env.prefersReducedMotion && a.motion === 'full' ? 'reduced' : a.motion;
  const mono = a.font === 'mono' || (a.font === 'theme' && theme.type !== 'sans') || theme.type === 'mono-only';

  const vars: Record<string, string> = {};
  for (const token of TOKENS) {
    const override = a.overrides[token];
    vars[`--${token}`] = override && HEX_COLOR.test(override) ? override : theme.tokens[token];
  }
  vars['--font-ui'] = mono ? FONT_MONO : FONT_SANS;
  vars['--font-mono'] = FONT_MONO;
  vars['--radius'] = `${theme.radius}px`;
  vars['--stroke'] = `${theme.stroke}px`;
  vars['--density'] = String(DENSITY_SCALE[a.density]);
  vars['--motion'] = motion === 'off' ? '0' : '1';
  return { theme, motion, vars };
}

/**
 * The stylesheet text for a resolved appearance. Screen only: print keeps its own light palette
 * in `index.css`, which a screen theme must not override (an inline style on `<html>` would).
 * `color-scheme` is not set yet: today native controls render light on the dark UI, and setting
 * it belongs with the Appearance settings that make a theme choice visible.
 */
export function appearanceCss(r: ResolvedAppearance): string {
  const decls = Object.entries(r.vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `@media screen {\n:root {\n${decls}\n}\n}\n`;
}

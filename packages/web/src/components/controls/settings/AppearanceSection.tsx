import React from 'react';
import type { ClientMessage } from '../../../lib/ws-protocol.js';
import type { LaymanConfig } from '../../../lib/types.js';
import { useThemeVersion } from '../../../hooks/useThemeVersion.js';
import {
  followOsUpdate, normalizeAppearance, themeById, THEMES,
  type Appearance, type FontChoice, type Motion, type Theme, type ThemeId, type Token,
} from '../../../lib/themes.js';
import { ColourOverrides } from './ColourOverrides.js';
import { SectionTitle, SectionIntro, SegmentRow, ToggleRow, CustomRow } from './primitives.js';

/** The colours a theme card shows beside its name: the accent, then the status and kind colours. */
const SWATCHES: readonly Token[] = ['accent', 'ok', 'warn', 'error', 'info', 'agent'];

const FONT_OPTIONS: { label: string; value: FontChoice }[] = [
  { label: "Theme's own", value: 'theme' },
  { label: 'Sans', value: 'sans' },
  { label: 'Mono', value: 'mono' },
];
const DARK_THEMES = THEMES.filter((t) => t.scheme === 'dark');
const LIGHT_THEMES = THEMES.filter((t) => t.scheme === 'light');

const MOTION_OPTIONS: { label: string; value: Motion }[] = [
  { label: 'Full', value: 'full' },
  { label: 'Reduced', value: 'reduced' },
  { label: 'Off', value: 'off' },
];

/**
 * Settings → Appearance: the theme (or a dark and a light one that follow the OS), the type and the
 * motion. Each choice is a config update; `useAppearance` applies the config when it comes back, so
 * every open tab changes together.
 */
export function AppearanceSection({
  config, onSend,
}: {
  config: LaymanConfig;
  onSend: (msg: ClientMessage) => void;
}) {
  const a = normalizeAppearance(config.appearance);
  const update = (appearance: Partial<Appearance>) => onSend({ type: 'config:update', config: { appearance } });
  const followOs = a.theme === 'system';
  // The theme on screen now (what `applyTheme` last wrote), which turning "Follow the OS" off
  // keeps. The version re-renders this when the OS flips between dark and light.
  useThemeVersion();
  const showing = themeById(document.documentElement.dataset.theme ?? a.theme);

  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <SectionIntro>
        Saved on the Layman server, so every browser using it looks the same. Export to PDF always
        prints in Daylight.
      </SectionIntro>

      <ToggleRow
        label="Follow the OS"
        desc="Switch between a dark and a light theme when your system's appearance changes."
        checked={followOs}
        onChange={() => update(followOsUpdate(a, showing))}
      />

      {followOs ? (
        <>
          <ThemePicker
            label="Dark theme"
            themes={DARK_THEMES}
            selected={a.darkTheme}
            showing={showing.id}
            onPick={(id) => update({ darkTheme: id })}
          />
          <ThemePicker
            label="Light theme"
            themes={LIGHT_THEMES}
            selected={a.lightTheme}
            showing={showing.id}
            onPick={(id) => update({ lightTheme: id })}
          />
        </>
      ) : (
        <ThemePicker label="Theme" themes={THEMES} selected={showing.id} showing={showing.id} onPick={(id) => update({ theme: id })} />
      )}

      <SegmentRow
        label="Type"
        desc="Theme's own: Ember and Tide set the interface in mono, Phosphor sets everything in mono. Code is always mono."
        options={FONT_OPTIONS}
        value={a.font}
        onChange={(font) => update({ font })}
      />
      <SegmentRow
        label="Motion"
        desc="Reduced stops anything that moves on its own (spinners, pulses, moving dashes) and smooth scrolling; Off also drops transitions. When your system asks for reduced motion, Full acts as Reduced."
        options={MOTION_OPTIONS}
        value={a.motion}
        onChange={(motion) => update({ motion })}
      />

      {/* Keyed by theme, so a switch starts clean instead of showing the last theme's unsaved edits. */}
      <ColourOverrides key={showing.id} theme={showing} overrides={a.overrides} saved={config.appearance} onSave={(overrides) => update({ overrides })} />
    </>
  );
}

function ThemePicker({
  label, themes, selected, showing, onPick,
}: {
  label: string;
  themes: readonly Theme[];
  selected: ThemeId;
  showing: ThemeId;
  onPick: (id: ThemeId) => void;
}) {
  return (
    <CustomRow>
      <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
      <div role="radiogroup" aria-label={label} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
        {themes.map((t) => (
          <ThemeCard key={t.id} theme={t} selected={t.id === selected} showing={t.id === showing} onPick={() => onPick(t.id)} />
        ))}
      </div>
    </CustomRow>
  );
}

/** A theme drawn in its own colours, so the choice is seen rather than read. */
function ThemeCard({ theme, selected, showing, onPick }: { theme: Theme; selected: boolean; showing: boolean; onPick: () => void }) {
  const c = theme.tokens;
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      title={theme.idea}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'left', cursor: 'pointer',
        padding: '8px 10px', borderRadius: 6, fontFamily: 'inherit',
        background: c.bg, color: c.text,
        border: `1px solid ${c['border-strong']}`,
        // A ring, not an outline: an inline `outline: none` would hide the keyboard focus ring.
        boxShadow: selected ? '0 0 0 2px var(--bg-raised), 0 0 0 4px var(--accent)' : undefined,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{theme.name}</span>
        <span style={{ fontSize: 9.5, color: c['text-muted'] }}>{theme.scheme}</span>
        {showing && <span style={{ fontSize: 9.5, color: c['text-muted'], marginLeft: 'auto' }}>showing</span>}
      </span>
      <span style={{ display: 'flex', gap: 4 }} aria-hidden>
        {SWATCHES.map((tok) => (
          <span key={tok} style={{ width: 14, height: 14, borderRadius: 3, background: c[tok] }} />
        ))}
      </span>
      <span style={{ fontSize: 10, lineHeight: 1.4, color: c['text-body'] }}>{theme.idea}</span>
    </button>
  );
}

import React from 'react';

// ─── QuickButton / DetailedButton ──────────────────────────────────────────
// Shared colored icon buttons for the two analysis depths (Investigation
// panel's LAYMAN'S TERMS / ANALYSIS / Failure Analysis section headers and
// empty states). Quick = green bolt (--ok tint), Detailed = blue magnifier
// (--info tint).

function BoltIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1 3 9h4l-1.5 6L12 7H8l1.5-6Z" />
    </svg>
  );
}

function MagnifierIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" />
    </svg>
  );
}

interface DepthButtonProps {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
}

export function QuickButton({ onClick, disabled, loading, loadingLabel = 'Working…' }: DepthButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', fontSize: 10, borderRadius: 4,
        fontWeight: 500, fontFamily: 'var(--font-ui)', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, background: 'rgba(76,195,138,0.12)', color: 'var(--ok)',
        border: '1px solid rgba(76,195,138,0.3)', transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'rgba(76,195,138,0.2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(76,195,138,0.12)'; }}
    >
      <BoltIcon />
      {loading ? loadingLabel : 'Quick'}
    </button>
  );
}

export function DetailedButton({ onClick, disabled, loading, loadingLabel = 'Working…' }: DepthButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', fontSize: 10, borderRadius: 4,
        fontWeight: 500, fontFamily: 'var(--font-ui)', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, background: 'rgba(90,156,248,0.12)', color: 'var(--info)',
        border: '1px solid rgba(90,156,248,0.25)', transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'rgba(90,156,248,0.2)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(90,156,248,0.12)'; }}
    >
      <MagnifierIcon />
      {loading ? loadingLabel : 'Detailed'}
    </button>
  );
}

// ─── SectionLabel style ────────────────────────────────────────────────────────
// Shared uppercase small-caps label used for sidebar section headers (Sessions,
// Prompts, etc). Spread into a wrapping div's style, adding overrides as needed.

export const SECTION_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--text-muted)',
  fontFamily: 'var(--font-ui)', padding: '8px 12px 4px',
  display: 'flex', alignItems: 'center', gap: 6,
};

// ─── StatusDot ───────────────────────────────────────────────────────────────
// 8px colored dot, steady glow when live/attention. No blinking/flashing.

export type StatusDotState = 'running' | 'permission' | 'error' | 'idle' | 'ended';

const STATUS_DOT_COLORS: Record<StatusDotState, string> = {
  running:    'var(--ok)',
  permission: 'var(--warn)',
  error:      'var(--error)',
  idle:       'var(--text-faint)',
  ended:      'var(--border-strong)',
};

interface StatusDotProps {
  state: StatusDotState;
  size?: number;
}

export function StatusDot({ state, size = 8 }: StatusDotProps) {
  const color = STATUS_DOT_COLORS[state];
  const glow = state === 'running' || state === 'permission';
  return (
    <span
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        boxShadow: glow ? `0 0 8px ${color}cc` : 'none',
      }}
    />
  );
}

// ─── StateChip ───────────────────────────────────────────────────────────────
// 9.5px semibold uppercase chip, 2px 7px padding, 4px radius.

export type StateChipVariant = 'permission' | 'running' | 'error' | 'idle' | 'ended' | 'live' | 'paused' | 'archived';

const STATE_CHIP_STYLES: Record<StateChipVariant, { bg: string; color: string; border?: string }> = {
  permission: { bg: 'rgba(229,168,59,0.18)',  color: 'var(--text-on-fill)', border: 'none' },
  running:    { bg: 'rgba(76,195,138,0.18)',   color: 'var(--text-on-fill)', border: 'none' },
  error:      { bg: 'var(--error)',             color: '#fff',           border: 'none' },
  idle:       { bg: 'var(--border)',            color: 'var(--text-muted)', border: 'none' },
  ended:      { bg: 'var(--border)',            color: 'var(--text-muted)', border: 'none' },
  live:       { bg: 'rgba(76,195,138,0.15)',   color: 'var(--ok)',      border: '1px solid rgba(76,195,138,0.3)' },
  paused:     { bg: 'rgba(229,168,59,0.15)',   color: 'var(--warn)',    border: '1px solid rgba(229,168,59,0.3)' },
  archived:   { bg: 'var(--bg-card)',           color: 'var(--text-muted)', border: '1px solid var(--border-strong)' },
};

interface StateChipProps {
  variant: StateChipVariant;
  label?: string;
}

const STATE_CHIP_LABELS: Record<StateChipVariant, string> = {
  permission: 'PERMISSION',
  running:    'RUNNING',
  error:      'ERROR',
  idle:       'IDLE',
  ended:      'ENDED',
  live:       'LIVE',
  paused:     'PAUSED',
  archived:   'ARCHIVED',
};

export function StateChip({ variant, label }: StateChipProps) {
  const { bg, color, border } = STATE_CHIP_STYLES[variant];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        borderRadius: 4,
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        fontFamily: 'var(--font-ui)',
        background: bg,
        color,
        border: border ?? 'none',
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {label ?? STATE_CHIP_LABELS[variant]}
    </span>
  );
}

// ─── CollapsibleFolderHeader ────────────────────────────────────────────────
// Shared expand/collapse header (name + item count badge) for sidebar folder
// sections in Sessions and Prompts views. Item ordering/persistence stays
// with the caller since it differs per domain (reorderable bookmarks vs.
// read-only highlights).

interface CollapsibleFolderHeaderProps {
  expanded: boolean;
  onToggle: () => void;
  name: string;
  count: number;
}

export function CollapsibleFolderHeader({ expanded, onToggle, name, count }: CollapsibleFolderHeaderProps) {
  return (
    <button
      onClick={onToggle}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', background: 'none', border: 'none', cursor: 'pointer',
        color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 11,
        textAlign: 'left',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
    >
      <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>{expanded ? '▼' : '▶'}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <span style={{
        fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 10, padding: '0 5px',
      }}>
        {count}
      </span>
    </button>
  );
}

// ─── Meter ───────────────────────────────────────────────────────────────────
// 4–5px track, filled by utilization. Ctx meters have a tick at 80%.

interface MeterProps {
  value: number;       // 0–100
  showTick?: boolean;  // show compact threshold tick at 80%
  height?: number;
  width?: number | string;
}

function meterColor(value: number): string {
  if (value >= 75) return 'var(--error)';
  if (value >= 60) return 'var(--warn)';
  return 'var(--accent)';
}

export function Meter({ value, showTick = false, height = 4, width = '100%' }: MeterProps) {
  const color = meterColor(value);
  return (
    <div
      style={{
        position: 'relative',
        width,
        height,
        background: 'var(--border)',
        borderRadius: height,
        overflow: 'visible',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: `${Math.min(100, Math.max(0, value))}%`,
          height: '100%',
          background: color,
          borderRadius: height,
          transition: 'width 0.4s ease, background 0.3s ease',
        }}
      />
      {/* Compact threshold tick at 80% */}
      {showTick && (
        <div
          style={{
            position: 'absolute',
            left: '80%',
            top: -1,
            width: 1,
            height: height + 2,
            background: 'var(--text-faint)',
            borderRadius: 1,
          }}
        />
      )}
    </div>
  );
}

// ─── RiskTag ─────────────────────────────────────────────────────────────────
// Text-only risk label (not a badge). LOW/MEDIUM/HIGH.

export type RiskLevel = 'low' | 'medium' | 'high';

const RISK_COLORS: Record<RiskLevel, string> = {
  low:    'var(--ok)',
  medium: 'var(--warn)',
  high:   'var(--error)',
};

interface RiskTagProps {
  level: RiskLevel;
  dot?: boolean;
}

export function RiskTag({ level, dot = false }: RiskTagProps) {
  const color = RISK_COLORS[level];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color, fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block' }} />}
      {level.toUpperCase()}
    </span>
  );
}

// ─── FilterChip ──────────────────────────────────────────────────────────────
// Neutral active state: --bg-selected fill + --border-strong border.

interface FilterChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  riskOutline?: boolean; // risk chip uses warn outline instead of neutral
}

export function FilterChip({ label, active, onClick, riskOutline = false }: FilterChipProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 9px',
        borderRadius: 5,
        fontSize: 11,
        fontWeight: active ? 500 : 400,
        fontFamily: 'var(--font-ui)',
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s',
        background: active ? 'var(--bg-selected)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        border: active
          ? riskOutline
            ? `1px solid var(--warn)`
            : `1px solid var(--border-strong)`
          : '1px solid transparent',
        userSelect: 'none',
      }}
    >
      {label}
    </button>
  );
}

// ─── SegmentedControl ──────────────────────────────────────────────────────
// Exactly-one-selected control (sort mode, All/Bookmarked, etc). Re-clicking the
// active segment is a no-op by construction — callers just re-set the same value.

interface SegmentedControlProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

export function SegmentedControl<T extends string>({ options, value, onChange }: SegmentedControlProps<T>) {
  return (
    <div style={{ display: 'inline-flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: 2, gap: 2 }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 10.5,
              padding: '3px 9px',
              borderRadius: 4,
              border: 'none',
              background: active ? 'var(--bg-selected)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-muted)',
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── SearchInput ─────────────────────────────────────────────────────────────
// Supports +include −exclude tokens visually.

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  width?: number | string;
  minWidth?: number | string;
  maxWidth?: number | string;
  flex?: number | string;
  padding?: string;
  fontSize?: number;
  inputRef?: React.Ref<HTMLInputElement>;
}

export function SearchInput({ value, onChange, placeholder = 'Search  +include  −exclude', width = '100%', minWidth, maxWidth, flex, padding = '5px 10px', fontSize = 11, inputRef }: SearchInputProps) {
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width,
        minWidth,
        maxWidth,
        flex,
        padding,
        fontSize,
        fontFamily: 'var(--font-mono)',
        background: 'var(--bg-card)',
        border: '1px solid var(--border-strong)',
        borderRadius: 6,
        color: 'var(--text)',
        outline: 'none',
        transition: 'border-color 0.15s',
        boxSizing: 'border-box',
      }}
      onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--text-faint)')}
      onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-strong)')}
    />
  );
}

// ─── LiveChip ────────────────────────────────────────────────────────────────
// live/paused/archived states for the Logs toolbar.

export type LiveChipState = 'live' | 'paused' | 'archived';

interface LiveChipProps {
  state: LiveChipState;
  buffered?: number;
  archivedDate?: string;
}

export function LiveChip({ state, buffered, archivedDate }: LiveChipProps) {
  if (state === 'live') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 9px', borderRadius: 5, fontSize: 11,
        fontFamily: 'var(--font-ui)', fontWeight: 500,
        background: 'rgba(76,195,138,0.12)',
        color: 'var(--ok)',
        border: '1px solid rgba(76,195,138,0.25)',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', boxShadow: '0 0 6px var(--ok)cc', display: 'inline-block' }} />
        LIVE · following
      </span>
    );
  }
  if (state === 'paused') {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '3px 9px', borderRadius: 5, fontSize: 11,
        fontFamily: 'var(--font-ui)', fontWeight: 500,
        background: 'rgba(229,168,59,0.12)',
        color: 'var(--warn)',
        border: '1px solid rgba(229,168,59,0.25)',
      }}>
        ⏸ PAUSED{buffered ? ` · ${buffered} buffered` : ''}
      </span>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 9px', borderRadius: 5, fontSize: 11,
      fontFamily: 'var(--font-ui)',
      background: 'var(--bg-card)',
      color: 'var(--text-muted)',
      border: '1px solid var(--border-strong)',
    }}>
      ◷ ARCHIVED{archivedDate ? ` · ${archivedDate}` : ''}
    </span>
  );
}

// ─── JumpToLatest ─────────────────────────────────────────────────────────────
// Floating pill shown when paused with new events.

interface JumpToLatestProps {
  count: number;
  onClick: () => void;
}

export function JumpToLatest({ count, onClick }: JumpToLatestProps) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', borderRadius: 20,
        fontSize: 11, fontFamily: 'var(--font-ui)', fontWeight: 500,
        background: 'var(--bg-pill)',
        color: 'var(--text)',
        border: '1px solid var(--border-strong)',
        cursor: 'pointer',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-selected)')}
      onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-pill)')}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block' }} />
      ↓ Jump to latest · {count} new
    </button>
  );
}

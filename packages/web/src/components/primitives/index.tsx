import React, { useState } from 'react';
import { useInlineEdit } from '../../hooks/useInlineEdit.js';
import { useSessionStore, instanceUrlOf } from '../../stores/sessionStore.js';
import { buildUrl } from '../../lib/layman-url.js';
import type { LaymanRoute, RouteOptions } from '../../lib/layman-url.js';

// ─── DepthButton ────────────────────────────────────────────────────────────
// Shared colored icon button for the two analysis depths (Investigation
// panel's LAYMAN'S TERMS / ANALYSIS / Failure Analysis section headers and
// empty states). Quick = green bolt (--ok tint), Detailed = blue magnifier
// (--info tint).

export function BoltIcon({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1 3 9h4l-1.5 6L12 7H8l1.5-6Z" />
    </svg>
  );
}

export function MagnifierIcon({ size = 9, strokeWidth = 1.8 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="14" y2="14" />
    </svg>
  );
}

interface DepthButtonProps {
  depth: 'quick' | 'detailed';
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
}

const DEPTH_BUTTON_STYLES = {
  quick:    { color: 'var(--ok)',   bg: 'rgba(76,195,138,0.12)', bgHover: 'rgba(76,195,138,0.2)', border: '1px solid rgba(76,195,138,0.3)',  label: 'Quick' },
  detailed: { color: 'var(--info)', bg: 'rgba(90,156,248,0.12)', bgHover: 'rgba(90,156,248,0.2)',  border: '1px solid rgba(90,156,248,0.25)', label: 'Detailed' },
} as const;

export function DepthButton({ depth, onClick, disabled, loading, loadingLabel = 'Working…' }: DepthButtonProps) {
  const { color, bg, bgHover, border, label } = DEPTH_BUTTON_STYLES[depth];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', fontSize: 10, borderRadius: 4,
        fontWeight: 500, fontFamily: 'var(--font-ui)', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1, background: bg, color, border, transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = bgHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = bg; }}
    >
      {depth === 'quick' ? <BoltIcon /> : <MagnifierIcon />}
      {loading ? loadingLabel : label}
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
// with the caller since it differs per domain. Rename/delete/drag props are
// optional in case a future read-only call site needs to omit them.

interface CollapsibleFolderHeaderProps {
  expanded: boolean;
  onToggle: () => void;
  name: string;
  count: number;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  draggable?: boolean;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragEnd?: () => void;
}

export function CollapsibleFolderHeader({
  expanded, onToggle, name, count, onRename, onDelete,
  draggable = false, isDragOver = false, onDragStart, onDragOver, onDragEnd,
}: CollapsibleFolderHeaderProps) {
  const [hovered, setHovered] = useState(false);
  const { editing, setEditing, editName, setEditName, commitRename, handleKeyDown, inputRef } =
    useInlineEdit(name, (next) => onRename?.(next));

  const startEditing = () => {
    setEditName(name);
    setEditing(true);
  };

  return (
    <div
      draggable={draggable && !editing}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart?.(); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver?.(); }}
      onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '5px 12px', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 11,
        background: isDragOver ? 'var(--bg-selected)' : 'transparent',
        outline: isDragOver ? '1px dashed var(--info)' : 'none',
        outlineOffset: -1,
        transition: 'background 0.1s',
      }}
    >
      <button
        onClick={onToggle}
        style={{
          flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          color: 'inherit', font: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 9, color: 'var(--text-faint)', flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
        {editing ? (
          <input
            ref={inputRef}
            value={editName}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { e.stopPropagation(); handleKeyDown(e); }}
            style={{
              flex: 1, minWidth: 0, fontSize: 11, fontFamily: 'var(--font-ui)',
              background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
              borderRadius: 3, color: 'var(--text)', padding: '1px 4px', outline: 'none',
            }}
          />
        ) : (
          <span
            onDoubleClick={(e) => { if (onRename) { e.stopPropagation(); startEditing(); } }}
            style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {name}
          </span>
        )}
        {!editing && (
          <span style={{
            fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--text-faint)',
            background: 'var(--bg-card)', border: '1px solid var(--border)',
            borderRadius: 10, padding: '0 5px', flexShrink: 0,
          }}>
            {count}
          </span>
        )}
      </button>

      {!editing && (onRename || onDelete) && (
        <div style={{ display: 'flex', gap: 2, flexShrink: 0, opacity: hovered ? 1 : 0, transition: 'opacity 0.1s' }}>
          {onRename && (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); startEditing(); }}
              title="Rename folder"
              style={{ fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer', padding: '1px 3px' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
            >
              ✎
            </span>
          )}
          {onDelete && (
            <span
              role="button"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title="Delete folder"
              style={{ fontSize: 10, color: 'var(--text-faint)', cursor: 'pointer', padding: '1px 3px' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--error)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
            >
              ✕
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ─── FolderSectionHeader ─────────────────────────────────────────────────────
// Section label (e.g. "Bookmarked", "Folders") for the Sessions/Prompts sidebars
// with a right-aligned "+" — vertically aligned with the per-folder count badges
// — that reveals an inline name input to create a folder. Replaces the old
// full-width "New folder" row, which sat awkwardly at the bottom of the list
// (below History), reading as if it belonged to that section.

interface FolderSectionHeaderProps {
  label: React.ReactNode;
  onCreate: (name: string) => void;
}

export function FolderSectionHeader({ label, onCreate }: FolderSectionHeaderProps) {
  const { editing, setEditing, editName, setEditName, commitRename, handleKeyDown, inputRef } =
    useInlineEdit('', onCreate);

  return (
    <>
      <div style={{ ...SECTION_LABEL_STYLE, justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>{label}</span>
        <button
          onClick={() => setEditing(true)}
          title="New folder"
          aria-label="New folder"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            color: 'var(--text-faint)', fontSize: 14, lineHeight: 1, flexShrink: 0,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
        >
          +
        </button>
      </div>
      {editing && (
        <div style={{ padding: '4px 12px' }}>
          <input
            ref={inputRef}
            value={editName}
            placeholder="Folder name…"
            onChange={(e) => setEditName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
            style={{
              width: '100%', fontSize: 11, fontFamily: 'var(--font-ui)',
              background: 'var(--bg-card)', border: '1px solid var(--border-strong)',
              borderRadius: 4, color: 'var(--text)', padding: '3px 6px', outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}
    </>
  );
}

// ─── ConfirmDialog ───────────────────────────────────────────────────────────
// Centered modal overlay for destructive confirmations (delete session,
// delete folder, etc). Shared across Sessions and Prompts views.

interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ title, body, confirmLabel = 'Delete', onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
    }}>
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 10, padding: 24, maxWidth: 360, width: '100%', margin: '0 16px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', margin: '0 0 8px' }}>{title}</h3>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.5 }}>
          {body}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '5px 12px', fontSize: 11, borderRadius: 5,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '5px 12px', fontSize: 11, borderRadius: 5,
              background: 'var(--error)', border: '1px solid var(--error)',
              color: '#fff', cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
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

// ─── CopyLinkButton ─────────────────────────────────────────────────────────
// Copies an addressable Layman URL (see lib/layman-url.ts). The feature is
// worthless if the user cannot get the URL out of the UI, so this sits on every
// surface that has an address: session headers, turn headers, highlight details,
// log rows and dashboard session cards.

export function CopyLinkButton({
  route,
  opts,
  title = 'Copy link',
  size = 11,
  label,
}: {
  route: LaymanRoute;
  opts?: RouteOptions;
  title?: string;
  size?: number;
  /** Optional text beside the icon; icon-only when omitted. */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const config = useSessionStore((s) => s.config);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const url = buildUrl(instanceUrlOf(config), route, opts);
    // clipboard is unavailable over plain HTTP on a non-loopback origin, which
    // is exactly how a hub gets browsed — fall back to a prompt-free selection.
    navigator.clipboard?.writeText(url).catch(() => {
      const field = document.createElement('textarea');
      field.value = url;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      document.body.removeChild(field);
    });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={handleCopy}
      title={copied ? 'Copied' : title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', padding: 0, cursor: 'pointer',
        fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1,
        color: copied ? 'var(--ok)' : 'var(--text-faint)',
        transition: 'color 0.1s',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => { if (!copied) e.currentTarget.style.color = 'var(--text)'; }}
      onMouseLeave={(e) => { if (!copied) e.currentTarget.style.color = 'var(--text-faint)'; }}
    >
      {copied ? (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06L6.75 10.19l5.97-5.97a.75.75 0 0 1 1.06 0Z"/>
        </svg>
      ) : (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
          <path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z"/>
        </svg>
      )}
      {(label || copied) && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

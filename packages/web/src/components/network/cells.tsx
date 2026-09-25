/**
 * Cells shared by the network views' rows: the allow/block toggle, the
 * sparkline, and a state or route text with its icon. Drawn from
 * network-ledger.dc.html and state-legend.dc.html.
 */
import React from 'react';
import type { ToggleKind } from '../../lib/net-format.js';
import type { CellText } from '../../lib/net-table.js';
import type { RateBucket } from '../../lib/netobs-types.js';
import { NetIcon, type NetIconName } from './netui.js';

/** Why toggles are read-only until Layman can write rules (phase 4 of the plan). */
export const READ_ONLY_REASON = 'Read-only: Layman does not change rules yet. Edit rules.json, or use `glove net block`.';

const VERB: Record<ToggleKind, (target: string) => string> = {
  allow: (t) => `Block ${t}`,
  block: (t) => `Unblock ${t}`,
  default: (t) => `Allow ${t}`,
  locked: (t) => `${t} is refused by glove’s guard`,
  pending: (t) => `${t}: waiting for the gate`,
  none: (t) => t,
};

const LOCKED_TITLE = 'Refused by glove’s built-in guard before any rule runs. No rule can allow it.';

/**
 * The allow/block toggle (plan §6.3). A real button with `aria-pressed` and a
 * verb-and-target label, so it reads right to a screen reader even while it is
 * read-only. `locked` is always disabled: glove's guard is not negotiable.
 */
export function NetToggle({ kind, target, disabledReason = READ_ONLY_REASON }: {
  kind: ToggleKind;
  target: string;
  /** Null when the toggle acts (phase 4). */
  disabledReason?: string | null;
}) {
  if (kind === 'none') return null;
  const label = VERB[kind](target);
  const on = kind === 'allow';
  const red = kind === 'block' || kind === 'default';
  const base: React.CSSProperties = {
    position: 'relative', width: 30, height: 16, borderRadius: 8, flexShrink: 0, padding: 0,
    cursor: disabledReason === null && kind !== 'locked' ? 'pointer' : 'default',
  };
  let style: React.CSSProperties;
  let knob: React.CSSProperties | null = { position: 'absolute', top: 1, width: 12, height: 12, borderRadius: 6 };
  switch (kind) {
    case 'allow':
      style = { ...base, border: '1px solid var(--net-tunnel)', background: 'rgba(53,201,180,0.9)' };
      knob = { ...knob, left: 15, background: 'var(--bg)' };
      break;
    case 'block':
      style = { ...base, border: '1px solid var(--error)', background: 'rgba(240,86,74,0.9)' };
      knob = { ...knob, left: 1, background: 'var(--bg)' };
      break;
    case 'default':
      style = { ...base, border: '1px solid var(--error)', background: 'transparent' };
      knob = { ...knob, left: 1, background: 'var(--error)' };
      break;
    case 'pending':
      style = { ...base, border: '1px solid var(--warn)',
        background: 'repeating-linear-gradient(135deg, rgba(229,168,59,0.35) 0 3px, transparent 3px 6px)' };
      knob = { ...knob, left: 8, background: 'var(--warn)' };
      break;
    case 'locked':
      style = { ...base, border: '1px dashed var(--warn)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' };
      knob = null;
      break;
  }
  const disabled = kind === 'locked' || disabledReason !== null;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={kind === 'locked' ? LOCKED_TITLE : disabledReason ? `${label}. ${disabledReason}` : label}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      style={{ ...style, opacity: disabled && kind !== 'locked' ? 0.85 : 1, outlineColor: red ? 'var(--error)' : undefined }}
    >
      {knob && <span style={knob} />}
      {kind === 'locked' && <NetIcon name="lock" size={9} color="var(--warn)" strokeWidth={1.6} />}
    </button>
  );
}

const SPARK_SPAN_MS = 60_000;

/**
 * The last 60 s of a row's bytes, sent and received together, ending at the
 * session's latest record. A flat baseline for a row with nothing in the window.
 */
export function Sparkline({ spark, anchor, width = 64, height = 16, colour = 'var(--net-down)' }: {
  spark: readonly RateBucket[];
  anchor: number;
  width?: number;
  height?: number;
  colour?: string;
}) {
  const n = 60;
  const values = new Array<number>(n).fill(0);
  for (const b of spark) {
    const i = n - 1 - Math.floor((anchor - b.t) / (SPARK_SPAN_MS / n));
    if (i >= 0 && i < n) values[i] += b.up + b.down;
  }
  const max = Math.max(...values);
  const y = (v: number) => height - 1.5 - (max ? (v / max) * (height - 3) : 0);
  const points = values.map((v, i) => `${((i / (n - 1)) * width).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={colour} strokeWidth={1.1} strokeLinejoin="round" opacity={max ? 0.95 : 0.35} />
    </svg>
  );
}

/** A state or route: icon and text in the cell's colour. */
export function CellLabel({ cell, size = 11 }: { cell: CellText; size?: number }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: size, color: cell.colourVar, whiteSpace: 'nowrap', minWidth: 0 }}>
      {cell.icon && <NetIcon name={cell.icon as NetIconName} color={cell.colourVar} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{cell.text}</span>
    </span>
  );
}

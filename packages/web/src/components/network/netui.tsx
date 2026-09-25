/**
 * Small building blocks shared by the four network tabs, copied from the
 * mockups in docs/planning/network-mockups/ (sizes, colours and structure).
 */
import React from 'react';
import type { ChipIcon, ChipTone } from '../../lib/net-format.js';

export type NetIconName =
  | ChipIcon
  | 'grip' | 'close' | 'table' | 'map' | 'rules' | 'activity' | 'details' | 'trace' | 'topology'
  | 'eye-off' | 'globe' | 'pin' | 'legend' | 'ribbon'
  | 'lock' | 'blocked' | 'broken' | 'cut' | 'home' | 'fold' | 'chevron' | 'search' | 'up' | 'down' | 'expand';

const PATHS: Record<NetIconName, React.ReactNode> = {
  pulse: <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />,
  tunnel: <><path d="M2 13V8a6 6 0 0112 0v5" /><path d="M5 13V8.5a3 3 0 016 0V13" /></>,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  shield: <path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z" />,
  file: <><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></>,
  alert: <><path d="M8 2.5l6 10.5H2z" /><path d="M8 7v2.5M8 11.5v.01" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  direct: <><path d="M2 8h11" /><path d="M10 5l3 3-3 3" /></>,
  grip: <>{[4, 8, 12].flatMap((y) => [6, 10].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="0.9" />))}</>,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  table: <><path d="M5 4h9M5 8h9M5 12h9" /><circle cx="2.8" cy="4" r=".6" /><circle cx="2.8" cy="8" r=".6" /><circle cx="2.8" cy="12" r=".6" /></>,
  map: <><path d="M1.5 4l4-1.5 5 2 4-1.5v9l-4 1.5-5-2-4 1.5z" /><path d="M5.5 2.5v9M10.5 4.5v9" /></>,
  rules: <path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z" />,
  activity: <path d="M2.5 13.5V9M6 13.5V5M9.5 13.5V7.5M13 13.5V3" />,
  details: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6.5 2.5v11" /></>,
  trace: <><circle cx="3.5" cy="8" r="1.5" /><circle cx="12.5" cy="4" r="1.5" /><circle cx="12.5" cy="12" r="1.5" /><path d="M5 7.3l6-2.6M5 8.7l6 2.6" /></>,
  topology: <><path d="M2 4.5l6-2.5 6 2.5-6 2.5z" /><path d="M2 8l6 2.5L14 8" /><path d="M2 11.5L8 14l6-2.5" /></>,
  'eye-off': <><path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z" /><path d="M2.5 2.5l11 11" /></>,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" /></>,
  pin: <><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 00-9 0C3.5 9.8 8 14 8 14z" /><circle cx="8" cy="6.5" r="1.5" /></>,
  legend: <><path d="M2 4.5h3M2 8h3M2 11.5h3" /><path d="M7 4.5h7M7 8h7M7 11.5h7" /></>,
  ribbon: <path d="M2 13.5h12M3.5 11V6M6.5 11V3M9.5 11V7M12.5 11V5" />,
  lock: <><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></>,
  blocked: <><circle cx="8" cy="8" r="5.5" /><path d="M4.1 11.9l7.8-7.8" /></>,
  broken: <path d="M1.5 8h4l1-2M9.5 10l1-2h4" />,
  cut: <><circle cx="4.5" cy="11.5" r="1.8" /><circle cx="11.5" cy="11.5" r="1.8" /><path d="M5.8 10.2L12 3M10.2 10.2L4 3" /></>,
  home: <><path d="M2.5 7.5L8 3l5.5 4.5" /><path d="M4 6.5V13h8V6.5" /></>,
  fold: <path d="M3 8h.01M8 8h.01M13 8h.01" strokeWidth="2.2" />,
  chevron: <path d="M4 6l4 4 4-4" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  expand: <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />,
};

export function NetIcon({ name, size = 12, color = 'currentColor', strokeWidth = 1.4 }: {
  name: NetIconName; size?: number; color?: string; strokeWidth?: number;
}) {
  const filled = name === 'grip';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={filled ? color : 'none'} stroke={color}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}>
      {PATHS[name]}
    </svg>
  );
}

/** Colour, fill and border per chip tone, as the mockups' gate strip draws them. */
export const TONE: Record<ChipTone, { color: string; bg: string; border: string }> = {
  ok: { color: 'var(--ok)', bg: 'rgba(76,195,138,0.12)', border: 'rgba(76,195,138,0.35)' },
  tunnel: { color: 'var(--net-tunnel)', bg: 'rgba(53,201,180,0.12)', border: 'rgba(53,201,180,0.35)' },
  warn: { color: 'var(--warn)', bg: 'rgba(229,168,59,0.12)', border: 'rgba(229,168,59,0.4)' },
  error: { color: '#FF8A80', bg: 'rgba(240,86,74,0.16)', border: 'rgba(240,86,74,0.6)' },
  violet: { color: 'var(--net-up)', bg: 'rgba(181,140,246,0.14)', border: 'rgba(181,140,246,0.45)' },
  neutral: { color: 'var(--text-body)', bg: 'rgba(255,255,255,0.03)', border: 'var(--border-strong)' },
  muted: { color: 'var(--text-muted)', bg: 'rgba(255,255,255,0.02)', border: 'var(--border)' },
};

export function Chip({ tone, icon, label, title, strong }: {
  tone: ChipTone; icon?: NetIconName; label: string; title?: string; strong?: boolean;
}) {
  const t = TONE[tone];
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, height: 20, padding: '0 7px', borderRadius: 10,
      fontSize: 10.5, color: t.color, background: t.bg, border: `1px solid ${t.border}`, whiteSpace: 'nowrap',
      fontWeight: strong ? 700 : 500, letterSpacing: strong ? '0.02em' : undefined, flexShrink: 0,
    }}>
      {icon && <NetIcon name={icon} color={t.color} />}
      {label}
    </span>
  );
}

/**
 * A panel: header with the drag grip, uppercase title, a count and a hide
 * button, then its body. Dragging is by the grip only, so text in the body
 * stays selectable.
 */
export function PanelFrame({ title, count, actions, onHide, drag, dropTarget, children, bodyStyle, flex = '1 1 0' }: {
  title: string;
  count?: React.ReactNode;
  /** Links in the header, before the hide button ("Expand", "View file"). */
  actions?: React.ReactNode;
  onHide?: () => void;
  drag?: { onDragStart: () => void; onDragEnd: () => void; onDragOver: () => void };
  dropTarget?: boolean;
  children: React.ReactNode;
  bodyStyle?: React.CSSProperties;
  /** Share of the column (CSS `flex`). */
  flex?: string;
}) {
  return (
    <section
      onDragOver={drag ? (e) => { e.preventDefault(); drag.onDragOver(); } : undefined}
      onDrop={drag ? (e) => { e.preventDefault(); drag.onDragEnd(); } : undefined}
      style={{
        display: 'flex', flexDirection: 'column', background: 'var(--bg-card)',
        border: `1px solid ${dropTarget ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 8,
        overflow: 'hidden', minHeight: 0, minWidth: 0, flex,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 32, padding: '0 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {drag && (
          <span
            draggable
            onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; drag.onDragStart(); }}
            onDragEnd={drag.onDragEnd}
            title="Drag to rearrange"
            style={{ color: 'var(--text-faint)', cursor: 'grab' }}
          >
            <NetIcon name="grip" color="var(--text-faint)" />
          </span>
        )}
        <h2 style={{ margin: 0, fontSize: 10.5, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          {title}
        </h2>
        {count !== undefined && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>{count}</span>}
        <div style={{ flex: 1 }} />
        {actions}
        {onHide && (
          <button type="button" aria-label={`Hide ${title} panel`} onClick={onHide} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22,
            background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer',
          }}>
            <NetIcon name="close" size={11} color="var(--text-faint)" />
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', ...bodyStyle }}>{children}</div>
    </section>
  );
}

/** Centred explanatory text for an empty panel or view. */
export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, height: '100%', padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {children && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', maxWidth: 520, lineHeight: 1.5 }}>{children}</div>}
      {action}
    </div>
  );
}

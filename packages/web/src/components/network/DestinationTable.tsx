/**
 * The Network tab's destination table (plan §7.1, network-ledger.dc.html):
 * filter, chips, grouping and sort in a toolbar, then group → host → flow rows.
 * All the deciding is in `lib/net-table.ts`; this file draws its rows, and
 * windows them once a session passes 200 rows.
 */
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '../../hooks/useNow.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { formatBytes, type ChipTone } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import {
  WINDOW_THRESHOLD, buildTable, rowHeight, sessionAnchor, toolLabel, windowRange,
  type GroupBy, type SortBy, type StateFilter, type TableRow,
} from '../../lib/net-table.js';
import { controlDisabledReason } from '../../lib/net-rules.js';
import { CellLabel, NetToggle, Sparkline } from './cells.js';
import { ControlPopover } from './ControlPopover.js';
import { NetIcon, TONE } from './netui.js';

interface Column {
  key: string;
  label: string;
  width: number;
  /** Columns that give way first when the panel is narrow. */
  grow?: boolean;
  shrink?: boolean;
  minWidth?: number;
  align?: 'right';
}

const COLUMNS: Column[] = [
  { key: 'toggle', label: '', width: 36 },
  { key: 'dest', label: 'Destination', width: 230, grow: true, minWidth: 160 },
  { key: 'route', label: 'Route', width: 84 },
  { key: 'tool', label: 'Tool', width: 96 },
  { key: 'activity', label: 'Activity', width: 72 },
  { key: 'sent', label: 'Sent', width: 58, align: 'right' },
  { key: 'received', label: 'Received', width: 66, align: 'right' },
  { key: 'flows', label: 'Flows', width: 40, align: 'right' },
  { key: 'last', label: 'Last', width: 60 },
  { key: 'state', label: 'State', width: 170, shrink: true, minWidth: 120 },
];
const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const MIN_TABLE_WIDTH = COLUMNS.reduce((a, c) => a + (c.minWidth ?? c.width), 0) + 8 * (COLUMNS.length - 1) + 24;

function cellStyle(c: Column): React.CSSProperties {
  return {
    flex: `${c.grow ? 1 : 0} ${c.shrink ? 1 : 0} ${c.width}px`, minWidth: c.minWidth ?? c.width,
    display: 'flex', alignItems: 'center', justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start', gap: 6, overflow: 'hidden',
  };
}

const FILTERS: Array<{ key: StateFilter; label: string; tone: ChipTone }> = [
  { key: 'all', label: 'All', tone: 'neutral' },
  { key: 'live', label: 'Live', tone: 'tunnel' },
  { key: 'blocked', label: 'Blocked', tone: 'error' },
  { key: 'broken', label: 'Broken', tone: 'warn' },
  { key: 'local', label: 'Local', tone: 'neutral' },
];

const selectStyle: React.CSSProperties = {
  fontSize: 11, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text)',
  borderRadius: 5, padding: '3px 6px', fontFamily: 'var(--font-ui)',
};

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function Row({ row, anchor, selected, onSelect, onExpand, disabledReason, onToggle }: {
  row: TableRow;
  anchor: number;
  selected: boolean;
  onSelect: (row: TableRow) => void;
  onExpand: (key: string) => void;
  disabledReason: string | null;
  onToggle: (row: TableRow, anchor: DOMRect) => void;
}) {
  const top = row.depth === 0;
  const muted = row.kind === 'unwatched' || row.kind === 'more';
  const num = (v: number | null, bytes = true) => (
    <span style={{ ...mono, color: muted ? 'var(--text-faint)' : 'var(--text-body)' }}>
      {v === null ? '—' : bytes ? formatBytes(v) : String(v)}
    </span>
  );
  const indent = row.depth === 0 ? 4 : row.depth === 1 ? 20 : 36;
  let background = 'transparent';
  if (selected) background = 'var(--bg-selected)';
  else if (row.loud) background = 'rgba(240,86,74,0.07)';
  return (
    <div
      role="row"
      aria-selected={selected}
      aria-expanded={row.expandable ? row.expanded : undefined}
      aria-level={row.depth + 1}
      onClick={() => onSelect(row)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, height: rowHeight(row), padding: '0 12px',
        borderBottom: `1px solid ${top ? 'var(--border)' : 'var(--border-subtle)'}`, background,
        boxShadow: selected ? 'inset 2px 0 0 var(--accent)' : row.loud ? 'inset 2px 0 0 var(--error)' : undefined,
        cursor: row.host !== null || row.expandable ? 'pointer' : 'default',
      }}
    >
      <div role="cell" style={cellStyle(COL.toggle)}>
        {(top || row.kind === 'host') && (
          <NetToggle kind={row.toggle} target={row.target} disabledReason={disabledReason} onClick={(a) => onToggle(row, a)} />
        )}
      </div>
      <div role="cell" style={cellStyle(COL.dest)}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: indent, minWidth: 0 }}>
          {row.expandable ? (
            <button
              type="button"
              aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${row.label}`}
              onClick={(e) => { e.stopPropagation(); onExpand(row.key); }}
              style={{ display: 'flex', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                transform: row.expanded ? undefined : 'rotate(-90deg)', transition: 'transform 120ms' }}
            >
              <NetIcon name="chevron" size={11} color="var(--text-faint)" />
            </button>
          ) : <span style={{ width: 11, flexShrink: 0 }} />}
          <span style={{
            ...(row.mono ? { fontFamily: 'var(--font-mono)', fontSize: 11.5 } : { fontSize: 12, fontWeight: 600 }),
            color: row.kind === 'more' ? 'var(--text-faint)' : row.loud ? '#FF8A80'
              : row.toggle === 'block' ? 'var(--error)' : row.toggle === 'locked' && top ? 'var(--warn)' : muted ? 'var(--text-muted)' : 'var(--text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, minWidth: 0,
          }}>
            {row.label}
          </span>
          {row.sublabel && (
            <span style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 2, minWidth: 0 }}>
              {row.sublabel}
            </span>
          )}
        </span>
      </div>
      <div role="cell" style={cellStyle(COL.route)}>{row.route && <CellLabel cell={row.route} />}</div>
      <div role="cell" style={cellStyle(COL.tool)}>
        {row.tools.length > 0 && (
          <span title={row.tools.join(', ')} style={{ ...mono, fontSize: 10.5, color: muted ? 'var(--text-muted)' : 'var(--net-down)' }}>
            {toolLabel(row.tools[0])}{row.tools.length > 1 ? ` +${row.tools.length - 1}` : ''}
          </span>
        )}
      </div>
      <div role="cell" style={cellStyle(COL.activity)}>
        {row.kind !== 'more' && row.kind !== 'unwatched' && <Sparkline spark={row.spark} anchor={anchor} />}
      </div>
      <div role="cell" style={cellStyle(COL.sent)}>{row.kind !== 'more' && num(row.sent)}</div>
      <div role="cell" style={cellStyle(COL.received)}>{row.kind !== 'more' && num(row.received)}</div>
      <div role="cell" style={cellStyle(COL.flows)}>{row.kind !== 'more' && num(row.flows, false)}</div>
      <div role="cell" style={cellStyle(COL.last)}>
        {row.kind !== 'more' && <span style={{ ...mono, color: row.last?.colourVar ?? 'var(--text-faint)' }}>{row.last?.text ?? '—'}</span>}
      </div>
      <div role="cell" style={cellStyle(COL.state)}>{row.state.text && <CellLabel cell={row.state} />}</div>
    </div>
  );
}

export function DestinationTable({ data }: { data: NetSessionData }) {
  const now = useNow(1000);
  const netDest = useSessionStore((s) => s.netDest);
  const setNetDest = useSessionStore((s) => s.setNetDest);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<StateFilter>('all');
  const [groupBy, setGroupBy] = useState<GroupBy>('domain');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [showEmpty, setShowEmpty] = useState(false);
  const [popover, setPopover] = useState<{ key: string; anchor: DOMRect } | null>(null);
  const disabledReason = controlDisabledReason(data.rules);

  const model = useMemo(
    () => buildTable(data, { groupBy, sortBy, filter, text, toggled, now, showEmpty }),
    [data, groupBy, sortBy, filter, text, toggled, now, showEmpty],
  );
  const anchor = useMemo(() => sessionAnchor(data, now), [data, now]);

  // Windowing: measure the scroller, and render only its rows past the threshold.
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const windowed = model.rows.length > WINDOW_THRESHOLD;
  const range = useMemo(
    () => windowed ? windowRange(model.rows.map(rowHeight), view.top, view.height) : null,
    [windowed, model.rows, view],
  );
  const visible = range ? model.rows.slice(range.start, range.end) : model.rows;

  const expand = (key: string) => setToggled((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const select = (row: TableRow) => {
    if (row.host !== null) setNetDest(netDest === row.host ? null : row.host);
    else if (row.expandable) expand(row.key);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, width: 260, maxWidth: '100%', padding: '0 8px', borderRadius: 6, background: 'var(--bg)', border: '1px solid var(--border)' }}>
          <NetIcon name="search" color="var(--text-faint)" />
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Filter hosts, IPs, tools, rules"
            aria-label="Filter destinations"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 11.5, fontFamily: 'var(--font-ui)' }}
          />
        </label>
        <div role="group" aria-label="Show" style={{ display: 'flex', gap: 6 }}>
          {FILTERS.map((f) => {
            const on = filter === f.key;
            const t = TONE[f.key === 'all' && on ? 'neutral' : f.tone];
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(on && f.key !== 'all' ? 'all' : f.key)}
                style={{
                  display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 7px', borderRadius: 10, fontSize: 10.5,
                  fontWeight: on ? 600 : 500, whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'var(--font-ui)',
                  color: f.key === 'all' ? 'var(--text)' : t.color, background: t.bg,
                  border: `1px solid ${on ? t.color : t.border}`, opacity: on || filter === 'all' ? 1 : 0.6,
                }}
              >
                {f.label} {model.counts[f.key]}
              </button>
            );
          })}
        </div>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Group by</span>
        <select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} style={selectStyle}>
          <option value="domain">Registrable domain</option>
          <option value="route">Route</option>
          <option value="tool">Tool</option>
        </select>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Sort</span>
        <select aria-label="Sort" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)} style={selectStyle}>
          <option value="recent">Most recent</option>
          <option value="bytes">Most bytes</option>
        </select>
      </div>

      <div
        ref={scroller}
        role="table"
        aria-label="Destinations"
        aria-rowcount={model.rows.length}
        onScroll={windowed ? (e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight }) : undefined}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        <div style={{ minWidth: MIN_TABLE_WIDTH }}>
          <div role="row" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: '0 12px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
            {COLUMNS.map((c) => (
              <div key={c.key} role="columnheader" style={cellStyle(c)}>
                <span style={{ fontSize: 10, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{c.label}</span>
              </div>
            ))}
          </div>
          {range && <div style={{ height: range.padTop }} />}
          {visible.map((row) => (
            <Row key={row.key} row={row} anchor={anchor} selected={row.host !== null && row.host === netDest && row.kind !== 'flow'}
              onSelect={select} onExpand={expand} disabledReason={disabledReason}
              onToggle={(r, a) => setPopover({ key: r.key, anchor: a })} />
          ))}
          {range && <div style={{ height: range.padBottom }} />}
          {model.rows.length === 0 && (
            <div style={{ padding: '24px 12px', fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center' }}>
              {data.destinations.size === 0 ? 'No traffic recorded for this session yet.' : 'Nothing matches the filter.'}
            </div>
          )}
          {data.emptyFolded > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', color: 'var(--text-faint)', fontSize: 10.5 }}>
              <NetIcon name="fold" color="var(--text-faint)" />
              {data.emptyFolded} empty connection{data.emptyFolded === 1 ? '' : 's'} folded (eof / timeout, no host) ·
              <button type="button" onClick={() => setShowEmpty((v) => !v)} style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--info)', cursor: 'pointer', fontSize: 10.5, fontFamily: 'var(--font-ui)' }}>
                {showEmpty ? 'hide' : 'show'}
              </button>
            </div>
          )}
        </div>
      </div>
      {popover && (() => {
        // Re-found by key on every render, so the popover follows the row's live data.
        const row = model.rows.find((r) => r.key === popover.key);
        return row ? <ControlPopover row={row} data={data} anchor={popover.anchor} onClose={() => setPopover(null)} /> : null;
      })()}
    </div>
  );
}

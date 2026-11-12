import { useEffect, useRef, useState } from 'react';
import type { StationId } from '../../lib/station.js';
import { STATION_STYLE } from '../../lib/station-style.js';
import { StationGlyph } from './StationGlyph.js';

/**
 * The Logs filter by station: a chip that opens a list of the stations this session's events fall
 * at, with a count each. Picking some shows only their rows; picking none shows everything.
 */
export function StationFilter({
  counts, selected, onToggle, onClear,
}: {
  counts: { station: StationId; count: number }[];
  selected: StationId[];
  onToggle: (station: StationId) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  const active = selected.length > 0;
  const label = selected.length === 1 ? STATION_STYLE[selected[0]].label : active ? `Stations · ${selected.length}` : 'Stations';

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Show only the rows at some stations: the kind of work each event is"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 5,
          fontSize: 11, fontWeight: active ? 500 : 400, fontFamily: 'var(--font-ui)', cursor: 'pointer',
          background: active ? 'var(--bg-selected)' : 'transparent',
          color: active ? 'var(--text)' : 'var(--text-muted)',
          border: active ? '1px solid var(--border-strong)' : '1px solid transparent',
          userSelect: 'none',
        }}
      >
        {selected.length === 1 && <StationGlyph station={selected[0]} size={11} />}
        {label}
        <span style={{ fontSize: 8, color: 'var(--text-faint)' }}>▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label="Stations"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30, minWidth: 190,
            padding: 4, borderRadius: 6, background: 'var(--bg-raised)', border: '1px solid var(--border-strong)',
            boxShadow: '0 6px 20px color-mix(in srgb, var(--bg) 60%, transparent)',
          }}
        >
          {counts.length === 0 && <div style={{ padding: '6px 8px', fontSize: 11, color: 'var(--text-faint)' }}>No events yet</div>}
          {counts.map(({ station, count }) => {
            const on = selected.includes(station);
            return (
              <button
                key={station}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onToggle(station)}
                title={STATION_STYLE[station].about}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '5px 8px', borderRadius: 4,
                  border: 'none', cursor: 'pointer', fontSize: 11, fontFamily: 'var(--font-ui)', textAlign: 'left',
                  background: on ? 'var(--bg-selected)' : 'transparent', color: on ? 'var(--text)' : 'var(--text-body)',
                }}
              >
                <span style={{ width: 10, fontSize: 10, color: 'var(--text-muted)' }}>{on ? '✓' : ''}</span>
                <StationGlyph station={station} />
                <span style={{ flex: 1 }}>{STATION_STYLE[station].label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>{count}</span>
              </button>
            );
          })}
          {active && (
            <button
              type="button"
              onClick={onClear}
              style={{ width: '100%', marginTop: 2, padding: '5px 8px', border: 'none', borderTop: '1px solid var(--border-subtle)', background: 'transparent', color: 'var(--text-faint)', fontSize: 10.5, fontFamily: 'var(--font-ui)', cursor: 'pointer', textAlign: 'left' }}
            >
              Show all stations
            </button>
          )}
        </div>
      )}
    </div>
  );
}

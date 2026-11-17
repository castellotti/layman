import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { HostRow, LogRow } from '../../lib/gibson-feed.js';
import { MENU_BOXES, TONE_WORDS, boxOf, menuOf, toneOf } from '../../lib/gibson-city.js';
import { formatBytes } from '../../lib/net-format.js';
import { rad, sp } from '../../lib/density.js';

/**
 * The menu of the selected tower, as HTML beside the canvas (Gibson 2D now, Gibson 3D in round G3): its log
 * grouped into right-aligned items, and under the picked one up to four boxes. It is the accessible form of the
 * scene's menu, so it is Layman's interface in every scheme (theme tokens), never the picture's colours.
 */
export function GibsonPanel({ host, log, loading, error, gloveToken, onOpenNetwork, onClose }: {
  host: HostRow;
  log: readonly LogRow[];
  loading: boolean;
  error: string | null;
  gloveToken: string | null;
  onOpenNetwork: (token: string, address: string) => void;
  onClose: () => void;
}) {
  const items = useMemo(() => menuOf(log), [log]);
  const [picked, setPicked] = useState<string | null>(null);
  // A new tower starts at its first item; a pick that left the list falls back to the first.
  useEffect(() => setPicked(null), [host.host]);
  const current = items.find((i) => i.key === picked) ?? items[0];
  const tone = toneOf(host);
  const words = TONE_WORDS[tone];

  const options = useRef(new Map<string, HTMLButtonElement>());
  const move = (by: number): void => {
    if (items.length === 0) return;
    const at = Math.max(0, items.findIndex((i) => i.key === current?.key));
    const key = items[Math.min(items.length - 1, Math.max(0, at + by))].key;
    setPicked(key);
    // Focus follows the pick, or a screen reader would not announce it.
    options.current.get(key)?.focus();
  };
  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    e.stopPropagation();
    move(e.key === 'ArrowDown' ? 1 : -1);
  };

  return (
    <aside
      data-print-hide
      aria-label={`${host.host} log`}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      style={{
        width: sp(320), flexShrink: 0, overflowY: 'auto', padding: sp(12), background: 'var(--bg-raised)', color: 'var(--text-body)',
        borderLeft: 'var(--stroke) solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: sp(8) }}>
        <div style={{ flex: 1, minWidth: 0, color: 'var(--text)', fontSize: 13, fontWeight: 600, wordBreak: 'break-all', textTransform: 'uppercase' }}>{host.host}</div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{ padding: sp('0 6px'), borderRadius: rad(4), cursor: 'pointer', color: 'var(--text-muted)', background: 'transparent', border: 'var(--stroke) solid var(--border)' }}
        >
          ×
        </button>
      </div>
      <div style={{ marginTop: sp(4), color: 'var(--text-muted)' }}>
        reached {host.count} {host.count === 1 ? 'time' : 'times'} · sent {formatBytes(host.sent)} · received {formatBytes(host.received)}
      </div>
      {words && (
        <div style={{ color: tone === 'blocked' ? 'var(--error)' : tone === 'untunnelled' ? 'var(--warn)' : 'var(--text-muted)' }}>
          {words[0].toUpperCase() + words.slice(1)}
        </div>
      )}

      <div style={{ marginTop: sp(12) }}>
        {loading && log.length === 0 ? (
          <div style={{ color: 'var(--text-faint)' }}>Reading the log…</div>
        ) : error && log.length === 0 ? (
          <div style={{ color: 'var(--error)' }}>The log could not be read: {error}</div>
        ) : items.length === 0 ? (
          <div style={{ color: 'var(--text-faint)' }}>Nothing recorded for this tower in this window.</div>
        ) : (
          <>
            <div role="listbox" aria-label="Log groups" onKeyDown={onListKey} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: sp(2) }}>
              {items.map((item) => {
                const on = item.key === current?.key;
                return (
                  <button
                    key={item.key}
                    ref={(b) => { if (b) options.current.set(item.key, b); else options.current.delete(item.key); }}
                    type="button"
                    role="option"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setPicked(item.key)}
                    style={{
                      padding: sp('1px 4px'), cursor: 'pointer', textAlign: 'right', letterSpacing: '0.08em', fontSize: 11, fontFamily: 'inherit',
                      color: on ? 'var(--accent-hot)' : 'var(--text-body)', background: 'transparent', border: 'none',
                    }}
                  >
                    {item.label} ▸
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: sp(10), display: 'flex', flexDirection: 'column', gap: sp(6) }}>
              {(current?.rows ?? []).slice(0, MENU_BOXES).map((row, i) => {
                const box = boxOf(row);
                const colour = box.blocked ? 'var(--error)' : 'var(--accent-hot)';
                return (
                  <div key={`${row.time}:${i}`} style={{ padding: sp('4px 8px'), borderRadius: rad(2), border: `var(--stroke) solid ${colour}`, color: colour }}>
                    <div style={{ wordBreak: 'break-all', letterSpacing: '0.06em' }}>{box.title}</div>
                    <div style={{ fontSize: 10, opacity: 0.8 }}>{box.caption}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {gloveToken && (
        <button
          type="button"
          onClick={() => onOpenNetwork(gloveToken, host.host)}
          style={{ marginTop: sp(12), padding: sp('2px 8px'), borderRadius: rad(4), cursor: 'pointer', fontSize: 11, color: 'var(--accent)', background: 'transparent', border: 'var(--stroke) solid var(--border-strong)' }}
        >
          Open in Network
        </button>
      )}
    </aside>
  );
}

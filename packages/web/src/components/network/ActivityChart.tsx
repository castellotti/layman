/**
 * The Network tab's Activity panel: bytes received and sent over time. 1m / 5m / 1h come from
 * the client's own 1 s buckets (it keeps an hour); Session asks Layman's API
 * for the whole run (1 min buckets, then the 1 s tail). The right edge is the
 * session's latest record, so a stopped gate's chart freezes rather than drains.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { clockTime, rateOf, sessionAnchor } from '../../lib/net-table.js';
import type { RateBucket } from '../../lib/netobs-types.js';

type Window = '1m' | '5m' | '1h' | 'session';
const SPAN: Record<Exclude<Window, 'session'>, number> = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 };
const BARS = 60;

/** Sum buckets into `BARS` equal bins over [from, to]. */
export function binBuckets(buckets: readonly RateBucket[], from: number, to: number, bars = BARS): RateBucket[] {
  const width = Math.max(1, (to - from) / bars);
  const out = Array.from({ length: bars }, (_, i) => ({ t: from + i * width, up: 0, down: 0 }));
  for (const b of buckets) {
    if (b.t < from || b.t > to) continue;
    const i = Math.min(bars - 1, Math.floor((b.t - from) / width));
    out[i].up += b.up;
    out[i].down += b.down;
  }
  return out;
}

export function ActivityChart({ data, now }: { data: NetSessionData; now: number }) {
  const [win, setWin] = useState<Window>('5m');
  const [session, setSession] = useState<RateBucket[] | null>(null);
  const anchor = sessionAnchor(data, now);

  useEffect(() => {
    if (win !== 'session') return;
    let live = true;
    fetch(`/api/net/sessions/${encodeURIComponent(data.token)}/buckets?window=session`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { buckets?: RateBucket[] } | null) => { if (live) setSession(j?.buckets ?? []); })
      .catch(() => { if (live) setSession([]); });
    return () => { live = false; };
  }, [win, data.token, data.totals.flows]);

  const buckets = useMemo(() => [...data.buckets.values()], [data.buckets]);
  const src = win === 'session' ? session ?? [] : buckets;
  const from = win === 'session' ? (src[0]?.t ?? anchor - 60_000) : anchor - SPAN[win];
  const bins = useMemo(() => binBuckets(src, from, anchor), [src, from, anchor]);
  const max = Math.max(1, ...bins.map((b) => Math.max(b.up, b.down)));
  const sums = bins.reduce((a, b) => [a[0] + b.down, a[1] + b.up], [0, 0]);
  const recent = [...buckets].filter((b) => b.t > anchor - 3000);
  const down = rateOf(recent.map((b) => ({ ...b, up: 0 })), anchor);
  const up = rateOf(recent.map((b) => ({ ...b, down: 0 })), anchor);

  const H = 100;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '8px 12px', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: 'var(--text-body)' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--net-down)', marginRight: 5 }} />Received <b style={{ fontFamily: 'var(--font-mono)' }}>{formatBytes(sums[0])}</b></span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, background: 'var(--net-up)', marginRight: 5 }} />Sent <b style={{ fontFamily: 'var(--font-mono)' }}>{formatBytes(sums[1])}</b></span>
        <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>now ↓ {formatBytes(down)}/s · ↑ {formatBytes(up)}/s</span>
        <span style={{ flex: 1 }} />
        <div role="group" aria-label="Window" style={{ display: 'flex', gap: 2 }}>
          {(['1m', '5m', '1h', 'session'] as const).map((w) => (
            <button key={w} type="button" aria-pressed={win === w} onClick={() => setWin(w)} style={{
              height: 22, padding: '0 8px', borderRadius: 5, fontSize: 10.5, cursor: 'pointer', fontFamily: 'var(--font-ui)',
              border: `1px solid ${win === w ? 'var(--border-strong)' : 'transparent'}`, background: win === w ? 'var(--bg-selected)' : 'transparent',
              color: win === w ? 'var(--text)' : 'var(--text-faint)',
            }}>{w === 'session' ? 'Session' : w}</button>
          ))}
        </div>
      </div>
      <svg width="100%" height="100%" viewBox={`0 0 ${BARS * 10} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Received ${formatBytes(sums[0])} and sent ${formatBytes(sums[1])} over the window`} style={{ flex: 1, minHeight: 60 }}>
        <line x1={0} x2={BARS * 10} y1={H - 0.5} y2={H - 0.5} stroke="var(--border-strong)" />
        {bins.map((b, i) => (
          <g key={i}>
            <rect x={i * 10 + 1} width={4.5} y={H - (b.down / max) * (H - 4)} height={(b.down / max) * (H - 4)} fill="var(--net-down)" />
            <rect x={i * 10 + 5.5} width={3.5} y={H - (b.up / max) * (H - 4)} height={(b.up / max) * (H - 4)} fill="var(--net-up)" />
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
        <span>{clockTime(from)}</span><span>{clockTime(from + (anchor - from) / 2)}</span><span>now</span>
      </div>
    </div>
  );
}

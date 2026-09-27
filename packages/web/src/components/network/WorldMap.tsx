/**
 * The world map (plan §7.2): Natural Earth land from `world-atlas`, bundled
 * and loaded lazily as its own chunk — nothing is fetched from anywhere at run
 * time — drawn with `d3-geo`. The geometry decisions are in `lib/net-geo.ts`.
 *
 * Land and graticule are projected once per size change and panned/zoomed with
 * an SVG transform (non-scaling strokes); pins and labels are placed in screen
 * space so they stay crisp. The sandbox is a screen point (the card in a
 * corner), never a map location.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { geoGraticule10, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import type { FeatureCollection, Geometry } from 'geojson';
import type { NetSessionData } from '../../lib/net-state.js';
import {
  arcPath, clusterDestinations, fitBounds, makeProjection, screenCurve, strokeWidth, trunkFor, type Insets, type LonLat,
} from '../../lib/net-geo.js';
import { NetIcon } from './netui.js';

type Land = FeatureCollection<Geometry>;
let landCache: Promise<Land> | null = null;
/** The bundled land shapes, in their own chunk. */
function loadLand(): Promise<Land> {
  landCache ??= import('world-atlas/land-50m.json').then((m) => {
    type Topo = Parameters<typeof feature>[0];
    const topo = (m.default ?? m) as unknown as Topo;
    return feature(topo, topo.objects.land as Parameters<typeof feature>[1]) as unknown as Land;
  });
  return landCache;
}

interface View { k: number; x: number; y: number }
const IDENTITY: View = { k: 1, x: 0, y: 0 };

export function WorldMap({ data, selected, onSelect, compact = false, sandboxAnchor, insets }: {
  data: NetSessionData;
  /** The selected destination's host. */
  selected: string | null;
  onSelect?: (host: string | null) => void;
  /** The Network tab's mini map: no labels, no pan or zoom. */
  compact?: boolean;
  /** Where the sandbox card is, in the map's own pixels; defaults to the bottom-left corner. */
  sandboxAnchor?: [number, number];
  /** Room to leave for cards floating over the map when fitting it. */
  insets?: Insets;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [land, setLand] = useState<Land | null>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const drag = useRef<{ x: number; y: number; v: View } | null>(null);

  useEffect(() => {
    let live = true;
    loadLand().then((l) => { if (live) setLand(l); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 500 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A different session is a different map.
  useEffect(() => setView(IDENTITY), [data.token]);

  const dests = useMemo(() => [...data.destinations.values()], [data.destinations]);
  const clusters = useMemo(() => clusterDestinations(dests), [dests]);
  const trunk = useMemo(() => trunkFor(data.gate, data.exit), [data.gate, data.exit]);

  // The projection fits the exit and the mapped destinations; it changes only when the set of places does.
  const placesKey = clusters.map((c) => c.key).join(',') + (trunk.exit ? `|${trunk.exit.join(',')}` : '');
  const projection = useMemo(() => {
    const pts: LonLat[] = clusters.map((c) => [c.lon, c.lat]);
    if (trunk.exit) pts.push(trunk.exit);
    return makeProjection(size.w, size.h, fitBounds(pts), compact ? 16 : insets ?? 56);
  }, [placesKey, size.w, size.h, compact, insets?.left, insets?.right, insets?.top, insets?.bottom]); // eslint-disable-line react-hooks/exhaustive-deps

  const path = useMemo(() => geoPath(projection), [projection]);
  const landD = useMemo(() => (land ? path(land) ?? '' : ''), [land, path]);
  const gratD = useMemo(() => path(geoGraticule10()) ?? '', [path]);

  const base = (p: LonLat) => projection(p) as [number, number] | null;
  const toScreen = ([x, y]: [number, number]): [number, number] => [x * view.k + view.x, y * view.k + view.y];
  const sandbox: [number, number] = sandboxAnchor ?? (compact ? [14, size.h - 14] : [40, size.h - 150]);
  const exitScreen = trunk.exit ? (() => { const b = base(trunk.exit!); return b ? toScreen(b) : null; })() : null;
  const maxBytes = Math.max(1, ...clusters.flatMap((c) => c.dests.map((d) => d.bytesUp + d.bytesDown)));

  // Wheel zoom about the cursor; drag to pan.
  useEffect(() => {
    const el = ref.current;
    if (!el || compact) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const k = Math.min(12, Math.max(1, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [compact]);
  const zoomBy = (f: number) => setView((v) => {
    const k = Math.min(12, Math.max(1, v.k * f));
    const cx = size.w / 2;
    const cy = size.h / 2;
    return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
  });

  const direct = dests.filter((d) => d.scope === 'direct' && d.geo);
  // A drag never starts on a pin or a control: its pointer capture would steal their click.
  const g = `translate(${view.x},${view.y}) scale(${view.k})`;

  return (
    <div
      ref={ref}
      onPointerDown={compact ? undefined : (e) => { if ((e.target as Element).closest('[data-pin], button')) return; drag.current = { x: e.clientX, y: e.clientY, v: view }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
      onPointerMove={compact ? undefined : (e) => { const d = drag.current; if (d) setView({ ...d.v, x: d.v.x + e.clientX - d.x, y: d.v.y + e.clientY - d.y }); }}
      onPointerUp={compact ? undefined : () => { drag.current = null; }}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--net-ocean)', cursor: compact ? 'pointer' : drag.current ? 'grabbing' : 'grab', touchAction: 'none' }}
    >
      <svg width={size.w} height={size.h} role="img" aria-label="Map of where this session's traffic went" style={{ display: 'block' }}>
        <g transform={g}>
          <path d={gratD} fill="none" stroke="var(--net-landline)" strokeWidth={0.5} vectorEffect="non-scaling-stroke" opacity={0.45} />
          <path d={landD} fill="var(--net-land)" stroke="var(--net-landline)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
          {trunk.exit && clusters.map((c) => {
            const live = c.live;
            const w = strokeWidth(c.bytes, maxBytes);
            return c.direct ? null : (
              <path key={`arc-${c.key}`} d={arcPath(base, trunk.exit!, [c.lon, c.lat], size.w)} fill="none"
                stroke="var(--net-tunnel)" strokeWidth={compact ? Math.max(1, w * 0.6) : w} vectorEffect="non-scaling-stroke"
                opacity={live ? 0.95 : 0.4} className={live ? 'net-live-dash' : undefined} strokeLinecap="round" />
            );
          })}
        </g>

        {/* Trunk: sandbox card → exit. Solid when verified, dashed when only declared. */}
        {trunk.kind !== 'none' && exitScreen && (
          <path d={screenCurve(sandbox, exitScreen, 0.12)} fill="none" stroke="var(--net-tunnel)" strokeWidth={compact ? 1.6 : 2.6}
            strokeDasharray={trunk.kind === 'declared' ? '7 5' : undefined} opacity={0.9} className={trunk.kind === 'verified' && clusters.some((c) => c.live) ? 'net-live-dash-trunk' : undefined} />
        )}
        {/* With no exit to pin, arcs leave from the sandbox card itself. */}
        {!trunk.exit && clusters.filter((c) => !c.direct).map((c) => {
          const b = base([c.lon, c.lat]);
          return b ? <path key={`s-${c.key}`} d={screenCurve(sandbox, toScreen(b))} fill="none" stroke="var(--net-tunnel)"
            strokeWidth={strokeWidth(c.bytes, maxBytes)} strokeDasharray="7 5" opacity={c.live ? 0.9 : 0.4} /> : null;
        })}
        {/* Untunnelled: red dashed, straight from the sandbox, skipping the exit. */}
        {direct.map((d) => {
          const b = base([d.geo!.lon, d.geo!.lat]);
          return b ? <path key={`d-${d.key}`} d={screenCurve(sandbox, toScreen(b), 0.2)} fill="none" stroke="var(--error)"
            strokeWidth={2.2} strokeDasharray="6 5" opacity={0.95} /> : null;
        })}

        {exitScreen && (
          <g>
            <circle cx={exitScreen[0]} cy={exitScreen[1]} r={compact ? 4 : 7} fill="var(--net-tunnel)" />
            <circle cx={exitScreen[0]} cy={exitScreen[1]} r={compact ? 6 : 11} fill="none" stroke="var(--net-tunnel)" strokeOpacity={0.4} />
          </g>
        )}
        {clusters.map((c) => {
          const b = base([c.lon, c.lat]);
          if (!b) return null;
          const [x, y] = toScreen(b);
          const isSel = c.dests.some((d) => d.host === selected);
          const colour = c.direct ? 'var(--error)' : 'var(--net-tunnel)';
          return (
            <g key={`pin-${c.key}`} data-pin="1" style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={(e) => { e.stopPropagation(); onSelect?.(isSel ? null : c.dests[0].host); }}>
              <title>{`${c.label}: ${c.dests.map((d) => d.host).join(', ')}`}</title>
              <circle cx={x} cy={y} r={compact ? 3 : 5} fill="var(--bg)" stroke={colour} strokeWidth={2} />
              {isSel && <circle cx={x} cy={y} r={11} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
            </g>
          );
        })}
      </svg>

      {/* Labels are HTML: crisp at any zoom, and the same pill as the mockup. */}
      {!compact && clusters.map((c) => {
        const b = base([c.lon, c.lat]);
        if (!b) return null;
        const [x, y] = toScreen(b);
        return (
          <span key={`lbl-${c.key}`} style={{ ...pill, left: x + 10, top: y + 6, borderColor: c.direct ? 'rgba(240,86,74,0.6)' : 'var(--border-strong)' }}>
            {c.label}{c.dests.length > 1 ? ` · ${c.dests.length}` : ''}
          </span>
        );
      })}
      {!compact && exitScreen && trunk.label && (
        <span style={{ ...pill, left: exitScreen[0] + 14, top: exitScreen[1] + 12, color: 'var(--net-tunnel)', borderColor: 'rgba(53,201,180,0.45)' }}>
          {trunk.label}{trunk.kind === 'declared' ? ' · declared' : ''}
        </span>
      )}
      {!compact && (
        <div style={{ position: 'absolute', right: 12, bottom: 64, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 2 }}>
          {([['+', 1.5, 'Zoom in'], ['−', 1 / 1.5, 'Zoom out']] as const).map(([t, f, label]) => (
            <button key={t} type="button" aria-label={label} onClick={() => zoomBy(f)} style={zoomButton}>{t}</button>
          ))}
          {view.k !== 1 && (
            <button type="button" aria-label="Reset view" onClick={() => setView(IDENTITY)} style={{ ...zoomButton, fontSize: 10 }}>
              <NetIcon name="expand" size={11} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const pill: React.CSSProperties = {
  position: 'absolute', transform: 'translateY(-50%)', padding: '1px 7px', borderRadius: 9, fontSize: 10.5, whiteSpace: 'nowrap',
  color: 'var(--text-body)', background: 'rgba(11,14,20,0.82)', border: '1px solid var(--border-strong)', pointerEvents: 'none',
  fontFamily: 'var(--font-ui)',
};
const zoomButton: React.CSSProperties = {
  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer',
  background: 'var(--bg-card)', border: '1px solid var(--border-strong)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-ui)',
};

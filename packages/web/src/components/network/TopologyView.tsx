/**
 * The Topology tab: the Routes diagram and the
 * Selected path panel. Geometry comes from `lib/net-topology.ts`; this file
 * only draws it. Clicking a destination or a band selects that path (the
 * `netDest` the Map and the Network tab share), which dims every other band.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { TOPOLOGY_BAND_WIDTH_TIP, TOPOLOGY_LEGEND, formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { controlDisabledReason, siblingIds } from '../../lib/net-rules.js';
import { toolLabel } from '../../lib/net-table.js';
import {
  easeScroll, keyScroll, layoutTopology, pathHops, projectTopology, scrollThumb, scrollToDest, thumbDrag, wheelDelta,
  type BandKind, type DestSort, type DestStub, type HopEvidence, type LineTone, type Tone, type TopoBand, type TopoNode, type TopoProjection, type Topology,
} from '../../lib/net-topology.js';
import { buttonStyle } from './ControlPopover.js';
import { Badge, Tile } from './DetailCard.js';
import { NetIcon, useStored } from './netui.js';
import { tipProps } from './NetTip.js';

const BAND: Record<BandKind, { colour: string; opacity: number }> = {
  tunnel: { colour: 'var(--net-tunnel)', opacity: 0.55 },
  fanout: { colour: 'var(--net-fanout)', opacity: 0.65 },
  local: { colour: 'var(--net-local)', opacity: 0.6 },
  direct: { colour: 'var(--error)', opacity: 0.6 },
  guard: { colour: 'var(--warn)', opacity: 0.85 },
  refused: { colour: 'var(--error)', opacity: 0.85 },
  broken: { colour: 'var(--warn)', opacity: 0.85 },
  unwatched: { colour: 'var(--net-local)', opacity: 0.7 },
  trigger: { colour: 'var(--net-fanout)', opacity: 0.9 },
};

const STROKE: Record<Tone, string> = {
  plain: 'var(--border-strong)', tunnel: 'var(--net-tunnel)', fanout: 'var(--net-fanout)', local: 'var(--net-local)',
  direct: 'var(--error)', warn: 'var(--warn)', muted: 'var(--border-strong)',
};

const LINE: Record<LineTone, { colour: string; mono: boolean }> = {
  faint: { colour: 'var(--text-faint)', mono: false },
  mono: { colour: 'var(--text-body)', mono: true },
  ok: { colour: 'var(--net-tunnel)', mono: false },
  tunnel: { colour: 'var(--net-tunnel)', mono: false },
  warn: { colour: 'var(--warn)', mono: false },
  error: { colour: '#FF8A80', mono: false },
  fanout: { colour: 'var(--net-fanout)', mono: false },
};

/** Clip a label to a box without measuring text: ~6.6 px a character at 11 px mono. */
function clip(text: string, width: number, charW = 6.6): string {
  const max = Math.max(4, Math.floor(width / charW));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function useSize(ref: React.RefObject<HTMLDivElement>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 1000, h: 700 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 1000, h: el.clientHeight || 700 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function TopologyLegend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 10.5, color: 'var(--text-body)', overflow: 'hidden', minWidth: 0 }}>
      {TOPOLOGY_LEGEND.map((l) => (
        <span key={l.label} {...tipProps({ heading: l.label, body: l.tip })} tabIndex={0} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          <span style={{ width: 14, height: 3, borderRadius: 2, background: BAND[l.bands[0]].colour }} />{l.label}
        </span>
      ))}
      <span {...tipProps(TOPOLOGY_BAND_WIDTH_TIP)} tabIndex={0} style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>Band width: bytes (square root)</span>
    </div>
  );
}

/** An SVG group that acts as a button: a click, Enter or Space activates it. `tabIndex` -1 keeps it out of the Tab order. */
function svgButton(label: string, activate: () => void, tabIndex = 0) {
  return {
    role: 'button', tabIndex, style: { cursor: 'pointer' }, 'aria-label': label,
    onClick: activate,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } },
  };
}

function Node({ n, selected, onSelect, tabbable = true }: { n: TopoNode; selected: boolean; onSelect: (n: TopoNode) => void; tabbable?: boolean }) {
  const clickable = n.hosts.length > 0 && (n.kind === 'dest' || n.kind === 'broken');
  const common = clickable ? svgButton(`Follow the path to ${n.title}`, () => onSelect(n), tabbable ? 0 : -1) : {};
  if (n.kind === 'broken') {
    return (
      <g {...common} data-node={n.id}>
        <g transform={`translate(${n.x},${n.y - 2})`}><NetIcon name="broken" color="var(--warn)" size={18} strokeWidth={1.8} /></g>
        <text x={n.x} y={n.y + 26} fontSize={11} fontFamily="var(--font-mono)" fill="var(--warn)">{clip(n.title, n.w + 30)}</text>
        <text x={n.x} y={n.y + 39} fontSize={10} fill="var(--text-faint)">{n.lines[0]?.text}</text>
      </g>
    );
  }
  const stroke = selected ? 'var(--info)' : STROKE[n.tone];
  if (n.kind === 'dest') {
    return (
      <g {...common} {...tipProps(n.title)} data-node={n.id}>
        <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} fill={selected ? 'rgba(90,156,248,0.10)' : 'var(--bg-card)'}
          stroke={stroke} strokeWidth={selected ? 1.5 : 1} strokeDasharray={n.dashed ? '3 3' : undefined} />
        <text x={n.x + 8} y={n.y + n.h / 2 + 4} fontSize={11} fontFamily="var(--font-mono)" fill={n.tone === 'direct' ? '#FF8A80' : 'var(--text)'}>
          {clip(n.title, n.w - (n.live ? 22 : 14))}
        </text>
        {n.live && <circle cx={n.x + n.w - 7} cy={n.y + n.h / 2} r={2.5} fill="var(--net-tunnel)" />}
      </g>
    );
  }
  return (
    <g data-node={n.id}>
      <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={5} fill={n.tone === 'muted' && n.dashed ? 'transparent' : 'var(--bg-card)'}
        stroke={stroke} strokeWidth={n.kind === 'sandbox' ? 1.4 : 1} strokeDasharray={n.dashed ? '4 3' : undefined} />
      <text x={n.x + 10} y={n.y + 17} fontSize={12} fontWeight={600} fontFamily={n.mono ? 'var(--font-mono)' : 'var(--font-ui)'}
        fill={n.tone === 'muted' ? 'var(--text-muted)' : 'var(--text)'}>{clip(n.title, n.w - (n.icon ? 34 : 18), 7.2)}</text>
      {n.icon && (
        <g transform={`translate(${n.x + n.w - 20},${n.y + 7})`}>
          <NetIcon name={n.icon} size={12} color={n.icon === 'check' ? 'var(--ok)' : 'var(--text-faint)'} />
        </g>
      )}
      {n.lines.map((l, i) => (
        <text key={i} x={n.x + 10} y={n.y + 31 + i * 13} fontSize={10} fill={LINE[l.tone].colour}
          fontFamily={LINE[l.tone].mono ? 'var(--font-mono)' : 'var(--font-ui)'}>{clip(l.text, n.w - 16, LINE[l.tone].mono ? 6.2 : 5.0)}</text>
      ))}
    </g>
  );
}

/** Destinations scrolled out of the window: the bands converge on it, and it says how many and how much. */
function Stub({ stub, x, onScroll }: { stub: DestStub; x: number; onScroll: (top: number) => void }) {
  return (
    <g data-stub={stub.edge} {...svgButton(`Scroll to the ${stub.count} destinations ${stub.edge}`, () => onScroll(stub.scrollTo))}
      {...tipProps({ heading: `${stub.count} destination${stub.count === 1 ? '' : 's'} ${stub.edge}`, body: stub.hosts.slice(0, 12).join('\n') + (stub.hosts.length > 12 ? `\n+${stub.hosts.length - 12} more` : '') })}>
      <rect x={x - 3} y={stub.bar.y} width={3} height={stub.bar.h} fill="var(--text-faint)" opacity={0.6} />
      <text x={x + 6} y={stub.textY} fontSize={10} fontFamily="var(--font-mono)" fill="var(--text-muted)">
        {stub.edge === 'above' ? '↑' : '↓'} {stub.count} {stub.edge}{stub.bytes ? ` · ${formatBytes(stub.bytes)}` : ''}
      </text>
    </g>
  );
}

const SORTS: Record<DestSort, { label: string; next: DestSort }> = {
  bytes: { label: 'bytes', next: 'name' }, name: { label: 'name', next: 'recent' }, recent: { label: 'last seen', next: 'bytes' },
};
const SORT_KEY = 'layman.topology.destSort';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The stubs' counts, as a key: a frame that changes it must commit. */
const counts = (p: TopoProjection) => `${p.above?.count ?? 0}/${p.below?.count ?? 0}`;

/** Diagram units per screen pixel down the svg `el` is in (the viewBox scales it). */
function unitsPerPx(el: SVGElement | null): number {
  const ctm = el?.ownerSVGElement?.getScreenCTM();
  return ctm && ctm.d ? 1 / ctm.d : 1;
}

/**
 * The destination column's scroll. React renders at the committed scroll; between commits an
 * animation frame moves the rows, the bands into them and the thumb directly through the DOM
 * (`projectTopology` is cheap; re-rendering every band each frame is not). It commits when it
 * lands, and whenever a stub's count changes, so the stubs and the visible set stay right.
 */
function useDestScroll(t: Topology) {
  const [scrollTop, setScrollTop] = useState(0);
  const tRef = useRef(t);
  tRef.current = t;
  const pos = useRef(0);
  const target = useRef(0);
  const frame = useRef<number | null>(null);
  const shown = useRef('');
  const rowsEl = useRef<SVGGElement>(null);
  const thumbEl = useRef<SVGRectElement>(null);
  const bandEls = useRef(new Map<string, SVGGElement>());

  const paint = useCallback((s: number) => {
    const p = projectTopology(tRef.current, s);
    rowsEl.current?.setAttribute('transform', `translate(0,${-p.scrollTop})`);
    const thumb = scrollThumb(tRef.current, p.scrollTop);
    if (thumb) thumbEl.current?.setAttribute('y', String(thumb.y));
    for (const b of p.bands) {
      if (!b.toDest) continue;
      const el = bandEls.current.get(b.id);
      if (el) for (const path of el.querySelectorAll('path')) path.setAttribute('d', b.d);
    }
    if (counts(p) !== shown.current) setScrollTop(p.scrollTop);
  }, []);

  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  /**
   * Scroll to `to`: eased, or at once (`now`, or when the user prefers reduced motion). `live`
   * moves at once without committing, for a drag of the thumb; its end scrolls `now`.
   */
  const scrollTo = useCallback((to: number, how: 'ease' | 'now' | 'live' = 'ease') => {
    const { maxScroll } = tRef.current.dests;
    target.current = Math.max(0, Math.min(maxScroll, to));
    if (how !== 'ease' || reducedMotion()) {
      stop();
      pos.current = target.current;
      paint(pos.current);
      if (how !== 'live') setScrollTop(pos.current);
      return;
    }
    if (frame.current !== null) return;
    let last = performance.now();
    const step = (at: number) => {
      pos.current = easeScroll(pos.current, target.current, at - last);
      last = at;
      paint(pos.current);
      if (pos.current === target.current) { frame.current = null; setScrollTop(pos.current); }
      else frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [paint]);
  useEffect(() => stop, []);

  const view = useMemo(() => projectTopology(t, scrollTop), [t, scrollTop]);
  shown.current = counts(view);
  useLayoutEffect(() => {
    // A new layout can scroll less (a taller pane, destinations gone): the next key or wheel moves from there.
    pos.current = Math.min(pos.current, t.dests.maxScroll);
    target.current = Math.min(target.current, t.dests.maxScroll);
  }, [t]);
  useLayoutEffect(() => {
    // A render mid-animation or mid-drag (live data) drew the bands at the committed scroll: put them back.
    if (pos.current !== view.scrollTop) paint(pos.current);
  });
  const band = useCallback((id: string) => (el: SVGGElement | null) => {
    if (el) bandEls.current.set(id, el);
    else bandEls.current.delete(id);
  }, []);
  return { view, scrollTo, pos, target, rowsEl, thumbEl, band };
}

export function TopologyDiagram({ data }: { data: NetSessionData }) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const netDest = useSessionStore((s) => s.netDest);
  const setNetDest = useSessionStore((s) => s.setNetDest);
  const [sort, setSort] = useStored<DestSort>(SORT_KEY, 'bytes', (raw) => (raw === 'bytes' || raw === 'name' || raw === 'recent' ? raw : null));
  const t = useMemo(() => layoutTopology(data, w, h, { sort }), [data, w, h, sort]);
  const { view, scrollTo, pos, target, rowsEl, thumbEl, band: bandRef } = useDestScroll(t);
  // Another session or order starts at the top.
  useEffect(() => scrollTo(0, 'now'), [data.token, sort, scrollTo]);
  /** Scroll a destination row into the window, if it is not already. */
  const reveal = useCallback((id: string | undefined) => {
    if (!id || projectTopology(t, pos.current).visible.has(id)) return;
    const to = scrollToDest(t, id);
    if (to !== null) scrollTo(to);
  }, [t, pos, scrollTo]);
  // A destination chosen elsewhere (the Network tab, a link) is scrolled into the window: when the
  // choice, the session, the order or the size changes. Never on live data (every delta is a new
  // layout) nor a scroll, or a selected row would pull the column back while the user browses.
  const revealed = useRef('');
  useEffect(() => {
    const key = `${netDest}|${data.token}|${sort}|${w}|${h}`;
    if (key === revealed.current) return;
    revealed.current = key;
    reveal(netDest ? t.nodes.find((n) => n.kind === 'dest' && n.hosts.includes(netDest))?.id : undefined);
  }, [netDest, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const column = useRef<SVGGElement>(null);
  // A wheel over the column scrolls it, not the page: React's wheel listener is passive and cannot say so.
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (t.dests.maxScroll <= 0) return;
      e.preventDefault();
      scrollTo(target.current + wheelDelta(t, e.deltaY, e.deltaMode, unitsPerPx(el)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [t, scrollTo, target]);
  const drag = useRef<{ y: number; from: number; perPx: number } | null>(null);
  const thumb = scrollThumb(t, view.scrollTop);
  const bytesOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data.destinations.values()) if (d.host) m.set(d.host, (m.get(d.host) ?? 0) + d.bytesUp + d.bytesDown);
    return m;
  }, [data.destinations]);
  // The busiest destination a click on a shared band stands for.
  const pick = (hosts: string[]) => [...hosts].sort((a, b) => (bytesOf.get(b) ?? 0) - (bytesOf.get(a) ?? 0))[0] ?? null;
  const select = (hosts: string[]) => { const h = pick(hosts); if (h) setNetDest(h === netDest ? null : h); };
  const on = (hosts: string[]) => netDest !== null && hosts.includes(netDest);

  const band = (b: TopoBand) => {
    const style = BAND[b.kind];
    const lit = on(b.hosts);
    const dim = netDest !== null && !lit && b.kind !== 'trigger';
    return (
      <g key={b.id} data-band={b.id} ref={b.toDest ? bandRef(b.id) : undefined}>
        <path d={b.d} fill="none" stroke={style.colour} strokeWidth={b.width} strokeLinecap="butt"
          strokeOpacity={dim ? 0.14 : lit ? Math.min(1, style.opacity + 0.3) : style.opacity}
          strokeDasharray={b.dashed ? (b.kind === 'broken' ? '3 3' : '4 4') : undefined} />
        {b.live && !b.dashed && !dim && (
          // Live traffic: a thin line moving along the band, not the band itself dashed.
          <path d={b.d} fill="none" stroke="#FFFFFF" strokeOpacity={0.45} strokeWidth={1.2} className="net-live-dash" />
        )}
        {b.hosts.length > 0 && (
          // A wider invisible stroke so a thin band is still easy to click.
          <path d={b.d} fill="none" stroke="transparent" strokeWidth={Math.max(10, b.width)} style={{ cursor: 'pointer' }}
            onClick={() => select(b.hosts)}
            {...tipProps(`${b.hosts.slice(0, 6).join(', ')}${b.hosts.length > 6 ? ` +${b.hosts.length - 6}` : ''}${b.bytes ? ` · ${formatBytes(b.bytes)}` : ''}`)} />
        )}
        {b.label && (
          <text x={b.label.x} y={b.label.y} fontSize={10} fontFamily="var(--font-mono)" textAnchor={b.label.anchor}
            fill={b.kind === 'trigger' ? 'var(--net-fanout)' : style.colour}>{b.label.text}</text>
        )}
      </g>
    );
  };
  // Refusals and broken paths on top: thin, and the point of the diagram.
  const order = (k: BandKind) => (k === 'guard' || k === 'refused' || k === 'broken' || k === 'trigger' ? 1 : 0);
  const bands = [...view.bands].sort((a, b) => order(a.kind) - order(b.kind));
  const clipId = `dests-${data.token}`;

  return (
    // Focusing a row scrolled away would scroll this box (hidden overflow still scrolls); the column scrolls instead.
    <div ref={ref} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }} onScroll={(e) => { e.currentTarget.scrollTop = 0; }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${t.width} ${t.height}`} preserveAspectRatio="xMinYMin meet" role="group"
        aria-label={`Routes from ${data.token} through glove's services, policy and tunnel to ${t.nodes.filter((n) => n.kind === 'dest').length} destinations`}
        style={{ display: 'block' }}>
        {t.columns.map((c) => (
          <text key={c.id} x={c.x} y={26} fontSize={10} letterSpacing="0.08em" fontWeight={600} fill="var(--text-muted)"
            textAnchor={c.id === 'policy' ? 'middle' : 'start'}>{c.label.toUpperCase()}</text>
        ))}
        {t.dests.rows.length > 1 && (
          <text x={t.dests.x} y={41} fontSize={9.5} fill="var(--text-faint)" data-dest-sort={sort}
            {...svgButton(`Sort destinations by ${SORTS[SORTS[sort].next].label} (now by ${SORTS[sort].label})`, () => setSort(SORTS[sort].next))}
            {...tipProps({ heading: 'Order of the destinations', body: 'Click to sort by bytes, by name or by when each was last seen. Local destinations stay first and direct ones last.' })}>
            sorted by <tspan fill="var(--text-muted)" textDecoration="underline">{SORTS[sort].label}</tspan>
          </text>
        )}
        {bands.filter((b) => order(b.kind) === 0).map(band)}
        <g data-wall>
          <line x1={t.wall.x} x2={t.wall.x} y1={t.wall.y1} y2={t.wall.y2} stroke="#3A4252" strokeWidth={3} strokeLinecap="round" />
          {t.wall.labels.map((l) => (
            <g key={l.text}>
              <g transform={`translate(${t.wall.x + 12},${l.y - 7})`}>
                <NetIcon name={l.kind === 'guard' ? 'lock' : 'blocked'} size={12} color={l.kind === 'guard' ? 'var(--warn)' : 'var(--error)'} />
              </g>
              <text x={t.wall.x + 30} y={l.y + 3} fontSize={10.5} fill={l.kind === 'guard' ? 'var(--warn)' : '#FF8A80'}>{l.text}</text>
              {l.sub && <text x={t.wall.x + 30} y={l.y + 16} fontSize={10} fill="var(--text-faint)">{l.sub}</text>}
            </g>
          ))}
          <text x={t.wall.x - 4} y={t.wall.y2 + 16} fontSize={10} fill="var(--text-faint)">{t.wall.caption}</text>
        </g>
        {bands.filter((b) => order(b.kind) === 1).map(band)}
        {t.captions.map((c) => (
          <text key={c.text} x={c.x} y={c.y} fontSize={10} fontFamily="var(--font-mono)" textAnchor={c.anchor} fill={BAND[c.kind].colour}>{c.text}</text>
        ))}
        {t.nodes.filter((n) => n.kind !== 'dest').map((n) => (
          <Node key={n.id} n={n} selected={false} onSelect={(x) => select(x.hosts)} />
        ))}
        <clipPath id={clipId}><rect x={t.dests.x - 4} y={t.dests.top} width={t.dests.w + 8} height={t.dests.bottom - t.dests.top} /></clipPath>
        <g ref={column} data-dest-scroll="" tabIndex={t.dests.maxScroll > 0 ? 0 : undefined} style={{ outline: 'none' }}
          aria-label={t.dests.maxScroll > 0 ? `${t.dests.rows.length} destinations: scroll with the wheel, the arrow keys, Page Up and Page Down, Home and End` : undefined}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            const to = keyScroll(t, target.current, e.key);
            if (to !== null) { e.preventDefault(); scrollTo(to); }
          }}
          // Tabbing onto a row scrolled away brings it into the window.
          onFocus={(e) => reveal((e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined)}>
          <rect x={t.dests.x - 4} y={t.dests.top} width={t.dests.w + 14} height={t.dests.bottom - t.dests.top} fill="transparent" />
          <g clipPath={`url(#${clipId})`}>
            {/* Every row, once: scrolling moves the group (and the clip hides what is out). */}
            <g ref={rowsEl} transform={`translate(0,${-view.scrollTop})`}>
              {t.nodes.filter((n) => n.kind === 'dest').map((n) => (
                // Only rows in the window are Tab stops: hundreds of hidden ones would trap the keyboard.
                <Node key={n.id} n={n} selected={on(n.hosts)} onSelect={(x) => select(x.hosts)} tabbable={view.visible.has(n.id)} />
              ))}
            </g>
          </g>
          {thumb && (
            <g data-dest-scrollbar="">
              <rect x={thumb.x} y={thumb.track.y} width={thumb.w} height={thumb.track.h} rx={1.5} fill="var(--border)" opacity={0.5}
                onPointerDown={(e) => {
                  // A click on the track pages towards it, as Page Up / Page Down would.
                  const ctm = column.current?.ownerSVGElement?.getScreenCTM();
                  const y = ctm ? (e.clientY - ctm.f) / ctm.d : e.clientY;
                  const to = keyScroll(t, target.current, y < (scrollThumb(t, target.current)?.y ?? 0) ? 'PageUp' : 'PageDown');
                  if (to !== null) scrollTo(to);
                }} />
              <rect ref={thumbEl} x={thumb.x} y={thumb.y} width={thumb.w} height={thumb.h} rx={1.5} fill="var(--text-faint)" style={{ cursor: 'grab' }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { y: e.clientY, from: pos.current, perPx: unitsPerPx(column.current) };
                }}
                onPointerMove={(e) => { const d = drag.current; if (d) scrollTo(thumbDrag(t, d.from, (e.clientY - d.y) * d.perPx), 'live'); }}
                // Released, cancelled or lost, the capture ends: one place ends the drag.
                onLostPointerCapture={() => { if (drag.current) { drag.current = null; scrollTo(pos.current, 'now'); } }} />
            </g>
          )}
        </g>
        {view.above && <Stub stub={view.above} x={t.dests.x} onScroll={scrollTo} />}
        {view.below && <Stub stub={view.below} x={t.dests.x} onScroll={scrollTo} />}
      </svg>
    </div>
  );
}

const EVIDENCE: Record<HopEvidence, string> = {
  observed: 'var(--net-tunnel)', verified: 'var(--net-tunnel)', declared: 'var(--text-muted)', refused: 'var(--error)', broken: 'var(--warn)', none: 'var(--text-faint)',
};

export function SelectedPath({ data }: { data: NetSessionData }) {
  const netDest = useSessionStore((s) => s.netDest);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const path = useMemo(() => (netDest ? pathHops(data, netDest) : null), [data, netDest]);
  if (!path) {
    return (
      <div style={{ padding: 14, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Select a destination or a band in the diagram to follow its path hop by hop, and see which hops glove verified and which are only declared.
      </div>
    );
  }
  const { dest: d, hops } = path;
  const disabled = controlDisabledReason(data.rules);
  const v = d.policy.enforced;
  const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
  const apply = useNetStore.getState().applyRules;
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <NetIcon name="globe" size={14} color={d.scope === 'direct' ? 'var(--error)' : 'var(--net-tunnel)'} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-all' }}>{d.host}</span>
        {d.state === 'active' && <Badge colour="var(--net-tunnel)">LIVE</Badge>}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', margin: '2px 0 10px 22px' }}>
        {[d.tools.map(toolLabel).join(', '), `${d.flows} flow${d.flows === 1 ? '' : 's'}`, formatBytes(d.bytesUp + d.bytesDown)].filter(Boolean).join(' · ')}
      </div>
      <ol aria-label="Hops" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {hops.map((hop, i) => (
          <li key={hop.id} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: 8, position: 'relative', paddingBottom: i === hops.length - 1 ? 0 : 12 }}>
            {i < hops.length - 1 && <span style={{ position: 'absolute', left: 8, top: 16, bottom: 0, width: 1, background: 'var(--border-strong)' }} />}
            <span style={{
              width: 14, height: 14, marginTop: 1, borderRadius: 7, border: `1.5px ${hop.evidence === 'declared' ? 'dashed' : 'solid'} ${EVIDENCE[hop.evidence]}`, background: 'var(--bg)',
            }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{hop.title}</div>
              {hop.detail && <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-body)', wordBreak: 'break-all' }}>{hop.detail}</div>}
              <div style={{ fontSize: 10.5, color: EVIDENCE[hop.evidence] }}>{hop.status}</div>
            </div>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Tile label="SENT" value={formatBytes(d.bytesUp)} colour="var(--net-up)" icon="up" />
        <Tile label="RECEIVED" value={formatBytes(d.bytesDown)} colour="var(--net-down)" icon="down" />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }} data-tip={disabled ?? undefined}>
        {d.host && d.state !== 'guard' && v?.action === 'allow' && (
          <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'blockHost', host: d.host!, terminate: false })} style={buttonStyle('danger')}>
            <NetIcon name="blocked" color="#FF8A80" />Block {d.host}
          </button>
        )}
        {v?.action === 'block' && v.rule && (
          <button type="button" disabled={!!disabled}
            onClick={() => apply(v.rule!.startsWith('r_layman_cut_') ? { kind: 'restoreAll' } : { kind: 'removeRule', ids: siblingIds(v.rule!, rules) })} style={buttonStyle('ok')}>
            <NetIcon name="check" color="var(--net-tunnel)" />{v.rule.startsWith('r_layman_cut_') ? 'Restore all traffic' : 'Unblock'}
          </button>
        )}
        {d.scope !== 'local' && d.state !== 'guard' && (
          <button type="button" onClick={() => setViewMode('map')} style={buttonStyle('plain')}>
            <NetIcon name="map" />Open in map
          </button>
        )}
      </div>
    </div>
  );
}

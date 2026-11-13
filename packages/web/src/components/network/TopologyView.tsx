/**
 * The Topology tab: the Routes diagram and the
 * Selected path panel. Geometry comes from `lib/net-topology.ts`; this file
 * only draws it. Clicking a destination or a band selects that path (the
 * `netDest` the Map and the Network tab share), which dims every other band.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { directLegend, LEGEND_BY_KEY, TOPOLOGY_BAND_WIDTH_TIP, TOPOLOGY_LEGEND, formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { motionIsFull } from '../../lib/theme-runtime.js';
import { controlDisabledReason, siblingIds } from '../../lib/net-rules.js';
import { toolLabel } from '../../lib/net-table.js';
import {
  easeScroll, keyScroll, layoutTopology, outcomeOf, pathHops, projectTopology, scrollThumb, scrollToDest, thumbDrag, wheelDelta,
  MIN_HEIGHT, MIN_WIDTH,
  type BandKind, type DestSort, type DestStub, type HopEvidence, type LineTone, type ScrollColumnId, type Tone, type TopoBand, type TopoNode,
  type TopoProjection, type Topology,
} from '../../lib/net-topology.js';
import { boxDetails, boxHosts as hostsOfBox, DESTINATION_EXPLANATION, type BoxDetails, type BoxExplanation, type BoxFact, type MixKey } from '../../lib/net-topology-box.js';
import { useSharedLayout, useTopologyBox, useTopologyFocus } from './topologyFocus.js';
import { formatStamp } from '../../lib/net-range.js';
import { buttonStyle } from './ControlPopover.js';
import { Badge, SectionHead, Tile } from './DetailCard.js';
import { ALARM, NetIcon, useStored, type NetIconName } from './netui.js';
import { isLlmDestination, tokenTiles } from '../../lib/net-tokens.js';
import type { NetRange } from '../../lib/netobs-types.js';
import { useNetTokens } from '../../hooks/useNetTrace.js';
import { tipProps } from './NetTip.js';
import { tokenColor } from '../../lib/tokens.js';
import { sp, rad } from '../../lib/density.js';

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
  error: { colour: ALARM.text, mono: false },
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
    <div style={{ display: 'flex', alignItems: 'center', gap: sp(12), fontSize: 10.5, color: 'var(--text-body)', overflow: 'hidden', minWidth: 0 }}>
      {TOPOLOGY_LEGEND.map((l) => (
        <span key={l.label} {...tipProps({ heading: l.label, body: l.tip })} tabIndex={0} style={{ display: 'inline-flex', alignItems: 'center', gap: sp(5), whiteSpace: 'nowrap' }}>
          <span style={{ width: 14, height: 3, borderRadius: rad(2), background: BAND[l.bands[0]].colour }} />{l.label}
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
  const follows = n.kind === 'dest' || n.kind === 'broken';
  const clickable = !follows || n.hosts.length > 0;
  const common = clickable ? svgButton(follows ? `Follow the path to ${n.title}` : `Show ${n.title} in Details`, () => onSelect(n), tabbable ? 0 : -1) : {};
  if (n.kind === 'broken') {
    return (
      <g {...common} {...tipProps(n.title)} data-node={n.id}>
        {/* Its hit area, and its outline when selected. */}
        <rect x={n.x - 4} y={n.y - 6} width={n.w + 8} height={n.h + 12} rx={4} fill={selected ? SELECTED_FILL : 'transparent'}
          stroke={selected ? 'var(--info)' : 'none'} strokeWidth={1.5} />
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
        <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} fill={selected ? SELECTED_FILL : 'var(--bg-card)'}
          stroke={stroke} strokeWidth={selected ? 1.5 : 1} strokeDasharray={n.dashed ? '3 3' : undefined} />
        <text x={n.x + 8} y={n.y + n.h / 2 + 4} fontSize={11} fontFamily="var(--font-mono)" fill={n.tone === 'direct' ? ALARM.text : 'var(--text)'}>
          {clip(n.title, n.w - (n.live ? 22 : 14))}
        </text>
        {n.live && <circle cx={n.x + n.w - 7} cy={n.y + n.h / 2} r={2.5} fill="var(--net-tunnel)" />}
      </g>
    );
  }
  return (
    <g {...common} data-node={n.id}>
      <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={5}
        fill={selected ? SELECTED_FILL : n.tone === 'muted' && n.dashed ? 'transparent' : 'var(--bg-card)'}
        stroke={stroke} strokeWidth={selected ? 1.6 : n.kind === 'sandbox' ? 1.4 : 1} strokeDasharray={n.dashed && !selected ? '4 3' : undefined} />
      <text x={n.x + 10} y={n.y + 17} fontSize={12} fontWeight={600} fontFamily={n.mono ? 'var(--font-mono)' : 'var(--font-ui)'}
        fill={n.tone === 'muted' ? 'var(--text-muted)' : 'var(--text)'}>{clip(n.title, n.w - (n.icon ? 34 : 18), 7.2)}</text>
      {n.icon && (
        <g transform={`translate(${n.x + n.w - 20},${n.y + 7})`}>
          <NetIcon name={n.icon} size={12} color="var(--text-faint)" />
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
function Stub({ stub, x, onScroll, noun, attr }: {
  stub: DestStub; x: number; onScroll: (top: number) => void;
  /** What its rows are, one and many: `destination`, `broken path`. */
  noun: string;
  /** The data attribute that names it (`data-stub`, `data-broken-stub`): the browser checks find each column's by its own. */
  attr: string;
}) {
  const what = `${noun}${stub.count === 1 ? '' : 's'}`;
  return (
    <g {...{ [attr]: stub.edge }} {...svgButton(`Scroll to the ${stub.count} ${what} ${stub.edge}`, () => onScroll(stub.scrollTo))}
      {...tipProps({ heading: `${stub.count} ${what} ${stub.edge}`, body: stub.hosts.slice(0, 12).join('\n') + (stub.hosts.length > 12 ? `\n+${stub.hosts.length - 12} more` : '') })}>
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


/** A selected box's (or wall label's) fill. */
const SELECTED_FILL = tokenColor('info', '10%');

/** A policy-wall label's hit area: wide enough for `your rule “…” · 12`. */
const WALL_LABEL_W = 180;

/** The stubs' counts, as a key: a frame that changes it must commit. */
const counts = (p: TopoProjection) => `${p.above?.count ?? 0}/${p.below?.count ?? 0}`;

/** Diagram units per screen pixel down the svg `el` is in (the viewBox scales it). */
function unitsPerPx(el: SVGElement | null): number {
  const ctm = el?.ownerSVGElement?.getScreenCTM();
  return ctm && ctm.d ? 1 / ctm.d : 1;
}

/**
 * One scrolling column's scroll (the destinations, the broken paths). React renders at the
 * committed scroll; between commits an animation frame moves the rows, the bands into them and the
 * thumb directly through the DOM (`projectTopology` is cheap; re-rendering every band each frame
 * is not). It commits when it lands, and whenever a stub's count changes, so the stubs and the
 * visible set stay right.
 */
function useColumnScroll(t: Topology, col: ScrollColumnId) {
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
    const p = projectTopology(tRef.current, s, col);
    rowsEl.current?.setAttribute('transform', `translate(0,${-p.scrollTop})`);
    const thumb = scrollThumb(tRef.current, p.scrollTop, col);
    if (thumb) thumbEl.current?.setAttribute('y', String(thumb.y));
    for (const b of p.bands) {
      if (b.toRow?.col !== col) continue;
      const el = bandEls.current.get(b.id);
      if (el) for (const path of el.querySelectorAll('path')) path.setAttribute('d', b.d);
    }
    if (counts(p) !== shown.current) setScrollTop(p.scrollTop);
  }, [col]);

  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; };
  /**
   * Scroll to `to`: eased, or at once (`now`, or when motion is Reduced or Off). `live`
   * moves at once without committing, for a drag of the thumb; its end scrolls `now`.
   */
  const scrollTo = useCallback((to: number, how: 'ease' | 'now' | 'live' = 'ease') => {
    const { maxScroll } = tRef.current[col];
    target.current = Math.max(0, Math.min(maxScroll, to));
    if (how !== 'ease' || !motionIsFull()) {
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
  }, [paint, col]);
  useEffect(() => stop, []);

  const view = useMemo(() => projectTopology(t, scrollTop, col), [t, scrollTop, col]);
  shown.current = counts(view);
  useLayoutEffect(() => {
    // A new layout can scroll less (a taller pane, rows gone): the next key or wheel moves from there.
    pos.current = Math.min(pos.current, t[col].maxScroll);
    target.current = Math.min(target.current, t[col].maxScroll);
  }, [t, col]);
  useLayoutEffect(() => {
    // A render mid-animation or mid-drag (live data) drew the bands at the committed scroll: put them back.
    if (pos.current !== view.scrollTop) paint(pos.current);
  });
  const band = useCallback((id: string) => (el: SVGGElement | null) => {
    if (el) bandEls.current.set(id, el);
    else bandEls.current.delete(id);
  }, []);
  /** Scroll a row into the window, if it is not already. */
  const reveal = useCallback((id: string | undefined) => {
    if (!id || projectTopology(tRef.current, pos.current, col).visible.has(id)) return;
    const to = scrollToDest(tRef.current, id, col);
    if (to !== null) scrollTo(to);
  }, [scrollTo, col]);
  return { view, scrollTo, reveal, pos, target, rowsEl, thumbEl, band };
}

type ColumnScroll = ReturnType<typeof useColumnScroll>;

/**
 * A column that scrolls on its own: its rows clipped to the window, a wheel, the arrow keys and
 * Page Up / Page Down over it, a scrollbar beside it, and the stubs for what is scrolled away.
 */
function ScrollWindow({ t, col, scroll, clipId, noun, children, attrs }: {
  t: Topology; col: ScrollColumnId; scroll: ColumnScroll; clipId: string; children: React.ReactNode;
  /** The column group's and the scrollbar's data attributes (the browser checks find them by these). */
  attrs: { column: Record<string, string>; bar: Record<string, string>; stub: string };
  /** What a row is: `destination`, `broken path`. */
  noun: string;
}) {
  const c = t[col];
  const { view, scrollTo, reveal, pos, target, rowsEl, thumbEl } = scroll;
  const column = useRef<SVGGElement>(null);
  // A wheel over the column scrolls it, not the page: React's wheel listener is passive and cannot say so.
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (t[col].maxScroll <= 0) return;
      e.preventDefault();
      scrollTo(target.current + wheelDelta(t, e.deltaY, e.deltaMode, unitsPerPx(el), col));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [t, col, scrollTo, target]);
  const drag = useRef<{ y: number; from: number; perPx: number } | null>(null);
  const thumb = scrollThumb(t, view.scrollTop, col);
  if (!c.rows.length) return null;
  return (
    <>
      {/* Rows whose text runs past the box (a broken path's host) are clipped where the scrollbar begins. */}
      <clipPath id={clipId}><rect x={c.x - 4} y={c.top} width={c.w + c.overhang + 8} height={c.bottom - c.top} /></clipPath>
      <g ref={column} {...attrs.column} tabIndex={c.maxScroll > 0 ? 0 : undefined} style={{ outline: 'none' }}
        aria-label={c.maxScroll > 0 ? `${c.rows.length} ${noun}s: scroll with the wheel, the arrow keys, Page Up and Page Down, Home and End` : undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const to = keyScroll(t, target.current, e.key, col);
          if (to !== null) { e.preventDefault(); scrollTo(to); }
        }}
        // Tabbing onto a row scrolled away brings it into the window.
        onFocus={(e) => reveal((e.target as Element).closest('[data-node]')?.getAttribute('data-node') ?? undefined)}>
        {/* The wheel's target between rows. Only where the column's bands end: over the broken
            paths it would sit on bands crossing on to the destinations and swallow their clicks. */}
        {col === 'dests' && <rect x={c.x - 4} y={c.top} width={c.w + 14} height={c.bottom - c.top} fill="transparent" />}
        <g clipPath={`url(#${clipId})`}>
          {/* Every row, once: scrolling moves the group (and the clip hides what is out). */}
          <g ref={rowsEl} transform={`translate(0,${-view.scrollTop})`}>{children}</g>
        </g>
        {thumb && (
          <g {...attrs.bar}>
            <rect x={thumb.x} y={thumb.track.y} width={thumb.w} height={thumb.track.h} rx={1.5} fill="var(--border)" opacity={0.5}
              onPointerDown={(e) => {
                // A click on the track pages towards it, as Page Up / Page Down would.
                const ctm = column.current?.ownerSVGElement?.getScreenCTM();
                const y = ctm ? (e.clientY - ctm.f) / ctm.d : e.clientY;
                const to = keyScroll(t, target.current, y < (scrollThumb(t, target.current, col)?.y ?? 0) ? 'PageUp' : 'PageDown', col);
                if (to !== null) scrollTo(to);
              }} />
            <rect ref={thumbEl} x={thumb.x} y={thumb.y} width={thumb.w} height={thumb.h} rx={1.5} fill="var(--text-faint)" style={{ cursor: 'grab' }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { y: e.clientY, from: pos.current, perPx: unitsPerPx(column.current) };
              }}
              onPointerMove={(e) => { const d = drag.current; if (d) scrollTo(thumbDrag(t, d.from, (e.clientY - d.y) * d.perPx, col), 'live'); }}
              // Released, cancelled or lost, the capture ends: one place ends the drag.
              onLostPointerCapture={() => { if (drag.current) { drag.current = null; scrollTo(pos.current, 'now'); } }} />
          </g>
        )}
      </g>
      {view.above && <Stub stub={view.above} x={c.x} onScroll={scrollTo} noun={noun} attr={attrs.stub} />}
      {view.below && <Stub stub={view.below} x={c.x} onScroll={scrollTo} noun={noun} attr={attrs.stub} />}
    </>
  );
}

export function TopologyDiagram({ data }: { data: NetSessionData }) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const netDest = useSessionStore((s) => s.netDest);
  const setNetDest = useSessionStore((s) => s.setNetDest);
  const box = useTopologyBox(data.token);
  const setBox = useTopologyFocus((s) => s.setBox);
  const [sort, setSort] = useStored<DestSort>(SORT_KEY, 'bytes', (raw) => (raw === 'bytes' || raw === 'name' || raw === 'recent' ? raw : null));
  const t = useMemo(() => layoutTopology(data, w, h, { sort }), [data, w, h, sort]);
  const dests = useColumnScroll(t, 'dests');
  const pinned = useMemo(() => new Set(t.pinned), [t]);
  const broken = useColumnScroll(t, 'broken');
  // Another session or order starts at the top.
  useEffect(() => { dests.scrollTo(0, 'now'); broken.scrollTo(0, 'now'); }, [data.token, sort, dests.scrollTo, broken.scrollTo]); // eslint-disable-line react-hooks/exhaustive-deps
  // A destination chosen elsewhere (the Network tab, a link) is scrolled into the window: when the
  // choice, the session, the order or the size changes. Never on live data (every delta is a new
  // layout) nor a scroll, or a selected row would pull the column back while the user browses.
  const revealed = useRef('');
  useEffect(() => {
    const key = `${netDest}|${data.token}|${sort}|${w}|${h}`;
    if (key === revealed.current) return;
    revealed.current = key;
    const row = netDest ? t.nodes.find((n) => (n.kind === 'dest' || n.kind === 'broken') && n.hosts.includes(netDest)) : undefined;
    (row?.kind === 'broken' ? broken : dests).reveal(row?.id);
  }, [netDest, t]); // eslint-disable-line react-hooks/exhaustive-deps
  // Details reads a box's hosts from this layout rather than laying the diagram out again.
  const setLayout = useTopologyFocus((s) => s.setLayout);
  useEffect(() => { setLayout({ token: data.token, t }); }, [t, data.token, setLayout]);
  useEffect(() => () => setLayout(null), [setLayout]);
  const bytesOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data.destinations.values()) if (d.host) m.set(d.host, (m.get(d.host) ?? 0) + d.bytesUp + d.bytesDown);
    return m;
  }, [data.destinations]);
  // The busiest destination a click on a shared band stands for.
  const pick = (hosts: string[]) => [...hosts].sort((a, b) => (bytesOf.get(b) ?? 0) - (bytesOf.get(a) ?? 0))[0] ?? null;
  const select = (hosts: string[]) => { const h = pick(hosts); if (h) { setBox(data.token, null); setNetDest(h === netDest ? null : h); } };
  /** A box (or a wall label) into Details, or out of it on a second click. */
  const selectBox = (id: string) => { setNetDest(null); setBox(data.token, box === id ? null : id); };
  const activate = (n: TopoNode) => (n.kind === 'dest' || n.kind === 'broken' ? select(n.hosts) : selectBox(n.id));
  const on = (hosts: string[]) => netDest !== null && hosts.includes(netDest);
  // A selected box lights the bands into and out of it, and those carrying only its hosts on from there.
  const boxHosts = useMemo(() => (box ? new Set(hostsOfBox(t, box) ?? []) : null), [box, t]);
  const lit = (b: TopoBand) => (boxHosts
    ? b.from === box || b.to === box || (b.hosts.length > 0 && b.hosts.every((x) => boxHosts.has(x)))
    : on(b.hosts));
  const focused = netDest !== null || boxHosts !== null;

  const band = (b: TopoBand) => {
    const style = BAND[b.kind];
    const isLit = lit(b);
    const dim = focused && !isLit && b.kind !== 'trigger';
    const ref = b.toRow ? (b.toRow.col === 'dests' ? dests : broken).band(b.id) : undefined;
    return (
      <g key={b.id} data-band={b.id} ref={ref}>
        <path d={b.d} fill="none" stroke={style.colour} strokeWidth={b.width} strokeLinecap="butt"
          strokeOpacity={dim ? 0.14 : isLit ? Math.min(1, style.opacity + 0.3) : style.opacity}
          strokeDasharray={b.dashed ? (b.kind === 'broken' ? '3 3' : '4 4') : undefined} />
        {b.live && !b.dashed && !dim && (
          // Live traffic: a thin line moving along the band, not the band itself dashed.
          <path d={b.d} fill="none" stroke="var(--text)" strokeOpacity={0.45} strokeWidth={1.2} className="net-live-dash" />
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
  // Each column's scroll moves only the bands into its own rows.
  const projected = useMemo(() => projectTopology(t, broken.view.scrollTop, 'broken', dests.view.bands).bands, [t, broken.view.scrollTop, dests.view.bands]);
  const bands = [...projected].sort((a, b) => order(a.kind) - order(b.kind));

  return (
    // Focusing a row scrolled away would scroll this box (hidden overflow still scrolls); the column scrolls instead.
    <div ref={ref} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }} onScroll={(e) => { e.currentTarget.scrollTop = 0; }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${t.width} ${t.height}`} preserveAspectRatio="xMinYMin meet" role="group"
        aria-label={`Routes from ${data.token} through glove's services, policy and tunnel to ${t.dests.rows.length + t.pinned.length} destinations`}
        style={{ display: 'block' }}>
        {t.columns.map((c) => (
          <text key={c.id} x={c.x} y={26} fontSize={10} letterSpacing="0.08em" fontWeight={600} fill="var(--text-muted)"
            textAnchor={c.id === 'policy' ? 'middle' : 'start'}>{c.label.toUpperCase()}</text>
        ))}
        {/* The pinned rows keep their own order (by bytes), so the toggle is for the scrolling ones. */}
        {t.dests.rows.length > 1 && (
          <text x={t.dests.x} y={41} fontSize={9.5} fill="var(--text-faint)" data-dest-sort={sort}
            {...svgButton(`Sort destinations by ${SORTS[SORTS[sort].next].label} (now by ${SORTS[sort].label})`, () => setSort(SORTS[sort].next))}
            {...tipProps({ heading: 'Order of the destinations', body: 'Click to sort by bytes, by name or by when each was last seen. Local destinations stay first and direct ones last.' })}>
            sorted by <tspan fill="var(--text-muted)" textDecoration="underline">{SORTS[sort].label}</tspan>
          </text>
        )}
        {bands.filter((b) => order(b.kind) === 0).map(band)}
        <g data-wall>
          <line x1={t.wall.x} x2={t.wall.x} y1={t.wall.y1} y2={t.wall.y2} stroke="var(--border-strong)" strokeWidth={3} strokeLinecap="round" />
          {t.wall.labels.map((l) => {
            const selected = box === l.id;
            const colour = l.kind === 'guard' ? 'var(--warn)' : ALARM.text;
            return (
              <g key={l.id} data-wall-label={l.id} {...svgButton(`Show ${l.text} in Details`, () => selectBox(l.id))}>
                {/* Its hit area, and its outline when selected. */}
                <rect x={t.wall.x + 6} y={l.y - 12} width={WALL_LABEL_W} height={l.sub ? 34 : 22} rx={4}
                  fill={selected ? SELECTED_FILL : 'transparent'} stroke={selected ? 'var(--info)' : 'none'} strokeWidth={1.5} />
                <g transform={`translate(${t.wall.x + 12},${l.y - 7})`}>
                  <NetIcon name={l.kind === 'guard' ? 'lock' : 'blocked'} size={12} color={colour} />
                </g>
                <text x={t.wall.x + 30} y={l.y + 3} fontSize={10.5} fill={colour}>{l.text}</text>
                {l.sub && <text x={t.wall.x + 30} y={l.y + 16} fontSize={10} fill="var(--text-faint)">{l.sub}</text>}
              </g>
            );
          })}
          <text x={t.wall.x - 4} y={t.wall.y2 + 16} fontSize={10} fill="var(--text-faint)">{t.wall.caption}</text>
        </g>
        {bands.filter((b) => order(b.kind) === 1).map(band)}
        {t.captions.map((c) => (
          <text key={c.text} x={c.x} y={c.y} fontSize={10} fontFamily="var(--font-mono)" textAnchor={c.anchor} fill={BAND[c.kind].colour}>{c.text}</text>
        ))}
        {t.nodes.filter((n) => n.kind !== 'dest' && n.kind !== 'broken').map((n) => (
          <Node key={n.id} n={n} selected={box === n.id} onSelect={activate} />
        ))}
        <ScrollWindow t={t} col="broken" scroll={broken} clipId={`broken-${data.token}`} noun="broken path"
          attrs={{ column: { 'data-broken-scroll': '' }, bar: { 'data-broken-scrollbar': '' }, stub: 'data-broken-stub' }}>
          {t.nodes.filter((n) => n.kind === 'broken').map((n) => (
            <Node key={n.id} n={n} selected={on(n.hosts)} onSelect={activate} tabbable={broken.view.visible.has(n.id)} />
          ))}
        </ScrollWindow>
        {/* The model's destinations, pinned above the scrolling column: always in view. */}
        {t.nodes.filter((n) => pinned.has(n.id)).map((n) => (
          <Node key={n.id} n={n} selected={on(n.hosts)} onSelect={activate} />
        ))}
        <ScrollWindow t={t} col="dests" scroll={dests} clipId={`dests-${data.token}`} noun="destination"
          attrs={{ column: { 'data-dest-scroll': '' }, bar: { 'data-dest-scrollbar': '' }, stub: 'data-stub' }}>
          {t.nodes.filter((n) => n.kind === 'dest' && !pinned.has(n.id)).map((n) => (
            // Only rows in the window are Tab stops: hundreds of hidden ones would trap the keyboard.
            <Node key={n.id} n={n} selected={on(n.hosts)} onSelect={activate} tabbable={dests.view.visible.has(n.id)} />
          ))}
        </ScrollWindow>
      </svg>
    </div>
  );
}

const EVIDENCE: Record<HopEvidence, string> = {
  observed: 'var(--net-tunnel)', verified: 'var(--net-tunnel)', declared: 'var(--text-muted)', refused: 'var(--error)', broken: 'var(--warn)', none: 'var(--text-faint)',
};

/** How often an open range (or All records) asks again while shown: new calls land in the transcript. */
const TOKENS_REFRESH_MS = 5_000;

/**
 * The session's LLM tokens, one tile per kind, under SENT/RECEIVED on the LLM path. Same range
 * as the bytes; nothing at all when the session has no usage to show (not pi, no transcripts).
 */
function TokenTiles({ token, range }: { token: string; range: NetRange | null }) {
  const sums = useNetTokens(token, range, TOKENS_REFRESH_MS);
  if (!sums) return null;
  return (
    <div aria-label="LLM tokens" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: sp(8), marginTop: sp(8) }}>
      {tokenTiles(sums.tokens, sums.reported).map((t) => (
        <Tile key={t.label} label={t.label} value={t.value} sub={t.sub} tip={`${t.exact}, from the agent's transcript`} colour={t.colour} icon={t.icon} />
      ))}
    </div>
  );
}

/**
 * What the selected box is for, drawn last: under everything else the panel says about it. Dismissed, it stays away only while that selection does: the
 * panel keys it by the selection, so choosing another box and coming back (or closing and
 * reopening the panel) brings it back.
 */
function Explanation({ explain }: { explain: BoxExplanation | null }) {
  const [shown, setShown] = useState(true);
  if (!shown || !explain) return null;
  return (
    <div role="note" data-box-explanation="" style={{
      display: 'flex', gap: sp(8), alignItems: 'flex-start', padding: sp('8px 8px 8px 10px'), margin: sp('14px 0 0'), borderRadius: rad(6),
      border: `var(--stroke) solid ${tokenColor('info', '40%')}`, background: tokenColor('info', '7%'),
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>{explain.heading}</div>
        <div style={{ fontSize: 11, color: 'var(--text-body)', lineHeight: 1.45, marginTop: sp(2) }}>{explain.body}</div>
      </div>
      <button type="button" aria-label="Dismiss this explanation" onClick={() => setShown(false)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, flexShrink: 0,
        background: 'transparent', border: 'none', borderRadius: rad(4), cursor: 'pointer',
      }}>
        <NetIcon name="close" size={10} color="var(--text-faint)" />
      </button>
    </div>
  );
}

/** A box's traffic by route, in the diagram's band colours. */
const MIX_COLOUR: Readonly<Record<MixKey | 'refused', string>> = {
  local: BAND.local.colour, tunnel: BAND.tunnel.colour, fanout: BAND.fanout.colour, vpn: LEGEND_BY_KEY.vpn_route.colourVar,
  direct: BAND.direct.colour, broken: BAND.broken.colour, refused: BAND.refused.colour,
};

const BOX_ICON: Readonly<Record<BoxDetails['kind'], NetIconName>> = {
  sandbox: 'shield', service: 'pulse', route: 'tunnel', exit: 'pin', policy: 'blocked', dest: 'globe', broken: 'broken',
};
const BOX_KIND: Readonly<Record<BoxDetails['kind'], string>> = {
  sandbox: 'Sandbox', service: 'Gate service', route: 'Route', exit: 'Apparent origin', policy: 'Policy', dest: 'Destination', broken: 'Broken path',
};
const FACT_TONE: Readonly<Record<NonNullable<BoxFact['tone']>, string>> = {
  ok: 'var(--net-tunnel)', warn: 'var(--warn)', error: ALARM.text, faint: 'var(--text-faint)',
};

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '—');

/** The bytes through a box, by route: one stacked bar, and a legend that names and sizes each part. */
function RouteMix({ parts }: { parts: BoxDetails['mix'] }) {
  if (!parts.length) return null;
  const total = parts.reduce((a, p) => a + p.bytes, 0);
  return (
    <div data-route-mix="">
      <SectionHead>Bytes by route</SectionHead>
      <div role="img" aria-label={parts.map((p) => `${p.label} ${pct(p.bytes, total)}`).join(', ')}
        style={{ display: 'flex', gap: sp(2), height: 8, borderRadius: rad(4), overflow: 'hidden' }}>
        {parts.map((p) => (
          <span key={p.key} {...tipProps({ heading: p.label, body: `${formatBytes(p.bytes)} · ${pct(p.bytes, total)} of the bytes, ${p.destinations} destination${p.destinations === 1 ? '' : 's'}` })}
            style={{ flex: `${p.bytes} 0 0`, minWidth: 3, background: MIX_COLOUR[p.key] }} />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '10px 1fr auto auto', gap: sp('3px 8px'), alignItems: 'center', marginTop: sp(6), fontSize: 10.5 }}>
        {parts.map((p) => (
          <React.Fragment key={p.key}>
            <span style={{ width: 10, height: 3, borderRadius: rad(2), background: MIX_COLOUR[p.key] }} />
            <span style={{ color: 'var(--text-body)' }}>{p.label} <span style={{ color: 'var(--text-faint)' }}>· {p.destinations}</span></span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', textAlign: 'right' }}>{formatBytes(p.bytes)}</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)', textAlign: 'right', minWidth: 30 }}>{pct(p.bytes, total)}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/** The busiest destinations through a box (the most refused, at a policy label): a bar each, a click follows its path. */
function TopDestinations({ b }: { b: BoxDetails }) {
  const setNetDest = useSessionStore((s) => s.setNetDest);
  const byRefusals = b.kind === 'policy';
  const value = (r: BoxDetails['top'][number]) => (byRefusals ? r.refused : r.bytes);
  const max = Math.max(1, ...b.top.map(value));
  if (!b.top.length) return null;
  return (
    <div data-top-dests="">
      <SectionHead>{byRefusals ? 'Most refused' : 'Busiest destinations'} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{b.totals.destinations}</span></SectionHead>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 72px', gap: sp('4px 8px'), alignItems: 'center' }}>
        {b.top.map((r) => {
          const host = r.host;
          const inner = (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>
                {r.label}{r.state === 'active' && <span style={{ color: 'var(--net-tunnel)' }}> ●</span>}
              </span>
              <span style={{ display: 'block', height: 4, width: `${Math.max(2, (100 * value(r)) / max)}%`, borderRadius: rad(2), background: MIX_COLOUR[r.key] }} />
            </>
          );
          const cell: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: sp(3), minWidth: 0, padding: 0, background: 'transparent', border: 'none', textAlign: 'left' };
          return (
          <React.Fragment key={r.label}>
            {/* One with no host (a malformed request) has no path to follow: it is not a link. */}
            {host
              ? <button type="button" onClick={() => setNetDest(host)} {...tipProps(`Follow the path to ${host}`)} style={{ ...cell, cursor: 'pointer' }}>{inner}</button>
              : <div {...tipProps('No host: no path to follow')} style={cell}>{inner}</div>}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-body)', textAlign: 'right' }}>
              {byRefusals ? `${r.refused} refused` : formatBytes(r.bytes)}
            </span>
          </React.Fragment>
          );
        })}
      </div>
      {b.more > 0 && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: sp(4) }}>+{b.more} more</div>}
    </div>
  );
}

/** Every exit glove recorded for the session, newest first: when the tunnel's exit changed, and checks that failed. */
function ExitHistory({ exits }: { exits: BoxDetails['exits'] }) {
  if (!exits.length) return null;
  const ips = new Set(exits.map((e) => e.ip).filter(Boolean)).size;
  const shown = exits.slice(0, 10);
  return (
    <div data-exit-history="">
      <SectionHead>Exit checks <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{exits.length} · {ips} address{ips === 1 ? '' : 'es'}</span></SectionHead>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: sp(3) }}>
        {shown.map((e, i) => (
          <li key={`${e.t}-${i}`} style={{ display: 'grid', gridTemplateColumns: '12px minmax(0, 1fr) auto', gap: sp(6), alignItems: 'center', fontSize: 10.5 }}>
            <NetIcon name={e.healthy ? 'check' : 'alert'} size={10} color={e.healthy ? 'var(--net-tunnel)' : 'var(--warn)'} />
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{e.ip ?? 'no address'}</span>
              {e.where && <span style={{ color: 'var(--text-faint)' }}> · {e.where}</span>}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{Number.isNaN(Date.parse(e.t)) ? e.t : formatStamp(Date.parse(e.t))}</span>
          </li>
        ))}
      </ol>
      {exits.length > shown.length && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: sp(4) }}>+{exits.length - shown.length} earlier</div>}
    </div>
  );
}

/** Details for a box that is not a destination: what it is for, what glove says about it, and its traffic. */
function BoxPanel({ data, id }: { data: NetSessionData; id: string }) {
  // The diagram's own layout while it is drawn; laid out here only when the Routes panel is hidden
  // (which hosts a box stands for does not depend on the size it is drawn at).
  const shared = useSharedLayout(data.token);
  const t = useMemo(() => shared ?? layoutTopology(data, MIN_WIDTH, MIN_HEIGHT), [shared, data]);
  const b = useMemo(() => boxDetails(data, t, id), [data, t, id]);
  if (!b) {
    return <div style={{ padding: sp(14), fontSize: 11.5, color: 'var(--text-muted)' }}>That box is no longer in the diagram.</div>;
  }
  const { totals } = b;
  const policy = b.kind === 'policy';
  return (
    <div style={{ padding: sp(12) }} data-box-details={b.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: sp(8) }}>
        <NetIcon name={BOX_ICON[b.kind]} size={14} color={policy ? 'var(--error)' : 'var(--text-muted)'} />
        <span style={{ fontFamily: b.mono ? 'var(--font-mono)' : undefined, fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-all' }}>{b.title}</span>
        {totals.live > 0 && <Badge colour="var(--net-tunnel)">LIVE</Badge>}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', margin: sp('2px 0 10px 22px') }}>{BOX_KIND[b.kind]}</div>
      {b.facts.length > 0 && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: sp('4px 10px'), margin: 0, fontSize: 11 }}>
          {b.facts.map((f) => (
            <React.Fragment key={f.label}>
              <dt style={{ color: 'var(--text-faint)' }}>{f.label}</dt>
              <dd style={{ margin: 0, color: f.tone ? FACT_TONE[f.tone] : 'var(--text-body)', fontFamily: f.mono ? 'var(--font-mono)' : undefined, wordBreak: 'break-word' }}>{f.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: sp(8), marginTop: sp(14) }}>
        {!policy && <Tile label="SENT" value={formatBytes(totals.up)} colour="var(--net-up)" icon="up" />}
        {!policy && <Tile label="RECEIVED" value={formatBytes(totals.down)} colour="var(--net-down)" icon="down" />}
        {!policy && <Tile label="FLOWS" value={totals.flows.toLocaleString()} colour="var(--text-muted)" icon="activity" />}
        {(policy || totals.refused > 0) && <Tile label="REFUSED" value={totals.refused.toLocaleString()} colour="var(--error)" icon="blocked" />}
        {policy && <Tile label="DESTINATIONS" value={totals.destinations.toLocaleString()} colour="var(--text-muted)" icon="globe" />}
      </div>
      <RouteMix parts={b.mix} />
      <TopDestinations b={b} />
      <ExitHistory exits={b.exits} />
      <Explanation explain={b.explain} />
    </div>
  );
}

export function SelectedPath({ data }: { data: NetSessionData }) {
  const netDest = useSessionStore((s) => s.netDest);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const box = useTopologyBox(data.token);
  const path = useMemo(() => (netDest ? pathHops(data, netDest) : null), [data, netDest]);
  // Keyed by the box: another box (or this one again later) starts with its explanation shown.
  if (box && !netDest) return <BoxPanel key={box} data={data} id={box} />;
  if (!path) {
    return (
      <div style={{ padding: sp(14), fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Select any box in the diagram. A destination or a band follows its path hop by hop, and shows which hops glove verified and which are only declared;
        any other box says what it is for and shows the traffic through it.
      </div>
    );
  }
  const { dest: d, hops } = path;
  const disabled = controlDisabledReason(data.rules);
  const v = d.policy.enforced;
  const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
  const apply = useNetStore.getState().applyRules;
  return (
    <div style={{ padding: sp(12) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: sp(8) }}>
        <NetIcon name="globe" size={14} color={directLegend(d)?.colourVar ?? 'var(--net-tunnel)'} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-all' }}>{d.host}</span>
        {d.state === 'active' && <Badge colour="var(--net-tunnel)">LIVE</Badge>}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', margin: sp('2px 0 10px 22px') }}>
        {[d.tools.map(toolLabel).join(', '), `${d.flows} flow${d.flows === 1 ? '' : 's'}`, formatBytes(d.bytesUp + d.bytesDown)].filter(Boolean).join(' · ')}
      </div>
      <ol aria-label="Hops" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {hops.map((hop, i) => (
          <li key={hop.id} style={{ display: 'grid', gridTemplateColumns: '18px 1fr', gap: sp(8), position: 'relative', paddingBottom: i === hops.length - 1 ? 0 : 12 }}>
            {i < hops.length - 1 && <span style={{ position: 'absolute', left: 8, top: 16, bottom: 0, width: 1, background: 'var(--border-strong)' }} />}
            <span style={{
              width: 14, height: 14, marginTop: sp(1), borderRadius: rad(7), border: `1.5px ${hop.evidence === 'declared' ? 'dashed' : 'solid'} ${EVIDENCE[hop.evidence]}`, background: 'var(--bg)',
            }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{hop.title}</div>
              {hop.detail && <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-body)', wordBreak: 'break-all' }}>{hop.detail}</div>}
              <div style={{ fontSize: 10.5, color: EVIDENCE[hop.evidence] }}>{hop.status}</div>
            </div>
          </li>
        ))}
      </ol>
      <div style={{ display: 'flex', gap: sp(8), marginTop: sp(14) }}>
        <Tile label="SENT" value={formatBytes(d.bytesUp)} colour="var(--net-up)" icon="up" />
        <Tile label="RECEIVED" value={formatBytes(d.bytesDown)} colour="var(--net-down)" icon="down" />
      </div>
      {isLlmDestination(d) && <TokenTiles token={data.token} range={data.range} />}
      <div style={{ display: 'flex', gap: sp(8), marginTop: sp(12), flexWrap: 'wrap' }} data-tip={disabled ?? undefined}>
        {d.host && d.state !== 'guard' && v?.action === 'allow' && (
          <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'blockHost', host: d.host!, terminate: false })} style={buttonStyle('danger')}>
            <NetIcon name="blocked" color={ALARM.text} />Block {d.host}
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
      <Explanation key={netDest} explain={DESTINATION_EXPLANATION[outcomeOf(d)]} />
    </div>
  );
}

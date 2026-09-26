/**
 * The Map tab (plan §7.2, map-route-map.dc.html): the world map full-bleed,
 * floating cards in its corners, and the last 60 seconds as a band beneath.
 * Every card can be hidden from the Panels chips and dragged to another corner
 * (remembered per viewer, like panel order). The map geometry is
 * `lib/net-geo.ts`; the renderer `WorldMap.tsx`.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNow } from '../../hooks/useNow.js';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { clockTime, destinationRow, rateOf, sessionAnchor, toolLabel, type TableRow } from '../../lib/net-table.js';
import { RIBBON_MS, ribbonLanes, unknownLocation } from '../../lib/net-geo.js';
import { useNetCalls } from '../../hooks/useNetTrace.js';
import { controlDisabledReason } from '../../lib/net-rules.js';
import type { DestinationAggregate } from '../../lib/netobs-types.js';
import type { useNetPanels } from '../../hooks/useNetPanels.js';
import { NetToggle } from './cells.js';
import { ControlPopover, buttonStyle } from './ControlPopover.js';
import { DetailCard, useGeoStatus } from './DetailCard.js';
import { WorldMap } from './WorldMap.js';
import { NetIcon, type NetIconName } from './netui.js';

type Corner = 'tl' | 'tc' | 'tr' | 'bl' | 'br';
const DEFAULT_CORNER: Record<string, Corner> = { talking: 'tl', unknown: 'tc', detail: 'tr', sandbox: 'bl', legend: 'br' };
const CORNERS_KEY = 'layman.net.map.corners';

function loadCorners(): Record<string, Corner> {
  try {
    const raw = JSON.parse(localStorage.getItem(CORNERS_KEY) ?? '{}') as Record<string, unknown>;
    const out: Record<string, Corner> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && ['tl', 'tc', 'tr', 'bl', 'br'].includes(v)) out[k] = v as Corner;
    return out;
  } catch {
    return {};
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatRate(bps: number): string {
  if (bps < 1000) return `${Math.round(bps)} B/s`;
  if (bps < 1_000_000) return `${Math.round(bps / 1000)} KB/s`;
  return `${(bps / 1_000_000).toFixed(1)} MB/s`;
}

/** A floating card: header with a drag grip (to move it to another corner), title, count and hide. */
function Card({ id, title, icon, count, extra, onHide, onDragStart, width = 300, children }: {
  id: string; title: string; icon: NetIconName; count?: React.ReactNode; extra?: React.ReactNode;
  onHide: () => void; onDragStart: (id: string) => void; width?: number; children: React.ReactNode;
}) {
  return (
    <section aria-label={title} style={{
      width, maxWidth: '100%', background: 'rgba(17,21,29,0.94)', border: '1px solid var(--border)', borderRadius: 8,
      boxShadow: '0 8px 24px rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', overflow: 'hidden', pointerEvents: 'auto',
      // Shrinks to its corner's share of the height, and scrolls inside.
      display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 32, flexShrink: 0, padding: '0 8px', borderBottom: '1px solid var(--border)' }}>
        <span role="button" tabIndex={-1} aria-label={`Move ${title} to another corner`} title="Drag to another corner"
          onPointerDown={(e) => { e.preventDefault(); onDragStart(id); }} style={{ cursor: 'grab', display: 'flex' }}>
          <NetIcon name="grip" color="var(--text-faint)" />
        </span>
        <NetIcon name={icon} color="var(--net-tunnel)" />
        <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{title}</h2>
        {count !== undefined && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>{count}</span>}
        <span style={{ flex: 1 }} />
        {extra}
        <button type="button" aria-label={`Hide ${title}`} onClick={onHide} style={{ display: 'flex', background: 'transparent', border: 'none', cursor: 'pointer', padding: 3 }}>
          <NetIcon name="close" size={10} color="var(--text-faint)" />
        </button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>{children}</div>
    </section>
  );
}

type TalkFilter = 'live' | 'finished' | 'guard' | 'user_rule' | 'broken';

function TalkingNow({ data, now, select, selected }: { data: NetSessionData; now: number; select: (h: string | null) => void; selected: string | null }) {
  const [filter, setFilter] = useState<TalkFilter>('live');
  const [popover, setPopover] = useState<{ row: TableRow; anchor: DOMRect } | null>(null);
  const anchor = sessionAnchor(data, now);
  const dests = [...data.destinations.values()];
  const by = (f: (d: DestinationAggregate) => boolean) => dests.filter(f);
  const lists: Record<TalkFilter, DestinationAggregate[]> = {
    live: by((d) => d.openFlows > 0).sort((a, b) => rateOf(b.spark, anchor) - rateOf(a.spark, anchor)),
    finished: by((d) => d.state === 'finished'),
    guard: by((d) => d.state === 'guard'),
    user_rule: by((d) => d.state === 'user_rule' || d.state === 'default_block'),
    broken: by((d) => d.state === 'broken'),
  };
  const disabled = controlDisabledReason(data.rules);
  const list = lists[filter];
  return (
    <div>
      {list.length === 0 && <div style={{ padding: '10px 12px', fontSize: 11, color: 'var(--text-faint)' }}>{filter === 'live' ? 'Nothing is open right now.' : 'None.'}</div>}
      {list.map((d) => {
        const row = destinationRow(data, d, now);
        const rate = rateOf(d.spark, anchor);
        const sel = d.host === selected;
        return (
          <div key={d.key} onClick={() => select(sel ? null : d.host)} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)',
            background: sel ? 'var(--bg-selected)' : undefined, boxShadow: sel ? 'inset 2px 0 0 var(--accent)' : undefined,
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: d.state === 'active' ? 'var(--net-tunnel)' : 'var(--text-faint)' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: d.scope === 'direct' ? '#FF8A80' : 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.host ?? d.endpoint}</div>
              <div style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {toolLabel(d.tools[0] ?? '')} · {d.state === 'active' ? 'live' : row.state.text} · {formatBytes(d.bytesDown)}
              </div>
            </div>
            {filter === 'live' && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--net-down)', whiteSpace: 'nowrap' }}>↓ {formatRate(rate)}</span>}
            <NetToggle kind={row.toggle} target={row.target} disabledReason={disabled} onClick={(a) => setPopover({ row, anchor: a })} />
          </div>
        );
      })}
      <div style={{ padding: '6px 12px' }}>
        {([
          ['finished', 'check', 'var(--text-muted)', `${lists.finished.length} finished`],
          ['guard', 'lock', 'var(--warn)', `${lists.guard.length} refused by glove guard`],
          ['user_rule', 'blocked', 'var(--error)', `${lists.user_rule.length} blocked by the rules`],
          ['broken', 'broken', 'var(--warn)', `${lists.broken.length} path broken (upstream unreachable)`],
        ] as const).filter(([k]) => lists[k].length > 0 || filter === k).map(([k, icon, colour, text]) => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: colour, padding: '2px 0' }}>
            <NetIcon name={icon} color={colour} size={11} /><span style={{ flex: 1 }}>{text}</span>
            <button type="button" aria-pressed={filter === k} onClick={() => setFilter(filter === k ? 'live' : k)}
              style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--info)', cursor: 'pointer', fontSize: 10.5 }}>
              {filter === k ? 'Live' : 'Show'}
            </button>
          </div>
        ))}
      </div>
      {popover && <ControlPopover row={popover.row} data={data} anchor={popover.anchor} onClose={() => setPopover(null)} />}
    </div>
  );
}

function UnknownCard({ data, select }: { data: NetSessionData; select: (h: string | null) => void }) {
  const geo = useGeoStatus();
  const unknown = unknownLocation(data.destinations.values());
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
        {unknown.slice(0, 30).map((d) => (
          <button key={d.key} type="button" onClick={() => select(d.host)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 11, color: d.state === 'user_rule' ? 'var(--error)' : 'var(--warn)' }}>
            {d.host}
          </button>
        ))}
        {unknown.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Everything that left can be placed.</span>}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6 }}>
        {geo && !geo.loaded ? 'No geolocation database: set one in Settings → Glove. ' : ''}Never looked up: glove had no IP, or the database has no place for it.
      </div>
    </div>
  );
}

function SandboxCard({ data }: { data: NetSessionData }) {
  const locals = [...data.destinations.values()].filter((d) => d.scope === 'local' && d.state !== 'guard');
  const names = [...new Set(locals.map((d) => (d.tools.includes('llm') ? 'LLM' : d.tools.includes('web_search') ? 'SearXNG' : d.host ?? d.endpoint ?? 'local')))];
  const unwatched = data.gate.unwatchedServices;
  const chip = (text: string, faint: boolean, icon: NetIconName) => (
    <span key={text} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 11, fontSize: 10.5, color: faint ? 'var(--text-faint)' : 'var(--text-body)', border: '1px solid var(--border-strong)' }}>
      <NetIcon name={icon} size={11} color={faint ? 'var(--text-faint)' : 'var(--text-muted)'} />{text}
    </span>
  );
  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginBottom: 8 }}>Not a place on the map. Traffic enters the tunnel here.</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {names.map((n) => chip(`${n} · local`, false, 'home'))}
        {unwatched.map((s) => chip(`${s} · not watched`, true, 'eye-off'))}
        {!names.length && !unwatched.length && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>No local links.</span>}
      </div>
    </div>
  );
}

function LegendCard() {
  const geo = useGeoStatus();
  const line = (stroke: string, dash?: string, cls?: string) => (
    <svg width={28} height={8} aria-hidden="true"><line x1={1} y1={4} x2={27} y2={4} stroke={stroke} strokeWidth={2.2} strokeDasharray={dash} className={cls} /></svg>
  );
  return (
    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 5, fontSize: 10.5, color: 'var(--text-body)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{line('var(--net-tunnel)')}Tunnelled, via the exit</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{line('var(--net-tunnel)', undefined, 'net-live-dash')}Live</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{line('var(--net-tunnel)', '6 4')}Route declared, not verified</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{line('var(--error)', '5 4')}Untunnelled: skips the exit</span>
      <span style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 3 }}>
        {/* Nothing until Layman answers: "no database" is a claim, not a placeholder. */}
        {geo ? geo.attribution ?? 'No geolocation database: destinations are in Unknown location.' : ''}
      </span>
    </div>
  );
}

/** The ribbon re-asks for its tool calls this often; between asks its markers move with the lanes. */
const MARKER_REFRESH_MS = 5000;

function Ribbon({ data, now }: { data: NetSessionData; now: number }) {
  const anchor = sessionAnchor(data, now);
  const { lanes, more } = useMemo(() => ribbonLanes(data.flows.values(), anchor), [data.flows, anchor]);
  // Tool-call markers (plan §7.2): every call that started in the window, whichever turn it belongs to.
  const asked = Math.floor(anchor / MARKER_REFRESH_MS) * MARKER_REFRESH_MS;
  const calls = useNetCalls(data.token, asked - RIBBON_MS - MARKER_REFRESH_MS, asked + MARKER_REFRESH_MS);
  const markers = useMemo(() => calls
    .filter((c) => c.start >= anchor - RIBBON_MS && c.start <= anchor)
    .map((c) => ({ c, x: (c.start - (anchor - RIBBON_MS)) / RIBBON_MS })), [calls, anchor]);
  const colour = (l: (typeof lanes)[number]) =>
    l.direct ? 'var(--error)' : l.state === 'guard' ? 'var(--warn)' : l.state === 'user_rule' || l.state === 'default_block' ? 'var(--error)'
      : l.state === 'broken' ? 'var(--warn)' : l.open ? 'var(--net-tunnel)' : 'var(--text-faint)';
  const tile = (label: string, value: string, c: string, icon: 'up' | 'down') => (
    <div style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${c}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.08em', color: c }}><NetIcon name={icon} size={11} color={c} />{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>{value}</div>
    </div>
  );
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 260, padding: '8px 12px', borderRight: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {tile('SENT', formatBytes(data.totals.bytesUp), 'var(--net-up)', 'up')}
          {tile('RECEIVED', formatBytes(data.totals.bytesDown), 'var(--net-down)', 'down')}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6 }}>Session totals. {plural(data.totals.flows, 'flow')}, {plural(data.totals.destinations, 'destination')}.</div>
      </div>
      <div style={{ flex: 1, position: 'relative', padding: '8px 12px', minWidth: 0 }}>
        <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 1000 ${Math.max(10, lanes.length * 5 + 6)}`} role="img" aria-label={`${lanes.length} flows in the last 60 seconds`}>
          <line x1={0} x2={1000} y1={2} y2={2} stroke="var(--border-strong)" strokeWidth={1} />
          {lanes.map((l, i) => (
            <rect key={l.id} x={l.x0 * 1000} y={5 + i * 5} width={Math.max(3, (l.x1 - l.x0) * 1000)} height={3} fill={colour(l)} opacity={l.open ? 1 : 0.7} />
          ))}
          {markers.map(({ c, x }) => (
            <g key={c.eventId} data-call-marker={c.toolName}>
              <line x1={x * 1000} x2={x * 1000} y1={0} y2={Math.max(10, lanes.length * 5 + 6)} stroke={c.kind === 'search' ? 'var(--net-fanout)' : 'var(--info)'}
                strokeWidth={1.5} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" opacity={0.85} />
              <line x1={x * 1000} x2={x * 1000} y1={0} y2={Math.max(10, lanes.length * 5 + 6)} stroke="transparent" strokeWidth={10} vectorEffect="non-scaling-stroke">
                <title>{`${c.toolName} ${c.kind === 'search' ? `“${c.label}”` : c.label} · ${clockTime(c.start)}${c.timing === 'approximate' ? ' (read time)' : ''}`}</title>
              </line>
            </g>
          ))}
        </svg>
        <div style={{ position: 'absolute', right: 12, bottom: 4, fontSize: 10, color: 'var(--text-faint)', background: 'var(--bg-card)', padding: '0 4px' }}>
          60 s ago … now{more ? ` · ${more} more not drawn` : ''}{markers.length ? ` · ┊ ${markers.length} tool call${markers.length === 1 ? '' : 's'}` : ''}
        </div>
      </div>
    </div>
  );
}

export function MapView({ data, panels }: { data: NetSessionData; panels: ReturnType<typeof useNetPanels> }) {
  const now = useNow(1000);
  const netDest = useSessionStore((s) => s.netDest);
  const setNetDest = useSessionStore((s) => s.setNetDest);
  const [corners, setCorners] = useState<Record<string, Corner>>(loadCorners);
  const [dragging, setDragging] = useState<string | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const sandboxRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<[number, number] | undefined>(undefined);

  useEffect(() => { localStorage.setItem(CORNERS_KEY, JSON.stringify(corners)); }, [corners]);
  // Moving a card: drop it in the corner nearest the pointer.
  useEffect(() => {
    if (!dragging) return;
    const up = (e: PointerEvent) => {
      const r = area.current?.getBoundingClientRect();
      if (r) {
        const fx = (e.clientX - r.left) / r.width;
        const fy = (e.clientY - r.top) / r.height;
        const c: Corner = fy < 0.5 ? (fx < 0.33 ? 'tl' : fx > 0.67 ? 'tr' : 'tc') : fx < 0.5 ? 'bl' : 'br';
        setCorners((cs) => ({ ...cs, [dragging]: c }));
      }
      setDragging(null);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [dragging]);

  // The trunk leaves from the sandbox card's edge: measure where it is.
  useLayoutEffect(() => {
    const measure = () => {
      const a = area.current?.getBoundingClientRect();
      const s = sandboxRef.current?.getBoundingClientRect();
      if (!a || !s) return setAnchor(undefined);
      const right = s.left + s.width / 2 < a.left + a.width / 2;
      setAnchor([right ? s.right - a.left : s.left - a.left, s.top - a.top + 18]);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (area.current) ro.observe(area.current);
    if (sandboxRef.current) ro.observe(sandboxRef.current);
    return () => ro.disconnect();
  }, [corners, panels.isVisible('sandbox')]); // eslint-disable-line react-hooks/exhaustive-deps

  const cornerOf = (id: string) => corners[id] ?? DEFAULT_CORNER[id] ?? 'tr';

  const select = (h: string | null) => setNetDest(h);
  const direct = [...data.destinations.values()].filter((d) => d.scope === 'direct');
  const unknown = unknownLocation(data.destinations.values());
  const live = [...data.destinations.values()].filter((d) => d.openFlows > 0).length;
  const disabled = controlDisabledReason(data.rules);

  // Not dismissable while such a flow exists (plan §6.3); stacked in the top-centre column so it covers no card.
  const directBanner = direct.length > 0 ? (
    <div role="alert" style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 8, background: '#2A0F0E', border: '1px solid var(--error)', maxWidth: 620 }}>
            <NetIcon name="alert" size={18} color="var(--error)" strokeWidth={1.8} />
            <div style={{ fontSize: 11.5, color: '#F3C6C1' }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: '#FFB4AD' }}>Untunnelled traffic</div>
              {plural(direct.reduce((a, d) => a + d.flows, 0), 'flow')} to <span style={{ fontFamily: 'var(--font-mono)' }}>{direct.map((d) => d.host).slice(0, 3).join(', ')}{direct.length > 3 ? '…' : ''}</span> left through a <b>direct</b> route and carried the operator’s real IP.
            </div>
            <button type="button" disabled={!!disabled} title={disabled ?? 'One rule: block scope direct, and cut what is open'}
              onClick={() => useNetStore.getState().applyRules({ kind: 'blockGroup', key: 'scope', value: 'direct', terminate: true, note: 'Blocked direct egress from the Map' })}
              style={buttonStyle('danger')}>
              <NetIcon name="blocked" color="#FF8A80" />Block direct egress
            </button>
          </div>
  ) : null;

  const cards: Array<{ id: string; node: React.ReactNode }> = [
    { id: 'talking', node: <Card id="talking" title="Talking now" icon="pulse" count={live} onHide={() => panels.toggle('talking')} onDragStart={setDragging}><TalkingNow data={data} now={now} select={select} selected={netDest} /></Card> },
    { id: 'unknown', node: <Card id="unknown" title="Unknown location" icon="pin" count={unknown.length} width={360} onHide={() => panels.toggle('unknown')} onDragStart={setDragging}><UnknownCard data={data} select={select} /></Card> },
    { id: 'detail', node: netDest ? <Card id="detail" title="Details" icon="details" width={320} onHide={() => panels.toggle('detail')} onDragStart={setDragging}><DetailCard data={data} host={netDest} onClose={() => setNetDest(null)} /></Card> : null },
    { id: 'sandbox', node: <div ref={sandboxRef} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}><Card id="sandbox" title="This sandbox" icon="shield" count={`${data.token}${data.session?.harness ? ` · ${data.session.harness}` : ''}`} onHide={() => panels.toggle('sandbox')} onDragStart={setDragging}><SandboxCard data={data} /></Card></div> },
    { id: 'legend', node: <Card id="legend" title="Legend" icon="legend" width={250} onHide={() => panels.toggle('legend')} onDragStart={setDragging}><LegendCard /></Card> },
  ];
  // Fit the map to the space the cards leave: the tall top-corner cards take a side (they are
  // 300–320 px wide, 12 px in), the short bottom ones a strip along the bottom.
  const shown = (id: string) => panels.isVisible(id) && (id !== 'detail' || !!netDest);
  const inCorner = (c: Corner) => cards.some((x) => x.node && shown(x.id) && cornerOf(x.id) === c);
  const insets = {
    top: inCorner('tc') ? 120 : 64,
    bottom: inCorner('bl') || inCorner('br') ? 150 : 56,
    left: inCorner('tl') ? 340 : 56,
    right: inCorner('tr') ? 400 : 130, // and room for the pin labels, which hang to the right
  };
  const at = (c: Corner) => cards.filter((x) => x.node && panels.isVisible(x.id) && cornerOf(x.id) === c);
  const POS: Record<Corner, React.CSSProperties> = {
    tl: { top: 12, left: 12, alignItems: 'flex-start' },
    tc: { top: 12, left: '50%', transform: 'translateX(-50%)', alignItems: 'center' },
    tr: { top: 12, right: 12, alignItems: 'flex-end' },
    bl: { bottom: 12, left: 12, alignItems: 'flex-start', flexDirection: 'column-reverse' },
    br: { bottom: 12, right: 52, alignItems: 'flex-end', flexDirection: 'column-reverse' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div ref={area} style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        {panels.isVisible('world') ? (
          <WorldMap data={data} selected={netDest} onSelect={select} sandboxAnchor={panels.isVisible('sandbox') ? anchor : undefined} insets={insets} />
        ) : (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--bg)' }} />
        )}
        {(Object.keys(POS) as Corner[]).map((c) => (
          // Top corners get about 60% of the height, bottom ones 40%, so the two stacks on a side never overlap.
          <div key={c} style={{ position: 'absolute', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 3, pointerEvents: 'none', maxHeight: c.startsWith('t') ? 'calc(60% - 18px)' : 'calc(40% - 18px)', ...POS[c] }}>
            {c === 'tc' && directBanner}
            {at(c).map((x) => <React.Fragment key={x.id}>{x.node}</React.Fragment>)}
          </div>
        ))}
        {dragging && <div style={{ position: 'absolute', inset: 0, zIndex: 6, cursor: 'grabbing', outline: '2px dashed var(--border-strong)', outlineOffset: -8 }} />}
      </div>
      {panels.isVisible('ribbon') && (
        <section aria-label="Last 60 seconds" style={{ height: 118, flexShrink: 0, borderTop: '1px solid var(--border)', background: 'var(--bg-card)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 28, padding: '0 12px' }}>
            <NetIcon name="ribbon" color="var(--text-muted)" />
            <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Last 60 seconds</h2>
            <span style={{ flex: 1 }} />
            <button type="button" aria-label="Hide Last 60 seconds" onClick={() => panels.toggle('ribbon')} style={{ display: 'flex', background: 'transparent', border: 'none', cursor: 'pointer' }}>
              <NetIcon name="close" size={10} color="var(--text-faint)" />
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}><Ribbon data={data} now={now} /></div>
        </section>
      )}
    </div>
  );
}


/**
 * The Topology tab (plan §7.3, topology.dc.html): the Routes diagram and the
 * Selected path panel. Geometry comes from `lib/net-topology.ts`; this file
 * only draws it. Clicking a destination or a band selects that path (the
 * `netDest` the Map and the Network tab share), which dims every other band.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { controlDisabledReason, siblingIds } from '../../lib/net-rules.js';
import { toolLabel } from '../../lib/net-table.js';
import { layoutTopology, pathHops, type BandKind, type HopEvidence, type LineTone, type Tone, type TopoBand, type TopoNode } from '../../lib/net-topology.js';
import { buttonStyle } from './ControlPopover.js';
import { Badge, Tile } from './DetailCard.js';
import { NetIcon } from './netui.js';

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
  const item = (colour: string, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
      <span style={{ width: 14, height: 3, borderRadius: 2, background: colour }} />{label}
    </span>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 10.5, color: 'var(--text-body)', overflow: 'hidden', minWidth: 0 }}>
      {item('var(--net-tunnel)', 'Tunnelled')}
      {item('var(--net-fanout)', 'SearXNG fan-out')}
      {item('var(--net-local)', 'Local')}
      {item('var(--warn)', 'Refused / blocked')}
      <span style={{ color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>Band width: bytes (square root)</span>
    </div>
  );
}

function Node({ n, selected, onSelect }: { n: TopoNode; selected: boolean; onSelect: (n: TopoNode) => void }) {
  const clickable = n.hosts.length > 0 && (n.kind === 'dest' || n.kind === 'broken' || n.kind === 'more');
  const common = clickable ? {
    role: 'button', tabIndex: 0, style: { cursor: 'pointer' },
    'aria-label': n.kind === 'more' ? `${n.title} destinations` : `Follow the path to ${n.title}`,
    onClick: () => onSelect(n),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(n); } },
  } : {};
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
  if (n.kind === 'dest' || n.kind === 'more') {
    return (
      <g {...common} data-node={n.id}>
        <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={4} fill={selected ? 'rgba(90,156,248,0.10)' : 'var(--bg-card)'}
          stroke={stroke} strokeWidth={selected ? 1.5 : 1} strokeDasharray={n.dashed ? '3 3' : undefined} />
        <text x={n.x + 8} y={n.y + n.h / 2 + 4} fontSize={11} fontFamily="var(--font-mono)" fill={n.kind === 'more' ? 'var(--text-muted)' : n.tone === 'direct' ? '#FF8A80' : 'var(--text)'}>
          {clip(n.title, n.w - (n.live ? 22 : 14))}
        </text>
        {n.live && <circle cx={n.x + n.w - 7} cy={n.y + n.h / 2} r={2.5} fill="var(--net-tunnel)" />}
        <title>{n.kind === 'more' ? n.hosts.join('\n') : n.title}</title>
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

export function TopologyDiagram({ data }: { data: NetSessionData }) {
  const ref = useRef<HTMLDivElement>(null);
  const { w, h } = useSize(ref);
  const netDest = useSessionStore((s) => s.netDest);
  const setNetDest = useSessionStore((s) => s.setNetDest);
  const t = useMemo(() => layoutTopology(data, w, h), [data, w, h]);
  const bytesOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data.destinations.values()) if (d.host) m.set(d.host, (m.get(d.host) ?? 0) + d.bytesUp + d.bytesDown);
    return m;
  }, [data.destinations]);
  // The busiest destination a click on a shared band or a "+N more" box stands for.
  const pick = (hosts: string[]) => [...hosts].sort((a, b) => (bytesOf.get(b) ?? 0) - (bytesOf.get(a) ?? 0))[0] ?? null;
  const select = (hosts: string[]) => { const h = pick(hosts); if (h) setNetDest(h === netDest ? null : h); };
  const on = (hosts: string[]) => netDest !== null && hosts.includes(netDest);

  const band = (b: TopoBand) => {
    const style = BAND[b.kind];
    const lit = on(b.hosts);
    const dim = netDest !== null && !lit && b.kind !== 'trigger';
    return (
      <g key={b.id} data-band={b.id}>
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
            onClick={() => select(b.hosts)}>
            <title>{`${b.hosts.slice(0, 6).join(', ')}${b.hosts.length > 6 ? ` +${b.hosts.length - 6}` : ''}${b.bytes ? ` · ${formatBytes(b.bytes)}` : ''}`}</title>
          </path>
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
  const bands = [...t.bands].sort((a, b) => order(a.kind) - order(b.kind));

  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <svg width="100%" height="100%" viewBox={`0 0 ${t.width} ${t.height}`} preserveAspectRatio="xMinYMin meet" role="img"
        aria-label={`Routes from ${data.token} through glove's services, policy and tunnel to ${t.nodes.filter((n) => n.kind === 'dest').length} destinations`}
        style={{ display: 'block' }}>
        {t.columns.map((c) => (
          <text key={c.id} x={c.x} y={26} fontSize={10} letterSpacing="0.08em" fontWeight={600} fill="var(--text-muted)"
            textAnchor={c.id === 'policy' ? 'middle' : 'start'}>{c.label.toUpperCase()}</text>
        ))}
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
        {t.nodes.map((n) => (
          <Node key={n.id} n={n} selected={n.kind === 'dest' && on(n.hosts)} onSelect={(x) => select(x.hosts)} />
        ))}
      </svg>
      {t.folded > 0 && (
        <div style={{ position: 'absolute', right: 10, bottom: 6, fontSize: 10.5, color: 'var(--text-faint)' }}>
          {t.folded} quieter destination{t.folded === 1 ? '' : 's'} folded to fit; the Network tab lists them all.
        </div>
      )}
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
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }} title={disabled ?? undefined}>
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

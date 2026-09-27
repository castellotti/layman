/**
 * The selected destination (plan §1.3): the Map's floating detail card and,
 * docked, the Network tab's Details panel. Sections are toggled from a small
 * menu and remembered: Totals, Agent asked for and Connection on by default,
 * Flows off; Policy is always shown. Connection is mockup A's
 * (workbench-connection-section-source.dc.html) "CONNECTION" section.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useExpandedSections } from '../../hooks/useExpandedSections.js';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { formatBytes, formatAge } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { clockTime, flowLabel, toolLabel } from '../../lib/net-table.js';
import { controlDisabledReason, siblingIds } from '../../lib/net-rules.js';
import type { DestinationAggregate, FlowView, GeoStatus, RulesOp, TraceView } from '../../lib/netobs-types.js';
import { buttonStyle } from './ControlPopover.js';
import { NetIcon } from './netui.js';
import { useNetTrace } from '../../hooks/useNetTrace.js';
import { openInTrace } from './TraceView.js';

type SectionId = 'totals' | 'asked' | 'connection' | 'flows';
const SECTIONS: Array<{ id: SectionId; label: string; on: boolean }> = [
  { id: 'totals', label: 'Totals', on: true },
  { id: 'asked', label: 'Agent asked for', on: true },
  { id: 'connection', label: 'Connection', on: true },
  { id: 'flows', label: 'Flows', on: false },
];

let geoStatus: Promise<GeoStatus | null> | null = null;
/** The geolocation database's name, for "Location … offline DB-IP Lite · file lookup". Asked of Layman's own API only. */
export function useGeoStatus(): GeoStatus | null {
  const [s, setS] = useState<GeoStatus | null>(null);
  useEffect(() => {
    geoStatus ??= fetch('/api/net/geo').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let live = true;
    geoStatus.then((v) => { if (live) setS(v); });
    // Re-ask next time a card mounts: Settings may have changed it.
    const t = setTimeout(() => { geoStatus = null; }, 10_000);
    return () => { live = false; clearTimeout(t); };
  }, []);
  return s;
}

const RESOLUTION: Record<string, string> = {
  'in-tunnel': 'resolved inside the tunnel',
  literal: 'the destination was an IP',
  unavailable: 'the in-tunnel lookup failed; never looked up elsewhere',
  disabled: 'not resolved: a configured endpoint',
};

export function Row({ k, v, sub, mono = true, colour }: { k: string; v: React.ReactNode; sub?: React.ReactNode; mono?: boolean; colour?: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 10, padding: '3px 0' }}>
      <span style={{ fontSize: 11, color: 'var(--text-faint)', textAlign: 'right' }}>{k}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 11.5, color: colour ?? 'var(--text-body)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)', wordBreak: 'break-all' }}>{v}</span>
        {sub && <span style={{ display: 'block', fontSize: 10, color: 'var(--text-faint)' }}>{sub}</span>}
      </span>
    </div>
  );
}

export function SectionHead({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-muted)', margin: '12px 0 6px', textTransform: 'uppercase' }}>{children}</div>;
}

export function Tile({ label, value, colour, icon }: { label: string; value: string; colour: string; icon: 'up' | 'down' }) {
  return (
    <div style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: `1px solid ${colour}`, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, letterSpacing: '0.08em', fontWeight: 600, color: colour }}>
        <NetIcon name={icon} color={colour} size={11} />{label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function routeText(data: NetSessionData, d: DestinationAggregate): { text: string; colour: string } {
  if (d.state === 'guard') return { text: 'never left: refused by glove’s guard', colour: 'var(--warn)' };
  if (d.scope === 'local') return { text: 'local link, never on the map', colour: 'var(--text-muted)' };
  if (d.scope === 'direct') return { text: 'direct: no tunnel, the operator’s real IP', colour: 'var(--error)' };
  const kind = data.gate.route.kind;
  const name = kind === 'vpn' ? 'VPN' : kind === 'tor' ? 'Tor' : kind ?? 'tunnel';
  const where = data.exit?.healthy ? data.exit.city ?? data.exit.country ?? data.exit.ip : null;
  return {
    text: data.gate.route.verified && where ? `${name} → exit ${where} · verified` : `${name} (declared, not verified)`,
    colour: data.gate.route.verified ? 'var(--net-tunnel)' : 'var(--warn)',
  };
}

function locationText(d: DestinationAggregate, geo: GeoStatus | null): { v: string; sub: string } {
  if (d.geo) {
    const where = [d.geo.city, d.geo.countryCode ?? d.geo.country].filter(Boolean).join(', ');
    return { v: where || `${d.geo.lat.toFixed(2)}, ${d.geo.lon.toFixed(2)}`, sub: `offline ${geo?.databaseType ?? 'database'} · file lookup` };
  }
  if (d.scope === 'local') return { v: 'not placed', sub: 'a local link is never on the map' };
  if (!d.ips.length) return { v: 'unknown', sub: 'glove has no IP for it; Layman never looks one up' };
  if (!geo?.loaded) return { v: 'unknown', sub: 'no geolocation database (Settings → Glove)' };
  return { v: 'unknown', sub: 'not in the geolocation database' };
}

function Policy({ data, d }: { data: NetSessionData; d: DestinationAggregate }) {
  const disabled = controlDisabledReason(data.rules);
  const v = d.policy.enforced;
  const apply = (op: RulesOp) => useNetStore.getState().applyRules(op);
  const pending = d.policy.written && v && (d.policy.written.action !== v.action || d.policy.written.rule !== v.rule);
  let badge: { text: string; colour: string; sub: string };
  if (d.state === 'guard') badge = { text: 'Refused by glove guard', colour: 'var(--warn)', sub: 'no rule can allow it' };
  else if (!v) badge = { text: 'Unknown', colour: 'var(--text-muted)', sub: 'Layman has not seen the rules the gate enforces' };
  else if (v.action === 'allow') badge = { text: 'Allowed', colour: 'var(--net-tunnel)', sub: v.rule ? `by rule ${v.rule}` : 'by default · no rule matches' };
  else badge = { text: v.rule ? 'Blocked by your rule' : 'Blocked by the default', colour: 'var(--error)', sub: v.rule ?? 'nothing allowed it' };
  const host = d.host;
  const apex = d.groupKey.includes('.') && d.groupKey !== host ? d.groupKey : null;
  const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
  return (
    <>
      <SectionHead>Policy</SectionHead>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 11, fontSize: 11, color: badge.colour, border: `1px solid ${badge.colour}`, background: 'var(--bg)' }}>
          <NetIcon name={v?.action === 'allow' ? 'check' : d.state === 'guard' ? 'lock' : 'blocked'} color={badge.colour} size={11} />{badge.text}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{pending ? 'waiting for the gate' : badge.sub}</span>
      </div>
      {d.state !== 'guard' && host && v && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} title={disabled ?? undefined}>
          {v.action === 'allow' && (
            <>
              <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'blockHost', host, terminate: false })} style={buttonStyle('danger')}>
                <NetIcon name="blocked" color="#FF8A80" />Block this host
              </button>
              {apex && <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'blockDomain', apex, terminate: false })} style={buttonStyle('plain')}>Block {apex}</button>}
              {d.openFlows > 0 && (
                <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'blockHost', host, terminate: true })} style={buttonStyle('plain')}>
                  <NetIcon name="cut" />Block and cut live flow{d.openFlows === 1 ? '' : 's'}
                </button>
              )}
            </>
          )}
          {v.action === 'block' && v.rule && (
            <button type="button" disabled={!!disabled} onClick={() => apply(v.rule!.startsWith('r_layman_cut_') ? { kind: 'restoreAll' } : { kind: 'removeRule', ids: siblingIds(v.rule!, rules) })} style={buttonStyle('ok')}>
              <NetIcon name="check" color="var(--net-tunnel)" />{v.rule.startsWith('r_layman_cut_') ? 'Restore all traffic' : 'Unblock'}
            </button>
          )}
          {v.action === 'block' && !v.rule && (
            <>
              <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'allowHost', host })} style={buttonStyle('ok')}>Allow this host</button>
              {apex && <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'allowDomain', apex })} style={buttonStyle('plain')}>Allow {apex}</button>}
            </>
          )}
        </div>
      )}
    </>
  );
}

/**
 * "Agent asked for": the tool call the transcript says produced this
 * destination's latest flow, from the trace of the turn it opened in
 * (`netobs/correlate.ts`). The gate alone never knows the URL behind a CONNECT.
 */
function AskedFor({ data, host, port, flows }: { data: NetSessionData; host: string | null; port: number | null; flows: FlowView[] }) {
  const f = flows[0];
  // Re-read while the card is open: a running turn's calls arrive after its flows.
  const latest = useNetTrace(f ? data.token : null, f ? { at: f.tOpen } : null, f ? f.id : '', 5000);
  const mine = new Set(flows.map((x) => x.id));
  const claim = (v: TraceView | null) => {
    const hit = v?.items.find((i) => i.kind === 'call' && [...i.flowIds, ...i.fanoutIds].some((id) => mine.has(id)));
    return hit?.kind === 'call' ? { call: hit.call, flowId: [...hit.flowIds, ...hit.fanoutIds].find((id) => mine.has(id)) ?? null, view: v! } : null;
  };
  // A harness records a call only once it has finished (pi's watcher never shows one in flight),
  // so a flow in the turn still running is not claimed yet: meanwhile, show the latest flow before it that was.
  const running = !!latest.view?.turn && latest.view.turns[latest.view.turns.length - 1]?.promptEventId === latest.view.turn.promptEventId;
  const earlier = running && !claim(latest.view) ? flows.find((x) => latest.view!.window && x.tOpen < latest.view!.window.from) : undefined;
  const before = useNetTrace(earlier ? data.token : null, earlier ? { at: earlier.tOpen } : null, earlier ? earlier.id : '', 0);
  const found = claim(latest.view) ?? claim(before.view);
  const { view, error } = latest;
  const call = found?.call ?? null;
  const gateSaw = f?.proto === 'http-connect' ? `CONNECT ${host}:${port ?? 443}` : `a connection to ${host}`;
  let body: React.ReactNode;
  if (!f) body = 'No flow to join yet.';
  else if (error) body = `The transcript could not be read: ${error}.`;
  else if (!view) body = 'Looking in the transcript…';
  else if (!view.sessionIds.length) body = `No Layman session is named “${data.token}”, so there is no transcript to join. The gate saw only ${gateSaw}.`;
  else if (!call && running) body = `The turn this opened in is still running; its tool calls appear once the harness records them. The gate saw only ${gateSaw}.`;
  else if (!call) body = `No tool call in the turn it happened in names this host; Layman does not guess. The gate saw only ${gateSaw}.`;
  const earlierNote = found && found.view !== view ? ' · an earlier turn' : '';
  return (
    <>
      <SectionHead>Agent asked for</SectionHead>
      {call && found?.view.turn ? (
        <div style={{ padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg)' }}>
          <div style={{ fontSize: 10.5, color: 'var(--info)' }}>
            {call.toolName} · {clockTime(call.start)}{call.timing === 'approximate' ? ' (read time)' : ''}{earlierNote}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text)', wordBreak: 'break-all', marginTop: 2 }}>
            {call.kind === 'search' ? `“${call.label}”` : call.label}
          </div>
          <button type="button" onClick={() => openInTrace(data.token, found.view.turn!.promptEventId, found.flowId)}
            style={{ background: 'none', border: 'none', padding: 0, marginTop: 4, color: 'var(--info)', cursor: 'pointer', fontSize: 10.5, fontFamily: 'var(--font-ui)' }}>
            Open in Trace
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{body}</div>
      )}
    </>
  );
}

export function DetailCard({ data, host, onClose, docked = false }: {
  data: NetSessionData;
  host: string | null;
  onClose?: () => void;
  /** In the Network tab's Details panel rather than floating over the map. */
  docked?: boolean;
}) {
  const geo = useGeoStatus();
  const flips = useExpandedSections('layman.net.detail.sections');
  const [menu, setMenu] = useState(false);
  const shown = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.on !== flips.isExpanded(id);
  const dests = useMemo(() => [...data.destinations.values()].filter((d) => d.host === host), [data.destinations, host]);
  const d = dests.sort((a, b) => b.lastSeen - a.lastSeen)[0];
  const flows: FlowView[] = useMemo(() => (d ? [...data.flows.values()].filter((f) => f.destKey === d.key).sort((a, b) => b.tOpen - a.tOpen) : []), [data.flows, d]);

  if (!host || !d) {
    return (
      <div style={{ padding: 14, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Select a destination in the table or on the map to see where it went, what the agent asked for, and what the gate did.
      </div>
    );
  }
  const f = flows[0];
  const route = routeText(data, d);
  const loc = locationText(d, geo);
  const live = d.state === 'active';
  return (
    <div style={{ padding: docked ? 12 : 14, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <NetIcon name="globe" size={14} color={d.scope === 'direct' ? 'var(--error)' : 'var(--net-tunnel)'} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)', wordBreak: 'break-all' }}>{d.host}</span>
            {live && <Badge colour="var(--net-tunnel)">LIVE</Badge>}
            {d.scope === 'direct' && <Badge colour="var(--error)">DIRECT</Badge>}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2 }}>
            {[d.ips[0], d.geo?.city, d.tools.map(toolLabel).join(', '), `${d.flows} flow${d.flows === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
          </div>
        </div>
        <button type="button" aria-label="Choose sections" aria-expanded={menu} onClick={() => setMenu((m) => !m)} style={iconButton}>
          <NetIcon name="legend" size={12} color="var(--text-faint)" />
        </button>
        {onClose && <button type="button" aria-label="Close details" onClick={onClose} style={iconButton}><NetIcon name="close" size={11} color="var(--text-faint)" /></button>}
      </div>
      {menu && (
        <div role="menu" style={{ position: 'absolute', right: 12, top: 40, zIndex: 5, padding: 6, borderRadius: 6, background: 'var(--bg-card)', border: '1px solid var(--border-strong)', boxShadow: '0 8px 24px rgba(0,0,0,0.5)' }}>
          {SECTIONS.map((s) => (
            <label key={s.id} role="menuitemcheckbox" aria-checked={shown(s.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-body)', padding: '3px 6px', cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={shown(s.id)} onChange={() => flips.toggle(s.id)} />{s.label}
            </label>
          ))}
          <div style={{ fontSize: 10, color: 'var(--text-faint)', padding: '3px 6px' }}>Policy is always shown.</div>
        </div>
      )}

      {shown('totals') && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Tile label="SENT" value={formatBytes(d.bytesUp)} colour="var(--net-up)" icon="up" />
          <Tile label="RECEIVED" value={formatBytes(d.bytesDown)} colour="var(--net-down)" icon="down" />
        </div>
      )}

      {shown('asked') && <AskedFor data={data} host={d.host} port={d.port} flows={flows} />}

      {shown('connection') && (
        <>
          <SectionHead>Connection</SectionHead>
          <Row k="IP" v={d.ips[0] ?? '—'} sub={RESOLUTION[d.resolution] ?? d.resolution} />
          <Row k="Port" v={`${d.port ?? '—'}${f?.proto ? ` · ${f.proto}` : ''}`} />
          <Row k="Service" v={`${d.services.join(', ') || '—'}${f?.route?.upstream ? ` → ${f.route.upstream.replace(/^https?:\/\//, '')}` : ''}`} />
          <Row k="Route" v={route.text} mono={false} colour={route.colour} />
          <Row k="Location" v={loc.v} sub={loc.sub} mono={false} />
          {f && <Row k="Opened" v={`${clockTime(f.tOpen)}.${String(f.tOpen % 1000).padStart(3, '0')}`} />}
          {f && (
            <Row k={f.phase === 'close' ? 'Closed' : 'Open'}
              v={f.phase === 'close' ? `${f.closeReason ?? 'closed'} · after ${formatAge((f.tClose ?? f.lastT) - f.tOpen)}` : `for ${formatAge(Date.now() - f.tOpen)}`} />
          )}
          {f && <Row k="Flow" v={f.id} />}
        </>
      )}

      {shown('flows') && flows.length > 0 && (
        <>
          <SectionHead>Flows · {flows.length}</SectionHead>
          {flows.slice(0, 12).map((x) => (
            <div key={x.id} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-body)' }}>{flowLabel(x.id).replace('flow ', '')}</span>
              <span style={{ color: 'var(--text-faint)', flex: 1 }}>{x.phase === 'close' ? x.closeReason ?? 'closed' : `open · ${formatAge(Date.now() - x.tOpen)}`}</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{formatBytes(x.bytes.down)}</span>
            </div>
          ))}
        </>
      )}

      <Policy data={data} d={d} />
    </div>
  );
}

export const Badge = ({ colour, children }: { colour: string; children: React.ReactNode }) => (
  <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', color: colour, border: `1px solid ${colour}`, borderRadius: 4, padding: '0 5px' }}>{children}</span>
);
const iconButton: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, background: 'transparent', border: 'none', borderRadius: 4, cursor: 'pointer' };

/** Close = deselect. */
export function useCloseDetail(): () => void {
  const setNetDest = useSessionStore((s) => s.setNetDest);
  return () => setNetDest(null);
}

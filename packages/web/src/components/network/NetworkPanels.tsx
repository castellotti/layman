/**
 * The Network tab's other pieces: the KPI
 * row above the panels, the mini map, and the Rules panel's "View file" link. The Rules panel
 * itself is `RulesPanel.tsx`.
 */
import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { BLOCK_STATES, formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { NetIcon, type NetIconName } from './netui.js';
import { WorldMap } from './WorldMap.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ROUTE_NAME: Record<string, string> = { vpn: 'the VPN', tor: 'Tor' };

// ─── KPI row ──────────────────────────────────────────────────────────────────

function Kpi({ icon, iconColour, label, value, valueColour = 'var(--text)', sub, alert }: {
  icon: NetIconName; iconColour: string; label: string; value: string; valueColour?: string; sub: string; alert?: boolean;
}) {
  return (
    <div role={alert ? 'alert' : undefined} style={{
      flex: '1 1 0', minWidth: 0, padding: '10px 12px', borderRadius: 8,
      background: alert ? 'rgba(240,86,74,0.10)' : 'var(--bg-card)', border: `1px solid ${alert ? 'var(--error)' : 'var(--border)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, letterSpacing: '0.08em', fontWeight: 600, color: alert ? '#FF8A80' : 'var(--text-muted)' }}>
        <NetIcon name={icon} size={13} color={iconColour} />{label}
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 600, color: valueColour, marginTop: 3 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: alert ? '#F3C6C1' : 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={sub}>{sub}</div>
    </div>
  );
}

export function KpiRow({ data }: { data: NetSessionData }) {
  const t = data.totals;
  const dests = [...data.destinations.values()];
  const reachable = dests.filter((d) => d.scope !== 'local' && !BLOCK_STATES.has(d.state));
  const unknown = reachable.filter((d) => d.flags.unresolved).length;
  const blocked = t.blocked.guard + t.blocked.userRule + t.blocked.default;
  const blockedParts = [
    t.blocked.guard && `${t.blocked.guard} by glove guard`,
    t.blocked.userRule && `${t.blocked.userRule} by your rule${t.blocked.userRule === 1 ? '' : 's'}`,
    t.blocked.default && `${t.blocked.default} by the default`,
  ].filter(Boolean);
  const route = data.gate.route.kind;
  const liveSub = t.gateLost ? `flows open now · ${t.gateLost} lost with their gate` : 'flows open now';
  return (
    <div style={{ display: 'flex', gap: 8, padding: '8px 8px 0', flexShrink: 0 }}>
      <Kpi icon="up" iconColour="var(--net-up)" label="SENT" value={formatBytes(t.bytesUp)} valueColour="var(--net-up)" sub="this session" />
      <Kpi icon="down" iconColour="var(--net-down)" label="RECEIVED" value={formatBytes(t.bytesDown)} valueColour="var(--net-down)" sub="this session" />
      <Kpi icon="pulse" iconColour="var(--net-tunnel)" label="LIVE" value={String(t.openFlows)} valueColour="var(--net-tunnel)" sub={liveSub} />
      <Kpi icon="globe" iconColour="var(--text-muted)" label="DESTINATIONS" value={String(t.destinations)}
        sub={`${reachable.length - unknown} to map · ${unknown} unknown location`} />
      <Kpi icon="blocked" iconColour="var(--error)" label="BLOCKED" value={String(blocked)} valueColour={blocked ? 'var(--error)' : 'var(--text)'}
        sub={blockedParts.length ? blockedParts.join(' · ') : 'nothing blocked'} />
      {t.directFlows > 0 ? (
        <Kpi alert icon="alert" iconColour="var(--error)" label="UNTUNNELLED" value={String(t.directFlows)} valueColour="#FF8A80"
          sub={`${plural(t.directFlows, 'flow')} skipped the tunnel`} />
      ) : (
        <Kpi icon="check" iconColour="var(--ok)" label="UNTUNNELLED" value="0" valueColour="var(--ok)"
          sub={route === 'tcp' ? 'no proxied egress in this session' : `every egress flow used ${ROUTE_NAME[route ?? ''] ?? 'the tunnel'}`} />
      )}
    </div>
  );
}

// ─── Mini map ─────────────────────────────────────────────────────────────────

/**
 * The Map tab's renderer at small size: no labels, no pan or zoom,
 * the trunk and arcs. A click opens the Map tab, with the selection kept.
 */
export function MiniMap({ data }: { data: NetSessionData }) {
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const netDest = useSessionStore((s) => s.netDest);
  const dests = [...data.destinations.values()].filter((d) => d.scope !== 'local' && !BLOCK_STATES.has(d.state));
  const placed = dests.filter((d) => d.geo).length;
  const exit = data.exit?.healthy ? data.exit : null;
  const origin = exit ? `exit ${exit.city ? `${exit.city}, ` : ''}${exit.country ?? exit.ip ?? ''}` : 'exit not observed';
  return (
    <div role="button" tabIndex={0} aria-label="Open the Map tab" onClick={() => setViewMode('map')}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setViewMode('map'); }}
      style={{ position: 'relative', width: '100%', height: '100%', minHeight: 150, cursor: 'pointer', overflow: 'hidden' }}>
      <WorldMap data={data} selected={netDest} compact />
      <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 10, color: 'var(--text-muted)', background: 'rgba(11,14,20,0.8)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '2px 8px' }}>
        {placed} mapped · Unknown location · {dests.length - placed}
      </span>
      <span style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--text-body)', background: 'rgba(11,14,20,0.8)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '2px 8px' }}>
        <NetIcon name="tunnel" color="var(--net-tunnel)" /> sandbox → {origin}
      </span>
    </div>
  );
}

export function MiniMapExpand() {
  const setViewMode = useSessionStore((s) => s.setViewMode);
  return (
    <button type="button" onClick={() => setViewMode('map')} style={linkStyle}>Expand</button>
  );
}

const linkStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: '0 4px', color: 'var(--info)', cursor: 'pointer', fontSize: 10.5, fontFamily: 'var(--font-ui)',
};

// ─── Rules ────────────────────────────────────────────────────────────────────

/** "View file" in the Rules panel header: shows the path and the file as Layman read it. */
export function RulesFileLink({ data }: { data: NetSessionData }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} style={linkStyle}>{open ? 'Hide file' : 'View file'}</button>
      {open && (
        <div role="dialog" aria-label="rules.json" style={{
          position: 'fixed', right: 24, top: 120, width: 420, maxHeight: '60vh', overflow: 'auto', zIndex: 50, padding: 10,
          background: 'var(--bg-card)', border: '1px solid var(--border-strong)', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={data.rules.displayPath}>
              {data.rules.displayPath}
            </span>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}>
              <NetIcon name="close" size={11} color="var(--text-faint)" />
            </button>
          </div>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-body)', whiteSpace: 'pre-wrap' }}>
            {data.rules.readError ?? (data.rules.file ? JSON.stringify(data.rules.file, null, 2) : 'rules.json is not present.')}
          </pre>
        </div>
      )}
    </>
  );
}

/**
 * The Network tab's other pieces (plan §7.1, network-ledger.dc.html): the KPI
 * row above the panels, the mini map (a placeholder until the Map tab's
 * renderer exists), and the Rules panel, read-only until Layman can write rules.
 */
import React from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { BLOCK_STATES, formatBytes } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { clockTime, matchText } from '../../lib/net-table.js';
import { NetIcon, type NetIconName } from './netui.js';

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

// ─── Mini map (placeholder) ───────────────────────────────────────────────────

/**
 * Stands in for the Map tab's renderer at small size (plan §7.1), which arrives
 * with the Map tab. It already says what the map will: where the traffic
 * appears to come from, and how much of it can be placed.
 */
export function MiniMap({ data }: { data: NetSessionData }) {
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const dests = [...data.destinations.values()].filter((d) => d.scope !== 'local' && !BLOCK_STATES.has(d.state));
  const unknown = dests.filter((d) => d.flags.unresolved).length;
  const exit = data.exit?.healthy ? data.exit : null;
  const origin = exit ? `exit ${exit.city ? `${exit.city}, ` : ''}${exit.country ?? exit.ip ?? ''}` : 'exit not observed';
  return (
    <button
      type="button"
      onClick={() => setViewMode('map')}
      aria-label="Open the Map tab"
      style={{ position: 'relative', display: 'block', width: '100%', height: '100%', minHeight: 150, padding: 0, border: 'none', cursor: 'pointer', background: 'var(--net-ocean)', overflow: 'hidden' }}
    >
      <svg width="100%" height="100%" viewBox="0 0 360 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" style={{ position: 'absolute', inset: 0 }}>
        {Array.from({ length: 9 }, (_, i) => <line key={`h${i}`} x1="0" x2="360" y1={i * 25} y2={i * 25} stroke="var(--net-landline)" strokeWidth="0.5" />)}
        {Array.from({ length: 15 }, (_, i) => <line key={`v${i}`} y1="0" y2="200" x1={i * 25} x2={i * 25} stroke="var(--net-landline)" strokeWidth="0.5" />)}
        <path d="M40 150 Q 180 20 310 90" fill="none" stroke="var(--net-tunnel)" strokeWidth="2" strokeDasharray={exit ? undefined : '5 4'} opacity="0.85" />
        <circle cx="40" cy="150" r="4" fill="var(--bg)" stroke="var(--net-tunnel)" strokeWidth="1.5" />
        <circle cx="310" cy="90" r="5" fill="var(--net-tunnel)" opacity={exit ? 1 : 0.4} />
      </svg>
      <span style={{ position: 'absolute', top: 8, right: 8, fontSize: 10, color: 'var(--text-muted)', background: 'rgba(11,14,20,0.8)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '2px 8px' }}>
        {dests.length - unknown} to map · Unknown location · {unknown}
      </span>
      <span style={{ position: 'absolute', left: 8, bottom: 8, display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: 'var(--text-body)', background: 'rgba(11,14,20,0.8)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '2px 8px' }}>
        <NetIcon name="tunnel" color="var(--net-tunnel)" /> sandbox → {origin}
      </span>
    </button>
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

// ─── Rules (read-only) ────────────────────────────────────────────────────────

function StatusBox({ tone, title, sub }: { tone: 'ok' | 'error' | 'neutral'; title: React.ReactNode; sub: React.ReactNode }) {
  const c = tone === 'ok'
    ? { bg: 'rgba(76,195,138,0.08)', border: 'rgba(76,195,138,0.3)', icon: 'check' as const, colour: 'var(--ok)' }
    : tone === 'error'
      ? { bg: 'rgba(240,86,74,0.10)', border: 'rgba(240,86,74,0.5)', icon: 'alert' as const, colour: 'var(--error)' }
      : { bg: 'rgba(255,255,255,0.03)', border: 'var(--border-strong)', icon: 'shield' as const, colour: 'var(--text-muted)' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 9px', borderRadius: 6, background: c.bg, border: `1px solid ${c.border}`, marginBottom: 10 }}>
      <NetIcon name={c.icon} color={c.colour} />
      <div style={{ fontSize: 11, color: 'var(--text-body)', minWidth: 0 }}>
        {title}
        <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{sub}</div>
      </div>
    </div>
  );
}

const sectionTitle: React.CSSProperties = { fontSize: 10, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 };

function RuleRow({ index, action, match, sub, hits, locked, badge }: {
  index: number; action: string; match: string; sub: string; hits: number | null; locked?: boolean; badge?: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)' }}>
      {locked ? <NetIcon name="lock" color="var(--warn)" /> : <span style={{ width: 12 }} />}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', width: 12 }}>{index}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', color: action === 'allow' ? 'var(--net-tunnel)' : 'var(--error)', width: 38 }}>
        {action.toUpperCase()}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={match}>{match}</div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
      </div>
      {badge && (
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--warn)', border: '1px solid rgba(229,168,59,0.45)', background: 'rgba(229,168,59,0.1)', borderRadius: 4, padding: '1px 5px', whiteSpace: 'nowrap' }}>
          {badge}
        </span>
      )}
      {hits !== null && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{plural(hits, 'hit')}</span>}
      {locked && <span style={{ fontSize: 10, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>not editable</span>}
    </div>
  );
}

/**
 * What glove enforces, in the order it evaluates it: the built-in guard first
 * (locked), then rules.json top to bottom, then the default. The status box
 * says whether the file on disk is what the gate enforces.
 */
export function RulesPanel({ data }: { data: NetSessionData }) {
  const status = data.gate.rules;
  const view = data.rules;
  const file = view.file;
  const hits = new Map<string, number>();
  for (const d of data.destinations.values()) if (d.rule) hits.set(d.rule, (hits.get(d.rule) ?? 0) + d.blocked);

  let box: React.ReactNode;
  if (!status) {
    box = <StatusBox tone="neutral" title="The gate has not reported its rules" sub="No status.json has been read for this session." />;
  } else if (!status.ok) {
    const unreadable = status.error?.startsWith('cannot read');
    box = (
      <StatusBox
        tone="error"
        title={unreadable ? 'The gate cannot read rules.json' : 'Not enforced: glove rejected rules.json'}
        sub={`${unreadable ? 'Almost always ownership: the gate runs as your user and must be able to read the file. ' : `${status.error ?? 'No reason given'}. `}The previous ${plural(status.active_count, 'rule')} ${status.active_count === 1 ? 'is' : 'are'} still enforced.`}
      />
    );
  } else if (!view.exists) {
    box = <StatusBox tone="neutral" title="No rules.json" sub="Everything is allowed unless glove’s guard refuses it." />;
  } else {
    box = (
      <StatusBox
        tone="ok"
        title={<>Enforced by the gate{status.loaded_at ? <> · loaded <span style={{ fontFamily: 'var(--font-mono)' }}>{clockTime(Date.parse(status.loaded_at))}</span></> : null}</>}
        sub="glove re-reads rules.json about once a second"
      />
    );
  }

  const def = file?.default ?? 'allow';
  // A rejected file is on disk but not in force, and Layman cannot see the set
  // that is: list the file's rules for what they are, not as the gate's order.
  const rejected = status?.ok === false;
  return (
    <div style={{ padding: 10 }}>
      {box}
      <div style={{ ...sectionTitle, color: rejected ? 'var(--error)' : sectionTitle.color }}>
        {rejected ? 'IN RULES.JSON · NOT ENFORCED' : 'EVALUATION ORDER'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <RuleRow index={0} action="block" match="internal, metadata, malformed" sub="glove built-in guard, runs first" hits={data.totals.blocked.guard} locked />
        {(file?.rules ?? []).map((r, i) => (
          <RuleRow key={r.id || i} index={i + 1} action={r.action} match={matchText(r)} sub={r.note ?? r.id}
            hits={hits.get(r.id) ?? 0} badge={r.terminate ? 'CUTS OPEN' : undefined} />
        ))}
        {view.readError && (
          <div style={{ fontSize: 10.5, color: 'var(--error)', fontFamily: 'var(--font-mono)' }}>rules.json: {view.readError}</div>
        )}
      </div>

      <div style={{ ...sectionTitle, marginTop: 12 }}>{rejected ? 'WHEN NOTHING MATCHES · IN THE REJECTED FILE' : 'WHEN NOTHING MATCHES'}</div>
      <div role="radiogroup" aria-label="Default policy" aria-readonly="true" style={{ display: 'flex', border: '1px solid var(--border-strong)', borderRadius: 6, overflow: 'hidden' }}>
        {(['allow', 'block'] as const).map((p, i) => (
          <button key={p} type="button" role="radio" aria-checked={def === p} disabled title="Read-only for now"
            style={{
              flex: 1, height: 26, border: 'none', borderLeft: i ? '1px solid var(--border-strong)' : 'none', fontSize: 11,
              background: def === p ? 'var(--bg-selected)' : 'transparent', color: def === p ? 'var(--text)' : 'var(--text-muted)',
              fontFamily: 'var(--font-ui)', cursor: 'default',
            }}>
            {p === 'allow' ? 'Allow unless blocked' : 'Block unless allowed'}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
        Read-only: Layman does not change rules yet. Edit <span style={{ fontFamily: 'var(--font-mono)' }}>{view.displayPath}</span>, or use <span style={{ fontFamily: 'var(--font-mono)' }}>glove net block</span>.
      </div>
    </div>
  );
}

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

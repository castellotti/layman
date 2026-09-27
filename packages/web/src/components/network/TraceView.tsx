/**
 * The Trace tab: one turn at a time,
 * each tool call the agent made over the flows the gate saw for it. The join is
 * the server's (`netobs/correlate.ts`, `GET /api/net/sessions/:token/trace`);
 * rows and wording are `lib/net-trace.ts`; this file draws the turn bar, the
 * waterfall and the Details panel, which share one small store.
 *
 * Only Layman's own API is asked for anything.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useNetStore } from '../../stores/netStore.js';
import { useSessionStore } from '../../stores/sessionStore.js';
import { formatBytes, NET_STATE_INFO } from '../../lib/net-format.js';
import type { NetSessionData } from '../../lib/net-state.js';
import { controlDisabledReason, siblingIds, toggleFor } from '../../lib/net-rules.js';
import { clockTime, destinationRow, guardReason } from '../../lib/net-table.js';
import { buildPath } from '../../lib/layman-url.js';
import { callForFlow, defaultSelection, tickLabel, traceAxis, traceRows, type Tone, type TraceIcon, type TraceRow } from '../../lib/net-trace.js';
import type { FlowView, RulesOp, TraceView } from '../../lib/netobs-types.js';
import { useNow } from '../../hooks/useNow.js';
import { fetchTrace } from '../../hooks/useNetTrace.js';
import { buttonStyle, ControlPopover } from './ControlPopover.js';
import { NetToggle } from './cells.js';
import { Row, SectionHead } from './DetailCard.js';
import { EmptyState, NetIcon, type NetIconName } from './netui.js';

// ─── Shared state ─────────────────────────────────────────────────────────────

interface TraceState {
  token: string | null;
  /** The turn asked for; null follows the latest. */
  turnId: string | null;
  view: TraceView | null;
  error: string | null;
  /** The row whose details show; null until the reader picks one (the default then applies). */
  selected: string | null;
  toggled: Set<string>;
  onlyTraffic: boolean;
  set: (p: Partial<TraceState>) => void;
}

const useTrace = create<TraceState>((set) => ({
  token: null, turnId: null, view: null, error: null, selected: null, toggled: new Set(), onlyTraffic: false,
  set: (p) => set(p),
}));

/** Refreshes while the tab is open: new flows arrive over the socket, new turns only through the API. */
const REFRESH_MS = 3000;

function useTraceData(token: string) {
  const turnId = useTrace((s) => s.turnId);
  const set = useTrace((s) => s.set);
  useEffect(() => {
    if (useTrace.getState().token !== token) set({ token, turnId: null, view: null, selected: null, toggled: new Set(), error: null });
  }, [token, set]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The next load is scheduled once this one settles, never on a fixed beat: a slow build
    // (a long session) must not stack requests behind it.
    const load = () => {
      fetchTrace(token, turnId ? { turn: turnId } : null)
        .then((v) => { if (live) set({ view: v, error: null }); })
        .catch((e: Error) => { if (live) set({ error: e.message }); })
        .finally(() => { if (live) timer = setTimeout(load, REFRESH_MS); });
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [token, turnId, set]);
}

/** Show one turn in the Trace tab with one flow selected: the detail card's "Open in Trace". */
export function openInTrace(token: string, promptEventId: string, flowId: string | null): void {
  // The token too: the tab resets its state when it mounts for a different glove session.
  useTrace.getState().set({ token, turnId: promptEventId, view: null, selected: flowId ? `flow:${flowId}` : null, toggled: new Set(), error: null });
  useSessionStore.getState().setViewMode('trace');
}

// ─── Turn bar ─────────────────────────────────────────────────────────────────

function Chip({ tone, icon, children }: { tone: 'neutral' | 'warn' | 'error' | 'info'; icon?: NetIconName; children: React.ReactNode }) {
  const c = { neutral: ['var(--text-body)', 'var(--border-strong)'], warn: ['var(--warn)', 'rgba(229,168,59,0.5)'], error: ['#FF8A80', 'rgba(240,86,74,0.55)'], info: ['var(--info)', 'rgba(90,156,248,0.5)'] }[tone];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 11, fontSize: 11, whiteSpace: 'nowrap', color: c[0], border: `1px solid ${c[1]}`, background: 'var(--bg)' }}>
      {icon && <NetIcon name={icon} size={11} color={c[0]} />}{children}
    </span>
  );
}

export function TurnBar({ data }: { data: NetSessionData }) {
  useTraceData(data.token);
  const { view, error, set } = useTrace();
  const nav = view?.nav;
  const go = (turnId: string | null | undefined) => { if (turnId) set({ turnId, selected: null, toggled: new Set() }); };
  const navStyle: React.CSSProperties = { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg-pill)', color: 'var(--text)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' };
  if (!view) {
    return <div style={{ margin: '8px 8px 0', padding: '10px 14px', fontSize: 11.5, color: 'var(--text-muted)' }}>{error ? `Trace unavailable: ${error}` : 'Loading the trace…'}</div>;
  }
  if (!view.turn) return null;
  const t = view.turn;
  const c = view.counts;
  return (
    <div role="region" aria-label="Turn" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 8px 0', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" aria-label="Previous turn" disabled={!nav?.prev} onClick={() => go(nav?.prev)} style={{ ...navStyle, opacity: nav?.prev ? 1 : 0.4 }}>
          <span style={{ display: 'inline-block', transform: 'rotate(90deg)' }}><NetIcon name="chevron" size={12} /></span>
        </button>
        <button type="button" aria-label="Next turn" disabled={!nav?.next} onClick={() => go(nav?.next)} style={{ ...navStyle, opacity: nav?.next ? 1 : 0.4 }}>
          <span style={{ display: 'inline-block', transform: 'rotate(-90deg)' }}><NetIcon name="chevron" size={12} /></span>
        </button>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 10.5 }}>
          <span style={{ color: 'var(--info)', fontWeight: 600, letterSpacing: '0.06em' }}>TURN {(nav?.index ?? -1) + 1} OF {nav?.count ?? 0}</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-faint)' }}>{clockTime(t.startedAt)}</span>
          <span style={{ color: 'var(--text-faint)' }}>{data.session?.harness ?? 'harness'} · {data.token}</span>
        </div>
        <div title={t.promptText} style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>“{t.promptText}”</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Chip tone="neutral">{c.calls} tool call{c.calls === 1 ? '' : 's'}</Chip>
        <Chip tone="neutral">{c.flows} flow{c.flows === 1 ? '' : 's'}</Chip>
        {c.refused > 0 && <Chip tone="warn" icon="shield">{c.refused} refused</Chip>}
        {c.blocked > 0 && <Chip tone="error" icon="blocked">{c.blocked} blocked</Chip>}
        <Chip tone="info" icon="down">{formatBytes(c.bytesDown)}</Chip>
      </div>
    </div>
  );
}

// ─── Waterfall ────────────────────────────────────────────────────────────────

const TONE: Record<Tone, string> = {
  muted: 'var(--text-muted)', ok: 'var(--text-muted)', tunnel: 'var(--net-tunnel)', warn: 'var(--warn)', error: '#FF8A80', fanout: 'var(--net-fanout)', local: 'var(--text-muted)',
};
const BAR: Record<Tone, string> = {
  muted: 'var(--text-faint)', ok: 'var(--net-tunnel)', tunnel: 'var(--net-tunnel)', warn: 'var(--warn)', error: 'var(--error)', fanout: 'var(--net-fanout)', local: 'var(--net-local)',
};
const ICON: Record<TraceIcon, NetIconName> = {
  search: 'search', fetch: 'window', tool: 'details', llm: 'gear', globe: 'globe', lock: 'lock', blocked: 'blocked', broken: 'broken', cut: 'cut',
  home: 'home', fanout: 'fanout', alert: 'alert', check: 'check', pulse: 'pulse', fold: 'fold',
};
const GRID = 'minmax(0, 1.5fr) minmax(120px, 0.8fr) 64px minmax(140px, 1.3fr) 40px';

export function TraceActions() {
  const onlyTraffic = useTrace((s) => s.onlyTraffic);
  const set = useTrace((s) => s.set);
  return (
    <button type="button" aria-pressed={onlyTraffic} onClick={() => set({ onlyTraffic: !onlyTraffic })} style={{
      ...buttonStyle(onlyTraffic ? 'plain' : 'ghost'), height: 22, fontSize: 10.5, padding: '0 8px',
    }}>
      <NetIcon name="legend" size={11} />Only calls with traffic
    </button>
  );
}

function RowView({ row, data, selected, onSelect, onToggleRow, onPolicy, axisWidthPct }: {
  row: TraceRow; data: NetSessionData; selected: boolean;
  onSelect: () => void; onToggleRow: () => void; onPolicy: (flow: FlowView, anchor: DOMRect) => void; axisWidthPct: number;
}) {
  const flow = row.flowId ? data.flows.get(row.flowId) ?? null : null;
  const dest = flow?.destKey ? data.destinations.get(flow.destKey) ?? null : null;
  const pad = 10 + row.depth * 18;
  const isCall = row.kind === 'call';
  const titleColour = isCall ? (row.call?.kind === 'search' ? 'var(--net-fanout)' : 'var(--info)') : row.kind === 'group' ? 'var(--text-muted)' : 'var(--text)';
  const refusal = row.outcome?.tone === 'warn' || row.outcome?.tone === 'error';
  return (
    <div role="row" aria-selected={selected} data-row={row.id} onClick={onSelect} style={{
      display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', minHeight: 27, cursor: 'pointer',
      borderBottom: '1px solid var(--border)', borderLeft: `2px solid ${selected ? 'var(--warn)' : 'transparent'}`,
      background: selected ? 'rgba(229,168,59,0.07)' : isCall ? 'rgba(255,255,255,0.012)' : undefined,
    }}>
      <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: pad, minWidth: 0 }}>
        {row.expandable ? (
          <button type="button" aria-label={row.expanded ? 'Collapse' : 'Expand'} aria-expanded={row.expanded}
            onClick={(e) => { e.stopPropagation(); onToggleRow(); }}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', transform: row.expanded ? undefined : 'rotate(-90deg)' }}>
            <NetIcon name="chevron" size={11} color="var(--text-faint)" />
          </button>
        ) : <span style={{ width: 11 }} />}
        <NetIcon name={ICON[row.icon]} size={12} color={isCall ? titleColour : row.outcome && refusal ? TONE[row.outcome.tone] : 'var(--text-muted)'} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: titleColour, whiteSpace: 'nowrap' }}>{row.title}</span>
        {row.detail && (
          <span title={row.detail} style={{ fontFamily: isCall ? 'var(--font-mono)' : 'var(--font-ui)', fontSize: isCall ? 11.5 : 10.5, color: isCall ? 'var(--text-body)' : 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
            {row.detail}
          </span>
        )}
        {row.call?.redacted && (
          <span title="The PII filter redacted this URL's host when Layman recorded the call, so no flow can be joined to it; its traffic is under Unattributed. To keep IP addresses in glove sessions, turn on Settings → glove → Show IP addresses in sandboxed sessions (calls recorded from then on)."
            style={{ fontSize: 9.5, color: 'var(--warn)', border: '1px solid rgba(229,168,59,0.5)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>redacted</span>
        )}
        {row.call?.timing === 'approximate' && (
          <span title="Layman read this call after it ran and did not keep the transcript's own times, so its flows were joined by host alone."
            style={{ fontSize: 9.5, color: 'var(--warn)', border: '1px solid rgba(229,168,59,0.5)', borderRadius: 4, padding: '0 4px', flexShrink: 0 }}>≈ time</span>
        )}
      </div>
      <div role="cell" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: row.outcome ? TONE[row.outcome.tone] : undefined, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {row.outcome && <><NetIcon name={ICON[row.outcome.icon]} size={11} color={TONE[row.outcome.tone]} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.outcome.text}</span></>}
      </div>
      <div role="cell" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-muted)', textAlign: 'right', paddingRight: 10 }}>
        {row.bytes !== null ? formatBytes(row.bytes) : ''}
      </div>
      <div role="cell" style={{ position: 'relative', height: 12 }}>
        {row.bar && (
          <span style={{
            position: 'absolute', top: 2, height: 8, left: `${row.bar.x0 * axisWidthPct}%`, width: `${Math.max(0.6, (row.bar.x1 - row.bar.x0) * axisWidthPct)}%`,
            background: row.bar.refused ? BAR[row.outcome?.tone ?? 'warn'] : BAR[row.bar.tone], opacity: row.bar.refused ? 1 : 0.8, borderRadius: 2,
          }} />
        )}
      </div>
      <div role="cell" style={{ display: 'flex', justifyContent: 'center' }} onClick={(e) => e.stopPropagation()}>
        {row.kind === 'flow' && dest && flow && (
          <NetToggle kind={toggleFor(dest)} target={dest.host ?? 'this destination'} disabledReason={controlDisabledReason(data.rules)}
            onClick={(anchor) => onPolicy(flow, anchor)} />
        )}
      </div>
    </div>
  );
}

export function TraceWaterfall({ data }: { data: NetSessionData }) {
  const { view, selected, toggled, onlyTraffic, set } = useTrace();
  const now = useNow(1000);
  const [popover, setPopover] = useState<{ flow: FlowView; anchor: DOMRect } | null>(null);
  const sessionName = useSessionStore((s) => s.sessions.some((x) => x.sessionName === data.token));
  const axis = useMemo(() => (view ? traceAxis(view, now) : null), [view, now]);
  const rows = useMemo(() => (view && axis ? traceRows(view, axis, {
    toggled, onlyTraffic, rules: data.rules.enforced?.rules ?? data.rules.file?.rules ?? [], routeKind: data.gate.route.kind, now,
  }) : []), [view, axis, toggled, onlyTraffic, data.rules, data.gate.route.kind, now]);
  if (!view) return <EmptyState title="Loading the trace…" />;
  if (!view.turn) {
    return (
      <EmptyState title={view.sessionIds.length ? 'No turns in this glove session yet' : `No Layman session is named “${data.token}”`}>
        Trace joins glove’s flows to the transcript Layman records for the same sandbox: a session glove labels
        <span style={{ fontFamily: 'var(--font-mono)' }}> {data.token}</span>. {view.sessionIds.length || sessionName
          ? 'Its turns appear here once the agent is prompted.'
          : 'Start the harness in this glove session and it appears here; the Network, Map and Topology tabs work without it.'}
        {' '}If the agent ran before Layman started recording it, Settings → Data → Import session history brings its turns in.
      </EmptyState>
    );
  }
  const current = selected ?? defaultSelection(view);
  const toggle = (id: string) => {
    const next = new Set(toggled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ toggled: next });
  };
  const popRow = popover?.flow.destKey ? data.destinations.get(popover.flow.destKey) : null;
  const merged = withFlows(data, view);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div role="row" style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', height: 26, fontSize: 9.5, letterSpacing: '0.08em', fontWeight: 600, color: 'var(--text-faint)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <span style={{ paddingLeft: 10 }}>TOOL CALL → FLOWS</span>
        <span>OUTCOME</span>
        <span style={{ textAlign: 'right', paddingRight: 10 }}>BYTES</span>
        <span style={{ position: 'relative', height: 12 }}>
          {axis?.ticks.map((t) => (
            <span key={t} style={{ position: 'absolute', left: `${(t / axis.span) * 100}%`, fontFamily: 'var(--font-mono)', fontWeight: 400, letterSpacing: 0 }}>{tickLabel(t)}</span>
          ))}
        </span>
        <span />
      </div>
      <div role="table" aria-label="Tool calls and their flows" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {rows.map((r) => (
          <RowView key={r.id} row={r} data={merged} selected={current === r.id} axisWidthPct={100}
            onSelect={() => set({ selected: r.id })} onToggleRow={() => toggle(r.id)} onPolicy={(flow, anchor) => setPopover({ flow, anchor })} />
        ))}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '10px 12px', fontSize: 10.5, color: 'var(--text-faint)' }}>
          <NetIcon name="trace" size={11} color="var(--text-faint)" />
          Tool calls come from the {data.session?.harness ?? 'harness'} transcript and flows from the glove gate. Layman joins them by host and time; glove never links them.
        </div>
      </div>
      {popover && popRow && (
        <ControlPopover row={destinationRow(data, popRow, now)} data={data} anchor={popover.anchor} onClose={() => setPopover(null)} />
      )}
    </div>
  );
}

/** The trace's flows may be older than the ones the socket keeps: look them up in both. */
function withFlows(data: NetSessionData, view: TraceView): NetSessionData {
  if (view.flows.every((f) => data.flows.has(f.id))) return data;
  const flows = new Map(data.flows);
  for (const f of view.flows) if (!flows.has(f.id)) flows.set(f.id, f);
  return { ...data, flows };
}

// ─── Details ──────────────────────────────────────────────────────────────────

function whatHappened(f: FlowView, rules: NetSessionData['rules']): string {
  const host = f.dest.host ?? 'the destination';
  const note = (rules.enforced?.rules ?? rules.file?.rules ?? []).find((r) => r.id === f.rule)?.note;
  switch (f.state) {
    case 'guard':
      return f.dest.host === null
        ? 'The gate refused a request with no destination it could read, before anything went upstream.'
        : `The gate refused the connection before anything went upstream. ${host} is ${guardReason({ host: f.dest.host, rule: f.rule }) === 'cloud metadata' ? 'a cloud metadata address' : `an ${guardReason({ host: f.dest.host, rule: f.rule })}`}, which glove never lets a sandbox reach.`;
    case 'user_rule': return `Your rule${note ? ` “${note}”` : ''} blocked it at the gate; nothing went upstream.`;
    case 'default_block': return 'No rule allowed it, and the default is to block; nothing went upstream.';
    case 'broken': return `The gate allowed it, but ${f.closeReason === 'timeout' ? 'the upstream timed out' : 'the upstream could not be reached'}. The path is broken; this is not a policy decision.`;
    case 'gate_shutdown': return 'It was allowed, then cut mid-transfer when the gate shut down.';
    case 'gate_lost': return 'It was allowed, then cut when the gate that carried it went away (inferred: no close was recorded).';
    case 'active': case 'pooled': return 'Allowed, and still open.';
    default: return `Allowed, and closed normally (${f.closeReason ?? 'closed'}).`;
  }
}

function CanIAllow({ data, flow }: { data: NetSessionData; flow: FlowView }) {
  const dest = flow.destKey ? data.destinations.get(flow.destKey) : undefined;
  const disabled = controlDisabledReason(data.rules);
  const apply = (op: RulesOp) => useNetStore.getState().applyRules(op);
  const rules = data.rules.enforced?.rules ?? data.rules.file?.rules ?? [];
  const host = flow.dest.host;
  const v = dest?.policy.enforced ?? null;
  let text: string;
  let action: React.ReactNode = null;
  if (flow.state === 'guard' || !host) {
    text = 'No. The guard runs before your rules, and rules.json cannot allow it. The toggle is locked for that reason.';
  } else if (v?.action === 'block' && v.rule) {
    text = 'Yes: this is your own rule. Removing it lets the next request through.';
    action = <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'removeRule', ids: siblingIds(v.rule!, rules) })} style={buttonStyle('ok')}>Unblock</button>;
  } else if (v?.action === 'block') {
    text = 'Yes: nothing allows it, and an allow rule would.';
    action = <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'allowHost', host })} style={buttonStyle('ok')}>Allow {host}</button>;
  } else {
    text = 'It is allowed. You can block it from here or from its toggle.';
    action = <button type="button" disabled={!!disabled} onClick={() => apply({ kind: 'blockHost', host, terminate: false })} style={buttonStyle('danger')}><NetIcon name="blocked" color="#FF8A80" />Block {host}</button>;
  }
  return (
    <>
      <SectionHead>Can I allow it?</SectionHead>
      <div style={{ display: 'flex', gap: 7, fontSize: 11.5, color: 'var(--text-body)', lineHeight: 1.5 }}>
        {(flow.state === 'guard' || !host) && <NetIcon name="lock" size={12} color="var(--warn)" />}<span>{text}</span>
      </div>
      {action && <div style={{ marginTop: 8 }} title={disabled ?? undefined}>{action}</div>}
    </>
  );
}

function TurnButtons({ view, label }: { view: TraceView; label: string }) {
  const selectTurn = useSessionStore((s) => s.selectTurn);
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const t = view.turn!;
  const href = buildPath({ kind: 'turn', sessionId: t.sessionId, promptEventId: t.promptEventId });
  const bookmark = async () => {
    setSaved('saving');
    try {
      const r = await fetch('/api/highlights', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: t.sessionId, promptEventId: t.promptEventId, responseEventId: t.responseEventId, name: `glove ${view.token}: ${label}`.slice(0, 120) }),
      });
      setSaved(r.ok ? 'saved' : 'failed');
    } catch {
      setSaved('failed');
    }
  };
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
      <a href={href} onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); selectTurn(t.sessionId, t.promptEventId); } }}
        style={{ ...buttonStyle('plain'), textDecoration: 'none' }}>Open turn</a>
      <button type="button" disabled={!t.responseEventId || saved === 'saving' || saved === 'saved'} onClick={bookmark} style={buttonStyle('ghost')}
        title={t.responseEventId ? 'Save this turn as a highlight' : 'The turn has no response yet'}>
        {saved === 'saved' ? 'Bookmarked' : saved === 'failed' ? 'Bookmark failed: try again' : 'Bookmark'}
      </button>
    </div>
  );
}

export function TraceDetails({ data }: { data: NetSessionData }) {
  const { view, selected } = useTrace();
  if (!view?.turn) return <div style={{ padding: 14, fontSize: 11.5, color: 'var(--text-muted)' }}>Details of the selected call or flow appear here.</div>;
  const id = selected ?? defaultSelection(view);
  const flows = new Map(view.flows.map((f) => [f.id, f]));
  if (!id) {
    return <div style={{ padding: 14, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>Select a tool call or a flow to see what the agent asked for, what the gate did with it, and whether you can change that.</div>;
  }
  if (id.startsWith('call:')) {
    const item = view.items.find((i) => i.kind === 'call' && i.call.eventId === id.slice(5));
    if (!item || item.kind !== 'call') return null;
    const c = item.call;
    return (
      <div style={{ padding: 12 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{c.toolName}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-body)', wordBreak: 'break-all', marginTop: 4 }}>{c.label}</div>
        <SectionHead>Call</SectionHead>
        <Row k={c.timing === 'exact' ? 'Started' : 'Read'} v={clockTime(c.start)} sub={c.timing === 'exact' ? 'from the transcript' : 'when Layman read it; its own times were not kept'} />
        {c.end !== null && c.timing === 'exact' && <Row k="Ended" v={`${clockTime(c.end)} · ${((c.end - c.start) / 1000).toFixed(1)} s`} />}
        <Row k="Flows" v={`${item.flowIds.length + item.fanoutIds.length}`} sub={item.fanoutIds.length ? `${item.fanoutIds.length} by SearXNG’s fan-out` : undefined} />
        <Row k="Joined" v={c.redacted ? 'not joined' : c.timing === 'exact' ? 'host and time' : 'host only'} mono={false}
          sub={c.redacted ? 'the PII filter redacted the host when the call was recorded; Settings → glove → Show IP addresses keeps IPs in glove sessions' : c.timing === 'exact' ? 'opened between start − 1 s and end + 2 s' : 'opened after the turn began, before Layman read the call'} />
        {c.failed && <Row k="Result" v="failed" colour="#FF8A80" />}
        <TurnButtons view={view} label={c.label} />
      </div>
    );
  }
  const fid = id.replace(/^(flow|llm):/, '');
  const f = flows.get(fid) ?? data.flows.get(fid);
  if (!f) return <div style={{ padding: 14, fontSize: 11.5, color: 'var(--text-muted)' }}>Select a tool call or a flow.</div>;
  const info = NET_STATE_INFO[f.state];
  const call = callForFlow(view, f.id);
  const host = f.dest.host ?? `${f.service} endpoint`;
  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <NetIcon name={info.icon as NetIconName} size={15} color={info.colourVar} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: info.colourVar }}>{info.label}</div>
          {f.rule && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-faint)' }}>{f.rule}</div>}
        </div>
      </div>
      <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-strong)', background: 'var(--bg)' }}>
        {call ? (
          <>
            <div style={{ fontSize: 10.5, color: 'var(--info)' }}>The agent asked for · {clockTime(call.start)}{call.timing === 'approximate' ? ' (read time)' : ''}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text)', wordBreak: 'break-all', marginTop: 2 }}>{call.kind === 'search' ? `${call.toolName} “${call.label}”` : call.label}</div>
          </>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {f.service === 'llm' || f.tool === 'llm' ? 'A request to the model, between tool calls.' : 'No tool call in this turn names this host. Layman does not guess which one made it.'}
          </div>
        )}
      </div>
      <SectionHead>What happened</SectionHead>
      <div style={{ fontSize: 11.5, color: 'var(--text-body)', lineHeight: 1.5 }}>{whatHappened(f, data.rules)}</div>
      <CanIAllow data={data} flow={f} />
      <SectionHead>Connection</SectionHead>
      <Row k="Host" v={host} sub={f.dest.ip ? `${f.dest.ip} · ${f.dest.resolution}` : f.dest.resolution === 'literal' ? 'IP literal, not resolved' : f.dest.resolution === 'unavailable' ? 'unresolved' : undefined} />
      <Row k="Port" v={`${f.dest.port ?? '—'}${f.proto ? ` · ${f.proto}` : ''}`} />
      <Row k="Scope" v={f.flags.scope === 'local' ? 'local' : f.flags.scope} sub={BLOCK_NEVER_LEFT.has(f.state) ? 'never left the gate' : undefined} />
      <Row k="Bytes" v={`${formatBytes(f.bytes.up)} sent · ${formatBytes(f.bytes.down)} ${BLOCK_NEVER_LEFT.has(f.state) ? 'refusal' : 'received'}`} />
      <Row k={f.phase === 'close' ? 'Closed' : 'Open'} v={f.phase === 'close' ? f.closeReason ?? 'closed' : 'still open'} />
      <Row k="Flow" v={f.id} />
      <TurnButtons view={view} label={`${info.label.toLowerCase()} · ${host}`} />
    </div>
  );
}

const BLOCK_NEVER_LEFT = new Set(['guard', 'user_rule', 'default_block']);

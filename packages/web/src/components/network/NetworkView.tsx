/**
 * The shell shared by the Network, Map, Topology and Trace tabs: which glove
 * session they show, the subscription that feeds them, the gate strip, the
 * rejected-rules banner, empty states, and the Panels board.
 *
 * Lazy-loaded from App.tsx (as FlowchartView is), so a user who never opens the
 * tabs never downloads them.
 */
import React, { useEffect, useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore.js';
import { useNetStore } from '../../stores/netStore.js';
import { useNetPanels } from '../../hooks/useNetPanels.js';
import { defaultNetToken } from '../../lib/net-state.js';
import { columnPanels, type PanelDef } from '../../lib/net-panels.js';
import type { ClientMessage } from '../../lib/ws-protocol.js';
import { GateStrip, RulesRejectedBanner } from './GateStrip.js';
import { EmptyState, PanelFrame } from './netui.js';
import { TAB_PANELS, type NetTab } from './tabs.js';

/**
 * What each panel will hold, shown until it is built. The Network tab's panels
 * arrive first, then control, the map, topology and the trace.
 */
const PANEL_PURPOSE: Record<string, string> = {
  'network/table': 'Every destination this session reached, grouped by registrable domain, with live activity, bytes, state and a block/allow toggle.',
  'network/activity': 'Bytes sent and received over time.',
  'network/map': 'Where this session’s traffic went, from its apparent origin. Opens the Map tab.',
  'network/rules': 'The rules glove enforces, in evaluation order, and whether the last change took effect.',
  'network/details': 'The selected destination: totals, policy, what the agent asked for, and the connection.',
  'map/world': 'A world map of destinations, with the tunnel exit as the origin of every route.',
  'map/ribbon': 'The last 60 seconds, one lane per flow, with the agent’s tool calls marked.',
  'map/talking': 'Flows open right now, with their live rates.',
  'map/detail': 'The selected destination: totals, what the agent asked for, and the connection.',
  'map/unknown': 'Destinations glove could not resolve inside the tunnel. Layman never looks them up.',
  'map/legend': 'How each route and state is drawn.',
  'topology/routes': 'The route from the sandbox through glove’s services, the policy wall and the tunnel to each destination.',
  'topology/path': 'Every hop of the selected path, and whether each is declared or verified.',
  'trace/trace': 'One turn at a time: each tool call the agent made and the connections it produced.',
  'trace/details': 'The selected call or connection, and what the gate did with it.',
};

function Board({ tab, panels }: { tab: NetTab; panels: ReturnType<typeof useNetPanels> }) {
  const defs = TAB_PANELS[tab];
  const { drag } = panels;
  const render = (p: PanelDef) => (
    <PanelFrame
      key={p.id}
      title={p.title}
      onHide={() => panels.toggle(p.id)}
      dropTarget={drag.dragId !== null && drag.dragOverId === p.id && drag.dragId !== p.id}
      drag={{
        onDragStart: () => drag.handleDragStart(p.id),
        onDragOver: () => drag.handleDragOver(p.id),
        onDragEnd: drag.handleDragEnd,
      }}
    >
      <EmptyState title="Not built yet">{PANEL_PURPOSE[`${tab}/${p.id}`]}</EmptyState>
    </PanelFrame>
  );
  const main = columnPanels(defs, panels.state, 'main');
  const side = columnPanels(defs, panels.state, 'side');
  if (!main.length && !side.length) {
    return <EmptyState title="Every panel is hidden">Turn panels back on with the Panels chips above.</EmptyState>;
  }
  return (
    <div style={{ display: 'flex', gap: 8, padding: 8, flex: 1, minHeight: 0 }}>
      {main.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0, minHeight: 0 }}>{main.map(render)}</div>
      )}
      {side.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: main.length ? 'clamp(300px, 26vw, 380px)' : undefined, flex: main.length ? undefined : 1, minWidth: 0, minHeight: 0 }}>
          {side.map(render)}
        </div>
      )}
    </div>
  );
}

export default function NetworkView({ tab, onSend }: { tab: NetTab; onSend: (msg: ClientMessage) => void }) {
  const config = useSessionStore((s) => s.config);
  const wsStatus = useSessionStore((s) => s.wsStatus);
  const netToken = useSessionStore((s) => s.netToken);
  const setNetToken = useSessionStore((s) => s.setNetToken);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);
  const activeSessionName = useSessionStore((s) =>
    s.sessions.find((x) => x.sessionId === s.activeSessionId)?.sessionName ?? null);
  const { sessions, sessionsKnown, data, setSubscribed } = useNetStore();
  const panels = useNetPanels(tab, TAB_PANELS[tab]);

  const enabled = !!config?.glove.enabled && config.glove.network?.enabled !== false;
  const token = netToken ?? defaultNetToken(sessions, activeSessionName);
  const listed = token !== null && sessions.some((s) => s.token === token);

  // Make the default explicit, so the address bar names the session shown.
  useEffect(() => {
    if (netToken === null && token !== null) setNetToken(token);
  }, [netToken, token, setNetToken]);

  // One subscription per socket. Re-sent after a reconnect (the server forgets
  // subscriptions with the socket), and dropped when the tabs close so a
  // dashboard that is not looking stops receiving deltas.
  const subscribeTo = listed ? token : null;
  useEffect(() => {
    if (wsStatus !== 'connected') return;
    setSubscribed(subscribeTo);
    onSend({ type: 'net:subscribe', token: subscribeTo });
  }, [wsStatus, subscribeTo, onSend, setSubscribed]);
  useEffect(() => () => {
    onSend({ type: 'net:subscribe', token: null });
    useNetStore.getState().setSubscribed(null);
  }, [onSend]);

  const body = useMemo(() => {
    if (!enabled) {
      return (
        <EmptyState
          title="Network views need glove"
          action={<button type="button" onClick={() => setSettingsOpen(true)} style={{ fontSize: 11.5, padding: '5px 12px', borderRadius: 6, background: 'var(--bg-pill)', border: '1px solid var(--border-strong)', color: 'var(--text)', cursor: 'pointer' }}>Open Settings</button>}
        >
          These tabs show the network traffic of glove-sandboxed sessions. Enable glove (and its network views) in Settings.
        </EmptyState>
      );
    }
    if (!sessionsKnown) return <EmptyState title="Connecting…" />;
    if (sessions.length === 0) {
      return (
        <EmptyState title="No glove network data">
          No glove session under <span style={{ fontFamily: 'var(--font-mono)' }}>{config?.glove.sessionsDir}</span> has
          a <span style={{ fontFamily: 'var(--font-mono)' }}>net/</span> directory yet. glove writes one for sessions run
          with network observation on.
        </EmptyState>
      );
    }
    if (!listed) {
      return (
        <EmptyState title={`No glove session “${token}” on this instance`}>
          Choose one of the {sessions.length} glove session{sessions.length === 1 ? '' : 's'} with network data from the picker above.
        </EmptyState>
      );
    }
    if (!data || data.token !== token) return <EmptyState title={`Loading ${token}…`} />;
    return <Board tab={tab} panels={panels} />;
  }, [enabled, sessionsKnown, sessions.length, listed, token, data, tab, panels, config?.glove.sessionsDir, setSettingsOpen]);

  const shown = data && data.token === token ? data : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--bg)' }}>
      <GateStrip
        sessions={sessions}
        token={token}
        onPick={setNetToken}
        data={shown}
        panels={TAB_PANELS[tab]}
        isVisible={panels.isVisible}
        onToggle={panels.toggle}
      />
      {shown && <RulesRejectedBanner data={shown} />}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>{body}</div>
    </div>
  );
}

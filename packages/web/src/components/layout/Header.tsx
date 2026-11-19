import React, { useEffect, useMemo } from 'react';
import { useSessionStore, isExclusiveView, isNetworkView, type ViewMode } from '../../stores/sessionStore.js';
import { useNetStore } from '../../stores/netStore.js';
import { networkTabSignal, type NetTabSignal } from '../../lib/net-state.js';
import { headerTabs, currentTabIndex, neighbourTab, type HeaderTab } from '../../lib/header-tabs.js';
import { arrowKeysFree } from '../../lib/arrow-keys.js';
import { TabScroller } from './TabScroller.js';
import { sessionDisplayName } from '../../lib/session-state.js';
import { awaitingGloves, GLOVE_OPTION_PREFIX } from '../../lib/session-selection.js';
import { tokenColor } from '../../lib/tokens.js';
import { sp, rad } from '../../lib/density.js';

function getSessionName(cwd: string, sessionId: string, agentType?: string, showAgentPrefix?: boolean, sessionName?: string): string {
  const name = sessionDisplayName(sessionName, cwd, sessionId);
  if (showAgentPrefix && agentType) {
    const prefix = agentType === 'claude-code' ? '[CC]' : agentType === 'codex' ? '[CX]' : agentType === 'opencode' ? '[OC]' : agentType === 'cline' ? '[CL]' : agentType === 'pi' ? '[PI]' : `[${agentType.slice(0, 2).toUpperCase()}]`;
    return `${prefix} ${name}`;
  }
  return name;
}

const GROUP_LABEL: Record<HeaderTab['group'], string | undefined> = {
  live: undefined, network: 'Network', matrix: 'Matrix', gibson: 'Gibson', archive: undefined,
};

const SIGNAL_DOT: Record<Exclude<NetTabSignal, null>, { color: string; title: string }> = {
  alert: { color: 'var(--error)', title: 'A running glove session has rejected rules or untunnelled traffic' },
  live: { color: 'var(--net-tunnel)', title: 'A glove gate is running' },
};

function NavTabButton({ label, shortcut, isActive, onClick, signal }: { label: string; shortcut?: string; isActive: boolean; onClick: () => void; signal?: NetTabSignal }) {
  return (
    <button
      data-tab-active={isActive}
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: sp('0 14px'),
        fontSize: 12,
        fontWeight: isActive ? 600 : 400,
        fontFamily: 'var(--font-ui)',
        color: isActive ? 'var(--text)' : 'var(--text-muted)',
        background: isActive ? 'var(--bg-selected)' : 'transparent',
        border: 'none',
        borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
        cursor: 'pointer',
        transition: 'color 0.15s, background 0.15s',
        userSelect: 'none',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
      }}
    >
      {label}
      {signal && (
        <span
          title={SIGNAL_DOT[signal].title}
          aria-label={SIGNAL_DOT[signal].title}
          style={{ marginLeft: sp(6), width: 6, height: 6, borderRadius: rad(3), background: SIGNAL_DOT[signal].color, flexShrink: 0 }}
        />
      )}
    </button>
  );
}

export function Header() {
  const {
    wsStatus, setSettingsOpen, bookmarksOpen,
    sessions, activeSessionId, setActiveSession, awaitingGlove, pickGlove,
    viewMode, setViewMode,
    dashboardFocusedSession, setDashboardFocusedSession,
    returnToDashboard, returnFromDashboardDrilldown,
    sessionMetrics,
    investigatedSessions,
    promptsOpen,
    panelLayout,
    toggleDashboardVisible,
    toggleLogsVisible,
    activateOnlyLiveTab,
    config,
  } = useSessionStore();

  // The Network group appears only with glove on and at least one glove session
  // with network data; otherwise the header is exactly what it was without it.
  const netSessions = useNetStore((s) => s.sessions);
  const showNetwork = !!config?.glove.enabled && config.glove.network?.enabled !== false && netSessions.length > 0;
  const tabs = useMemo(() => headerTabs({ showNetwork, config }), [showNetwork, config]);
  const groups = tabs.reduce<{ group: HeaderTab['group']; tabs: HeaderTab[] }[]>((acc, t) => {
    const last = acc[acc.length - 1];
    if (last?.group === t.group) last.tabs.push(t);
    else acc.push({ group: t.group, tabs: [t] });
    return acc;
  }, []);
  const netSignal = networkTabSignal(netSessions);
  // Glove sessions with no prompt yet: glove knows them before Layman has a session to list.
  const gloveOptions = useMemo(
    () => (config?.glove.enabled ? awaitingGloves(netSessions, sessions, awaitingGlove) : []),
    [config?.glove.enabled, netSessions, sessions, awaitingGlove],
  );

  // Dashboard/Logs are only meaningfully "active" while the live (non-exclusive)
  // view is showing — Flow/Sessions/Prompts take over the whole content area, and
  // panelLayout otherwise keeps its last-computed value since the layout hook that
  // updates it unmounts along with the panels themselves.
  const inLiveMode = !isExclusiveView(viewMode);

  // Clicking Dashboard/Logs (or D/S) while already in live mode toggles that
  // panel's visibility independently; arriving from Flow/Sessions/Prompts shows
  // only the clicked tab, closing whatever exclusive view was active.
  const activateLiveTab = (tab: 'dashboard' | 'stream') => {
    if (!inLiveMode) {
      setViewMode(tab);
      activateOnlyLiveTab(tab);
    } else if (tab === 'dashboard') {
      toggleDashboardVisible();
    } else {
      toggleLogsVisible();
    }
  };

  const isTabActive = (key: HeaderTab['key']) =>
    key === 'dashboard' ? inLiveMode && panelLayout.showDashboard
      : key === 'stream' ? inLiveMode && panelLayout.showLogs
        : viewMode === key;
  const activeKey = tabs.filter((t) => isTabActive(t.key)).map((t) => t.key).join(',');

  // ←/→ always show only the tab arrived at, never toggle a panel.
  const goToTab = (key: HeaderTab['key']) => {
    setViewMode(key);
    if (key === 'dashboard' || key === 'stream') activateOnlyLiveTab(key);
  };
  const activateTab = (key: HeaderTab['key']) => {
    if (key === 'dashboard' || key === 'stream') activateLiveTab(key);
    else setViewMode(key);
  };

  const hasTab = (key: HeaderTab['key']) => tabs.some((t) => t.key === key);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && arrowKeysFree(e)) {
        const next = neighbourTab(tabs, currentTabIndex(tabs, viewMode, panelLayout, inLiveMode), e.key === 'ArrowLeft' ? -1 : 1);
        if (next) {
          e.preventDefault();
          goToTab(next.key);
        }
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case 'd': activateLiveTab('dashboard'); break;
        case 's': activateLiveTab('stream'); break;
        case 'f': setViewMode('flowchart'); break;
        case 'a': setViewMode('activity'); break;
        case 'x': if (hasTab('matrix2d')) setViewMode('matrix2d'); break;
        case 'g': if (hasTab('gibson2d')) setViewMode('gibson2d'); break;
        case 'n': if (hasTab('network')) setViewMode('network'); break;
        case 'm': if (hasTab('map')) setViewMode('map'); break;
        case 'o': if (hasTab('topology')) setViewMode('topology'); break;
        case 't': if (hasTab('trace')) setViewMode('trace'); break;
        case 'escape':
          if (returnToDashboard) {
            returnFromDashboardDrilldown();
          } else if (bookmarksOpen || promptsOpen) {
            setViewMode('stream');
          }
          break;
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setViewMode, bookmarksOpen, promptsOpen, returnToDashboard, returnFromDashboardDrilldown, inLiveMode, toggleDashboardVisible, toggleLogsVisible, activateOnlyLiveTab, tabs, viewMode, panelLayout]);

  // Session picker only makes sense once Logs (a single-session view) is showing.
  // The network tabs have their own glove session picker in the gate strip, and
  // this one filters Logs, not network data — two side by side would mislead.
  const hideSessionPicker = (inLiveMode && !panelLayout.showLogs) || isNetworkView(viewMode);

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 0,
        padding: sp('0 16px'),
        height: 40,
        background: 'var(--bg-raised)',
        borderBottom: 'var(--stroke) solid var(--border)',
        flexShrink: 0,
        fontFamily: 'var(--font-ui)',
      }}
    >
      {/* Wordmark */}
      <a
        href="https://github.com/castellotti/layman"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontFamily: 'var(--font-ui)',
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: '0.08em',
          color: 'var(--text)',
          textDecoration: 'none',
          marginRight: sp(20),
          flexShrink: 0,
          userSelect: 'none',
        }}
        title="View on GitHub"
      >
        LAYMAN
      </a>

      {/* The tab strip scrolls sideways on its own; the session picker and Settings stay put on the
          right. Groups come from headerTabs(), the same list the arrow keys walk. Dashboard and Logs
          both read as active when both are visible; clicking either toggles it, and clicking from
          Flow/Sessions/Prompts closes that exclusive view and shows only the clicked tab. */}
      <TabScroller activeKey={activeKey} tabCount={tabs.length}>
        {groups.map((g, i) => (
          <React.Fragment key={g.group}>
            {i > 0 && <div style={{ alignSelf: 'center', flexShrink: 0, width: 1, height: 16, background: 'var(--border-strong)', margin: sp('0 12px') }} />}
            <nav aria-label={GROUP_LABEL[g.group]} style={{ display: 'flex', alignItems: 'stretch', height: '100%', gap: 0 }}>
              {g.tabs.map((t) => (
                <NavTabButton
                  key={t.key}
                  label={t.label}
                  shortcut={t.shortcut}
                  isActive={isTabActive(t.key)}
                  onClick={() => activateTab(t.key)}
                  signal={t.key === 'network' ? netSignal : undefined}
                />
              ))}
            </nav>
          </React.Fragment>
        ))}
      </TabScroller>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Disconnected badge */}
      {wsStatus === 'disconnected' && (
        <span style={{
          fontSize: 10,
          color: 'var(--warn)',
          background: tokenColor('warn', '12%'),
          border: `var(--stroke) solid ${tokenColor('warn', '30%')}`,
          padding: sp('2px 8px'),
          borderRadius: rad(10),
          marginRight: sp(12),
          fontFamily: 'var(--font-ui)',
        }}>
          Auto-reconnecting…
        </span>
      )}

      {/* Session picker — hidden on Dashboard (all-sessions view) and the network tabs */}
      {!hideSessionPicker && sessions.length + gloveOptions.length > 0 && (
        <div style={{ marginRight: sp(12) }}>
          {(() => {
            const agentTypes = new Set(sessions.map((s) => s.agentType));
            const showAgentPrefix = agentTypes.size > 1;
            const value = activeSessionId ?? (awaitingGlove ? GLOVE_OPTION_PREFIX + awaitingGlove : '');
            return (
              <select
                value={value}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.startsWith(GLOVE_OPTION_PREFIX)) pickGlove(v.slice(GLOVE_OPTION_PREFIX.length));
                  else setActiveSession(v || null);
                }}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  background: 'var(--bg-card)',
                  border: 'var(--stroke) solid var(--border-strong)',
                  color: 'var(--text)',
                  borderRadius: rad(5),
                  padding: sp('3px 8px'),
                  cursor: 'pointer',
                  outline: 'none',
                  maxWidth: 200,
                }}
                title="Filter by session"
              >
                {sessions.length + gloveOptions.length > 1 && (
                  <option value="">All sessions</option>
                )}
                {sessions.map((s) => {
                  const effectiveName = s.sessionName || sessionMetrics.get(s.sessionId)?.sessionName;
                  const investigated = investigatedSessions.has(s.sessionId);
                  return (
                    <option key={s.sessionId} value={s.sessionId}>
                      {investigated ? '⊙ ' : ''}{s.remote && s.hostName ? `${s.hostName} · ` : ''}{getSessionName(s.cwd, s.sessionId, s.agentType, showAgentPrefix, effectiveName)}{s.cwd ? ` · ${s.sessionId.slice(0, 6)}` : ''}
                    </option>
                  );
                })}
                {gloveOptions.map((token) => (
                  <option key={token} value={GLOVE_OPTION_PREFIX + token}>{token} · waiting for first prompt</option>
                ))}
              </select>
            );
          })()}
        </div>
      )}

      {/* Settings — always opens the drawer (floating panel only, not docked). */}
      <button
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: sp(5),
          padding: sp('5px 10px'),
          fontSize: 11,
          fontFamily: 'var(--font-ui)',
          color: 'var(--text-muted)',
          background: 'transparent',
          border: 'var(--stroke) solid var(--border-strong)',
          borderRadius: rad(5),
          cursor: 'pointer',
          transition: 'color 0.15s, border-color 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--text-faint)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)';
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)';
        }}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.436-.272.667-.386.133-.066.194-.158.211-.224l.29-1.106C5.717.645 6.263.095 7.006.031 7.24.01 7.62 0 8 0Zm1.5 8a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z"/>
        </svg>
        <span>Settings</span>
      </button>
    </header>
  );
}

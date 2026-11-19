/**
 * The one tab order: the Header renders it and ←/→ walk it, so the two cannot disagree.
 * Pure (no store, no DOM).
 */
import type { ViewMode } from '../stores/sessionStore.js';
import type { LaymanConfig } from './types.js';
import { NET_TABS } from '../components/network/tabs.js';
import { netTabVisible, styxTabVisible, type StyxTabKey } from './tab-visibility.js';

export interface HeaderTab {
  key: ViewMode | 'dashboard' | 'stream';
  label: string;
  shortcut?: string;
  group: 'live' | 'network' | 'matrix' | 'gibson' | 'archive';
}

export function headerTabs(opts: { showNetwork: boolean; config: LaymanConfig | null }): HeaderTab[] {
  const tabs: HeaderTab[] = [
    { key: 'dashboard', label: 'Dashboard', shortcut: 'D', group: 'live' },
    { key: 'stream', label: 'Logs', shortcut: 'S', group: 'live' },
    { key: 'flowchart', label: 'Flow', shortcut: 'F', group: 'live' },
    { key: 'activity', label: 'Activity', shortcut: 'A', group: 'live' },
  ];
  if (opts.showNetwork) {
    for (const t of NET_TABS) if (netTabVisible(opts.config, t.key)) tabs.push({ key: t.key, label: t.label, shortcut: t.shortcut, group: 'network' });
  }
  const styx: HeaderTab[] = [
    { key: 'matrix', label: 'Matrix', group: 'matrix' },
    { key: 'matrix2d', label: 'Matrix 2D', shortcut: 'X', group: 'matrix' },
    { key: 'matrix3d', label: 'Matrix 3D', group: 'matrix' },
    { key: 'gibson', label: 'Gibson', group: 'gibson' },
    { key: 'gibson2d', label: 'Gibson 2D', shortcut: 'G', group: 'gibson' },
    { key: 'gibson3d', label: 'Gibson 3D', group: 'gibson' },
  ];
  for (const t of styx) if (styxTabVisible(opts.config, t.key as StyxTabKey)) tabs.push(t);
  tabs.push(
    { key: 'sessions', label: 'Sessions', group: 'archive' },
    { key: 'prompts', label: 'Prompts', group: 'archive' },
  );
  return tabs;
}

/**
 * Where ←/→ start from. In live mode (Dashboard/Logs) both-visible means ← leaves from Dashboard
 * and → from Logs; otherwise the one shown. Outside live mode it is the tab of `viewMode`; a tab
 * not in the list (a hidden one reached by link) gives -1 on both sides.
 */
export function currentTabIndex(
  tabs: readonly HeaderTab[],
  viewMode: ViewMode,
  panelLayout: { showDashboard: boolean; showLogs: boolean },
  inLiveMode: boolean,
): { left: number; right: number } {
  const at = (k: string) => tabs.findIndex((t) => t.key === k);
  if (inLiveMode) {
    const d = at('dashboard');
    const l = at('stream');
    if (panelLayout.showDashboard && panelLayout.showLogs) return { left: d, right: l };
    const one = panelLayout.showLogs ? l : d;
    return { left: one, right: one };
  }
  const i = at(viewMode);
  return { left: i, right: i };
}

/** The tab ← or → goes to, or null at an end (no wrap-around). An unlisted current tab: ← last, → first. */
export function neighbourTab(tabs: readonly HeaderTab[], idx: { left: number; right: number }, dir: -1 | 1): HeaderTab | null {
  if (tabs.length === 0) return null;
  if (dir < 0) return idx.left < 0 ? tabs[tabs.length - 1] : tabs[idx.left - 1] ?? null;
  return idx.right < 0 ? tabs[0] : tabs[idx.right + 1] ?? null;
}

import { useCallback, useEffect, useState } from 'react';
import { useDragReorder } from './useDragReorder.js';
import {
  isPanelVisible, movePanel, panelStorageKey, resolvePanels, togglePanel,
  type PanelDef, type PanelState,
} from '../lib/net-panels.js';

function load(tab: string, defs: readonly PanelDef[]): PanelState {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(panelStorageKey(tab));
    return resolvePanels(defs, raw ? JSON.parse(raw) : null);
  } catch {
    return resolvePanels(defs, null);
  }
}

/**
 * One network tab's panels: visibility (the Panels chips) and order (drag the
 * header grip), persisted per tab. Reuses `useDragReorder` for the drag.
 */
export function useNetPanels(tab: string, defs: readonly PanelDef[]) {
  const [state, setState] = useState<PanelState>(() => load(tab, defs));

  useEffect(() => {
    try {
      localStorage.setItem(panelStorageKey(tab), JSON.stringify(state));
    } catch {
      // Storage may be unavailable (private browsing quota, etc.) — non-fatal.
    }
  }, [tab, state]);

  const toggle = useCallback((id: string) => setState((s) => togglePanel(defs, s, id)), [defs]);
  const isVisible = useCallback((id: string) => isPanelVisible(defs, state, id), [defs, state]);
  const onReorder = useCallback((from: string, to: string) => setState((s) => movePanel(s, from, to)), []);
  const drag = useDragReorder(onReorder);

  return { state, toggle, isVisible, drag };
}

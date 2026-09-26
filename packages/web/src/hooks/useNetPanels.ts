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
  // The state remembers which tab it belongs to. NetworkView is not remounted
  // when the tab changes, and state held across a switch used to be shown for
  // the new tab (its panel ids all unknown there: "Every panel is hidden") and
  // then saved under the new tab's key.
  const [held, setHeld] = useState<{ tab: string; state: PanelState }>(() => ({ tab, state: load(tab, defs) }));
  let current = held;
  if (held.tab !== tab) {
    current = { tab, state: load(tab, defs) };
    setHeld(current); // derived-state update during render: React re-renders before committing
  }
  const { state } = current;

  useEffect(() => {
    try {
      localStorage.setItem(panelStorageKey(held.tab), JSON.stringify(held.state));
    } catch {
      // Storage may be unavailable (private browsing quota, etc.) — non-fatal.
    }
  }, [held]);

  const setState = useCallback((fn: (s: PanelState) => PanelState) => setHeld((h) => ({ tab: h.tab, state: fn(h.state) })), []);
  const toggle = useCallback((id: string) => setState((s) => togglePanel(defs, s, id)), [defs, setState]);
  const isVisible = useCallback((id: string) => isPanelVisible(defs, state, id), [defs, state]);
  const onReorder = useCallback((from: string, to: string) => setState((s) => movePanel(s, from, to)), [setState]);
  const drag = useDragReorder(onReorder);

  return { state, toggle, isVisible, drag };
}

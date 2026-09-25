/**
 * The Panels mechanism shared by the four network tabs: which panels a tab
 * shows and in what order, persisted per tab in localStorage. A per-viewer
 * convenience — losing it is harmless — so reads are tolerant: unknown ids are
 * dropped, new panels appear in their default place, and garbage is ignored.
 */
export interface PanelDef {
  id: string;
  /** Panel header (uppercased), e.g. "Destinations". */
  title: string;
  /** The Panels chip in the gate strip, e.g. "Table" — the mockups name them differently. */
  chip: string;
  /** Icon name for the chip (see components/network/netui.tsx). */
  icon: string;
  defaultVisible: boolean;
  /** Which column the panel sits in; order within a column follows the saved order. */
  column: 'main' | 'side';
}

export interface PanelState {
  order: string[];
  /** Only panels the viewer toggled away from their default. */
  visible: Record<string, boolean>;
}

export const panelStorageKey = (tab: string) => `layman.net.panels.${tab}`;

export function resolvePanels(defs: readonly PanelDef[], saved: unknown): PanelState {
  const ids = defs.map((d) => d.id);
  const s = (saved && typeof saved === 'object' ? saved : {}) as Partial<PanelState>;
  const savedOrder = Array.isArray(s.order) ? s.order.filter((id): id is string => typeof id === 'string' && ids.includes(id)) : [];
  const order = [...new Set(savedOrder)];
  // A panel added since the order was saved goes after the panel it follows by default.
  for (const [i, id] of ids.entries()) {
    if (order.includes(id)) continue;
    const prev = ids.slice(0, i).reverse().find((p) => order.includes(p));
    order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, id);
  }
  const visible: Record<string, boolean> = {};
  if (s.visible && typeof s.visible === 'object') {
    for (const [id, v] of Object.entries(s.visible)) if (ids.includes(id) && typeof v === 'boolean') visible[id] = v;
  }
  return { order, visible };
}

export function isPanelVisible(defs: readonly PanelDef[], state: PanelState, id: string): boolean {
  return state.visible[id] ?? defs.find((d) => d.id === id)?.defaultVisible ?? false;
}

export function togglePanel(defs: readonly PanelDef[], state: PanelState, id: string): PanelState {
  return { ...state, visible: { ...state.visible, [id]: !isPanelVisible(defs, state, id) } };
}

/** Move `fromId` to where `toId` is (drag and drop). */
export function movePanel(state: PanelState, fromId: string, toId: string): PanelState {
  const from = state.order.indexOf(fromId);
  const to = state.order.indexOf(toId);
  if (from === -1 || to === -1 || from === to) return state;
  const order = [...state.order];
  order.splice(from, 1);
  order.splice(to, 0, fromId);
  return { ...state, order };
}

/** Visible panels of one column, in the saved order. */
export function columnPanels(defs: readonly PanelDef[], state: PanelState, column: PanelDef['column']): PanelDef[] {
  return state.order
    .map((id) => defs.find((d) => d.id === id)!)
    .filter((d) => d && d.column === column && isPanelVisible(defs, state, d.id));
}

/**
 * The Topology box shown in the Details panel (a service, a route, the exit, a
 * label on the policy wall…), shared by the diagram and the panel. A
 * destination is not a box here: it is `netDest`, which the Map and the Network
 * tab share and the URL carries. The two are exclusive: selecting one clears
 * the other, wherever it is selected (the subscription below, not the diagram,
 * which is not mounted on the other tabs). Not in the URL, and scoped to the
 * glove session it was chosen in.
 *
 * It also holds the diagram's latest layout, so the panel reads a box's hosts
 * from it rather than laying the diagram out a second time on every update.
 */
import { create } from 'zustand';
import type { Topology } from '../../lib/net-topology.js';
import { useSessionStore } from '../../stores/sessionStore.js';

interface TopologyFocus {
  token: string | null;
  box: string | null;
  setBox: (token: string, box: string | null) => void;
  /** The diagram's layout while it is drawn, for its glove session. */
  layout: { token: string; t: Topology } | null;
  setLayout: (layout: { token: string; t: Topology } | null) => void;
}

export const useTopologyFocus = create<TopologyFocus>((set) => ({
  token: null,
  box: null,
  setBox: (token, box) => set({ token, box }),
  layout: null,
  setLayout: (layout) => set({ layout }),
}));

// A destination chosen anywhere (Topology, the Network tab, the Map, a link) replaces the box.
useSessionStore.subscribe((s, prev) => {
  if (s.netDest && s.netDest !== prev.netDest && useTopologyFocus.getState().box) useTopologyFocus.setState({ box: null });
});

/** The box selected in this glove session, if any. */
export function useTopologyBox(token: string): string | null {
  return useTopologyFocus((s) => (s.token === token ? s.box : null));
}

/** The diagram's layout for this glove session, while it is drawn. */
export function useSharedLayout(token: string): Topology | null {
  return useTopologyFocus((s) => (s.layout?.token === token ? s.layout.t : null));
}

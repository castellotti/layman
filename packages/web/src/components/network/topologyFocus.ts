/**
 * The Topology box shown in the Details panel (a service, a route, the exit, a
 * label on the policy wall…), shared by the diagram and the panel. A
 * destination is not a box here: it is `netDest`, which the Map and the Network
 * tab share and the URL carries. The two are exclusive: selecting one clears
 * the other. Not in the URL, and scoped to the glove session it was chosen in.
 */
import { create } from 'zustand';

interface TopologyFocus {
  token: string | null;
  box: string | null;
  setBox: (token: string, box: string | null) => void;
}

export const useTopologyFocus = create<TopologyFocus>((set) => ({
  token: null,
  box: null,
  setBox: (token, box) => set({ token, box }),
}));

/** The box selected in this glove session, if any. */
export function useTopologyBox(token: string): string | null {
  return useTopologyFocus((s) => (s.token === token ? s.box : null));
}

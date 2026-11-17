import { useSessionStore } from '../stores/sessionStore.js';

/**
 * Open the Network tab for a glove session on one destination. Shared by the Matrix cards and the Gibson panel,
 * so the two cannot drift: the selection (`netToken`, `netDest`) lives in the session store because the URL reads
 * it. A port on the address is dropped, since Network selects by host.
 */
export function openNetwork(token: string, address: string): void {
  const st = useSessionStore.getState();
  st.setNetToken(token);
  st.setNetDest(address.replace(/:\d+$/, ''));
  st.setViewMode('network');
}

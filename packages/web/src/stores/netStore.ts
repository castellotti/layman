/**
 * Network data for glove sessions (see lib/net-state.ts for the semantics).
 *
 * Deliberately separate from sessionStore: `net:delta` frames arrive up to twice
 * a second while a network tab is open, and nothing outside those tabs should
 * re-render on them. The *selection* (which glove session, which destination) is
 * view state and lives in sessionStore, where the URL routing reads it.
 */
import { create } from 'zustand';
import { applyNetMessage, initialNetState, type NetClientState } from '../lib/net-state.js';
import type { NetServerMessage } from '../lib/netobs-types.js';

interface NetStore extends NetClientState {
  apply: (msg: NetServerMessage) => void;
  /** Record which token this client subscribed to; data for any other token is dropped. */
  setSubscribed: (token: string | null) => void;
}

export const useNetStore = create<NetStore>((set) => ({
  ...initialNetState,
  apply: (msg) => set((s) => applyNetMessage(s, msg)),
  setSubscribed: (token) =>
    set((s) => (s.subscribed === token ? {} : { subscribed: token, data: null })),
}));

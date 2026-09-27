/**
 * Network data for glove sessions (see lib/net-state.ts for the semantics).
 *
 * Deliberately separate from sessionStore: `net:delta` frames arrive up to twice
 * a second while a network tab is open, and nothing outside those tabs should
 * re-render on them. The *selection* (which glove session, which destination) is
 * view state and lives in sessionStore, where the URL routing reads it.
 */
import { create } from 'zustand';
import { applyNetMessage, initialNetState, startOp, type NetClientState } from '../lib/net-state.js';
import type { NetServerMessage, RulesOp } from '../lib/netobs-types.js';
import type { ClientMessage } from '../lib/ws-protocol.js';

interface NetStore extends NetClientState {
  apply: (msg: NetServerMessage) => void;
  /** Record which token this client subscribed to; data for any other token is dropped. */
  setSubscribed: (token: string | null) => void;
  /** The socket's send, registered by NetworkView while the tabs are open. */
  sender: ((msg: ClientMessage) => void) | null;
  setSender: (send: ((msg: ClientMessage) => void) | null) => void;
  /**
   * Ask the server to change the subscribed session's rules.json. Returns the
   * opId (its result lands in `ops`), or null when there is no socket or session.
   */
  applyRules: (op: RulesOp) => string | null;
}

let opSeq = 0;

export const useNetStore = create<NetStore>((set, get) => ({
  ...initialNetState,
  sender: null,
  apply: (msg) => set((s) => applyNetMessage(s, msg)),
  setSubscribed: (token) =>
    set((s) => (s.subscribed === token ? {} : { subscribed: token, data: null })),
  setSender: (sender) => set({ sender }),
  applyRules: (op) => {
    const { sender, subscribed } = get();
    if (!sender || !subscribed) return null;
    const opId = `op-${Date.now().toString(36)}-${(++opSeq).toString(36)}`;
    set((s) => startOp(s, opId, subscribed, op.kind, Date.now()));
    sender({ type: 'net:rules:apply', token: subscribed, op, opId });
    return opId;
  },
}));

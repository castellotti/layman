import { useCallback } from 'react';
import { useNetStore } from '../stores/netStore.js';
import { useSessionStore } from '../stores/sessionStore.js';
import { vpnEntriesFor, withVpnEntry } from '../lib/net-vpn.js';

const NONE: readonly string[] = [];

/**
 * `glove.network.vpnDomains` (net-vpn.ts), read from the config and written through the
 * network views' socket. The server re-reads it on its next poll and re-sends every
 * destination, so a mark shows within a second; nothing is changed client-side first.
 */
export function useVpnDomains(): {
  list: readonly string[];
  /** Whether the views can write it (the network socket is open and the config loaded). */
  writable: boolean;
  set: (next: string[]) => void;
  mark: (entries: string[]) => void;
  /** Remove every entry that covers `host`, so it is no longer a VPN route. */
  unmark: (host: string) => void;
} {
  const config = useSessionStore((s) => s.config);
  const sender = useNetStore((s) => s.sender);
  const list = config?.glove?.network?.vpnDomains ?? NONE;

  const set = useCallback((next: string[]) => {
    const glove = useSessionStore.getState().config?.glove;
    const send = useNetStore.getState().sender;
    if (!glove || !send) return;
    // The server deep-merges glove.network, so only the list is sent.
    send({ type: 'config:update', config: { glove: { ...glove, network: { ...glove.network, vpnDomains: next } } } });
  }, []);

  const mark = useCallback((entries: string[]) => {
    set(entries.reduce<string[]>((acc, e) => withVpnEntry(acc, e), [...list]));
  }, [list, set]);

  const unmark = useCallback((host: string) => {
    const drop = new Set(vpnEntriesFor(host, list));
    set(list.filter((e) => !drop.has(e)));
  }, [list, set]);

  return { list, writable: !!sender && !!config?.glove, set, mark, unmark };
}

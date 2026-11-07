import { useCallback } from 'react';
import { useNetStore } from '../stores/netStore.js';
import { useSessionStore } from '../stores/sessionStore.js';
import { vpnEntriesFor, withVpnEntry } from '../lib/net-vpn.js';

const NONE: readonly string[] = [];
const currentList = (): readonly string[] => useSessionStore.getState().config?.glove?.network?.vpnDomains ?? NONE;

/**
 * `glove.network.vpnDomains` (net-vpn.ts), read from the config and written through the
 * network views' socket. The server re-reads it on its next poll and re-sends every
 * destination, so a mark shows within a second.
 *
 * Every edit starts from the store's current list, not the one this render saw, and the
 * store takes the new list as soon as it is sent: two marks made before the server's
 * `session:config` echo would otherwise each start from the old list, and the second
 * would undo the first. The echo replaces it with what the server kept.
 */
export function useVpnDomains(): {
  list: readonly string[];
  /** Whether the views can write it (the network socket is open and the config loaded). */
  writable: boolean;
  mark: (entries: string[]) => void;
  /** Remove every entry that covers `host`, so it is no longer a VPN route. */
  unmark: (host: string) => void;
} {
  const config = useSessionStore((s) => s.config);
  const sender = useNetStore((s) => s.sender);
  const list = config?.glove?.network?.vpnDomains ?? NONE;

  const set = useCallback((next: string[]) => {
    const { config: current, setConfig } = useSessionStore.getState();
    const glove = current?.glove;
    const send = useNetStore.getState().sender;
    if (!current || !glove || !send) return;
    const nextGlove = { ...glove, network: { ...glove.network, vpnDomains: next } };
    send({ type: 'config:update', config: { glove: nextGlove } });
    setConfig({ ...current, glove: nextGlove });
  }, []);

  const mark = useCallback((entries: string[]) => {
    set(entries.reduce<string[]>((acc, e) => withVpnEntry(acc, e), [...currentList()]));
  }, [set]);

  const unmark = useCallback((host: string) => {
    const now = currentList();
    const drop = new Set(vpnEntriesFor(host, now));
    set(now.filter((e) => !drop.has(e)));
  }, [set]);

  return { list, writable: !!sender && !!config?.glove, mark, unmark };
}

/**
 * The Map's "Untunnelled traffic" banner, dismissed and remembered.
 *
 * A dismissal is kept per glove session with the hosts it covered, in localStorage, so
 * it outlives a reload and a restart. It does not hide the alarm for good: a host that
 * was not in the dismissed set going out untunnelled brings the banner back, and the
 * strip chip, the KPI and the red rows keep counting either way.
 */
import { useCallback, useMemo, useState } from 'react';
import type { DestinationAggregate } from './netobs-types.js';

const KEY = 'layman.net.map.untunnelledDismissed';
/** Sessions remembered; the oldest go first. */
const MAX_SESSIONS = 200;

type Dismissed = Record<string, { hosts: string[]; at: number }>;

function read(): Dismissed {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Dismissed) : {};
  } catch {
    return {};
  }
}

function write(d: Dismissed): void {
  const keep = Object.entries(d).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_SESSIONS);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* private mode: this page only */ }
}

/** The hosts the banner names, sorted so the same set compares equal. */
export function bannerHosts(dests: Iterable<Pick<DestinationAggregate, 'host' | 'endpoint' | 'key'>>): string[] {
  return [...new Set([...dests].map((d) => d.host ?? d.endpoint ?? d.key))].sort();
}

/** Whether `hosts` are all covered by a dismissal of `seen`. Pure; the hook below is the storage. */
export function isDismissed(hosts: readonly string[], seen: readonly string[] | undefined): boolean {
  if (!seen) return false;
  const s = new Set(seen);
  return hosts.every((h) => s.has(h));
}

export function useDismissedBanner(token: string, hosts: readonly string[]): { dismissed: boolean; dismiss: () => void } {
  const [store, setStore] = useState<Dismissed>(read);
  const dismissed = useMemo(() => isDismissed(hosts, store[token]?.hosts), [hosts, store, token]);
  const dismiss = useCallback(() => {
    // Re-read: another tab may have dismissed another session meanwhile.
    const next = { ...read(), [token]: { hosts: [...new Set([...(store[token]?.hosts ?? []), ...hosts])].sort(), at: Date.now() } };
    write(next);
    setStore(next);
  }, [hosts, store, token]);
  return { dismissed, dismiss };
}

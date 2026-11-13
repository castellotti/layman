import { useCallback, useSyncExternalStore } from 'react';

/** Each key's raw value as this page knows it: read from storage once, then kept here on every set. */
const values = new Map<string, string | null>();
/** Every mounted user of a key, so a change in one (one Dashboard pane's toggle) reaches them all. */
const listeners = new Map<string, Set<() => void>>();

function read(key: string): string | null {
  if (!values.has(key)) {
    let raw: string | null = null;
    // Reading throws too where storage is blocked (Safari with storage off, a sandboxed frame).
    try { raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { /* the default, then */ }
    values.set(key, raw);
  }
  return values.get(key) ?? null;
}

function subscribe(key: string, listener: () => void): () => void {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => { set.delete(listener); };
}

/**
 * A setting kept in localStorage, falling back to `initial` where storage is blocked or holds nothing
 * valid. Every component using the same key sees the same value: setting it in one updates the rest.
 */
export function useStored<T extends string | number>(key: string, initial: T, parse: (raw: string) => T | null): [T, (v: T) => void] {
  const raw = useSyncExternalStore(useCallback((l: () => void) => subscribe(key, l), [key]), () => read(key));
  const value = (raw === null ? null : parse(raw)) ?? initial;
  const set = useCallback((v: T) => {
    values.set(key, String(v));
    try { localStorage.setItem(key, String(v)); } catch { /* private mode: kept for this page only */ }
    for (const listener of listeners.get(key) ?? []) listener();
  }, [key]);
  return [value, set];
}

const flag = (raw: string): '1' | '0' | null => (raw === '1' || raw === '0' ? raw : null);

/** An on/off setting kept in localStorage and shared like `useStored`: [on, toggle]. */
export function useStoredFlag(key: string, initial: boolean): [boolean, () => void] {
  const [value, set] = useStored<'1' | '0'>(key, initial ? '1' : '0', flag);
  return [value === '1', useCallback(() => set(value === '1' ? '0' : '1'), [set, value])];
}

import { useCallback, useEffect, useState } from 'react';

/** Every mounted user of a key, so a change in one (one Dashboard pane's toggle) reaches them all. */
const listeners = new Map<string, Set<(raw: string) => void>>();

/**
 * A setting kept in localStorage, falling back to `initial` where storage is blocked or holds nothing
 * valid. Every component using the same key sees the same value: setting it in one updates the rest.
 */
export function useStored<T extends string | number>(key: string, initial: T, parse: (raw: string) => T | null): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    let raw: string | null = null;
    // Reading throws too where storage is blocked (Safari with storage off, a sandboxed frame).
    try { raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { /* the default, then */ }
    return (raw === null ? null : parse(raw)) ?? initial;
  });
  useEffect(() => {
    const hear = (raw: string) => { const v = parse(raw); if (v !== null) setValue(v); };
    const set = listeners.get(key) ?? new Set();
    set.add(hear);
    listeners.set(key, set);
    return () => { set.delete(hear); };
    // `parse` is a rule for the key, not state: a new closure each render must not resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback((v: T) => {
    try { localStorage.setItem(key, String(v)); } catch { /* private mode: kept for this page only */ }
    const heard = listeners.get(key);
    if (heard && heard.size > 0) for (const hear of heard) hear(String(v));
    else setValue(v);
  }, [key]);
  return [value, set];
}

const flag = (raw: string): '1' | '0' | null => (raw === '1' || raw === '0' ? raw : null);

/** An on/off setting kept in localStorage and shared like `useStored`: [on, toggle]. */
export function useStoredFlag(key: string, initial: boolean): [boolean, () => void] {
  const [value, set] = useStored<'1' | '0'>(key, initial ? '1' : '0', flag);
  return [value === '1', useCallback(() => set(value === '1' ? '0' : '1'), [set, value])];
}

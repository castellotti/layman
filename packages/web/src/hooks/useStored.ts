import { useCallback, useState } from 'react';

/** A setting kept in localStorage, falling back to `initial` where storage is blocked or holds nothing valid. */
export function useStored<T extends string | number>(key: string, initial: T, parse: (raw: string) => T | null): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    let raw: string | null = null;
    // Reading throws too where storage is blocked (Safari with storage off, a sandboxed frame).
    try { raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { /* the default, then */ }
    return (raw === null ? null : parse(raw)) ?? initial;
  });
  const set = useCallback((v: T) => {
    setValue(v);
    try { localStorage.setItem(key, String(v)); } catch { /* private mode: kept for this page only */ }
  }, [key]);
  return [value, set];
}

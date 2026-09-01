import { useState, useCallback } from 'react';

/**
 * Tracks which collapsible sidebar sections (folders, "Unfiled", …) are
 * expanded, persisting the set to localStorage under `storageKey`.
 *
 * Default is collapsed: an id absent from the stored set reads as collapsed, so
 * a freshly-created folder starts closed and only sections the user has opened
 * are remembered. Keyed by an opaque section id (folder uuid, or a reserved
 * sentinel like `__unfiled__`), so one hook instance can back every section in a
 * sidebar.
 */
export function useExpandedSections(storageKey: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => load(storageKey));

  const isExpanded = useCallback((id: string) => expanded.has(id), [expanded]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      save(storageKey, next);
      return next;
    });
  }, [storageKey]);

  return { isExpanded, toggle };
}

function load(storageKey: string): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function save(storageKey: string, ids: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...ids]));
  } catch {
    // Storage may be unavailable (private browsing quota, etc.) — non-fatal.
  }
}

import { useCallback, useEffect, useState } from 'react';
import { getJson } from './useNetTrace.js';

/** Mirrors `GodotBuildStatus` in `packages/server/src/styx/godot.ts`. */
export interface GodotBuildStatus {
  present: boolean;
  dir: string;
  displayDir: string;
  builtAt: number | null;
  files: number;
  problems: string[];
}

/**
 * The local styx-godot build's status, read when `enabled` turns true, on `refresh()`, and (after a pause, while
 * the user types) when `folder` changes. null until the first answer.
 */
export function useMatrixGodotStatus(enabled: boolean, folder = ''): { status: GodotBuildStatus | null; error: string | null; refresh: () => void } {
  const [status, setStatus] = useState<GodotBuildStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const t = setTimeout(() => {
      getJson<GodotBuildStatus>('/api/styx/godot/status')
        .then((s) => { if (live) { setStatus(s); setError(null); } })
        .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    }, folder ? 500 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [enabled, tick, folder]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { status, error, refresh };
}

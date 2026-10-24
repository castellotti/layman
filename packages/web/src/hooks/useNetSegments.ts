/**
 * A glove session's ready-made ranges (`GET /api/net/sessions/:token/segments`): its runs,
 * bursts split at `gapHours`, agent sessions, and hourly activity, for the range picker and
 * the strip's "Run 18". Re-read every `refreshMs`, since a live run grows and new runs start.
 */
import { useEffect, useState } from 'react';
import type { NetSegments } from '../lib/netobs-types.js';
import { getJson, pollSettled } from './useNetTrace.js';

export function useNetSegments(token: string | null, gapHours: number, refreshMs = 60_000): { segments: NetSegments | null; error: string | null } {
  const key = `${token}|${gapHours}`;
  const [state, setState] = useState<{ key: string; segments: NetSegments | null; error: string | null }>({ key, segments: null, error: null });
  useEffect(() => {
    if (!token) return;
    return pollSettled((live) => getJson<NetSegments>(`/api/net/sessions/${encodeURIComponent(token)}/segments?gap=${gapHours}`)
      .then((segments) => { if (live()) setState({ key, segments, error: null }); })
      .catch((e: Error) => { if (live()) setState((s) => ({ key, segments: s.key === key ? s.segments : null, error: e.message })); }), refreshMs);
  }, [token, gapHours, key, refreshMs]);
  // Another session's (or gap's) segments are never shown under this one, even for a frame.
  return state.key === key ? { segments: state.segments, error: state.error } : { segments: null, error: null };
}

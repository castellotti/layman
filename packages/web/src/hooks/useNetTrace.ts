/**
 * One turn's trace from Layman's own API (`GET /api/net/sessions/:token/trace`),
 * for the views that show a piece of it outside the Trace tab: the detail
 * card's "Agent asked for", and the Map ribbon's tool-call markers. Only
 * Layman is ever asked.
 */
import { useEffect, useState } from 'react';
import type { TraceCall, TraceView } from '../lib/netobs-types.js';

export type TraceQuery = { turn: string } | { at: number } | null;

export async function fetchTrace(token: string, query: TraceQuery): Promise<TraceView> {
  const q = !query ? '' : 'turn' in query ? `?turn=${encodeURIComponent(query.turn)}` : `?at=${Math.round(query.at)}`;
  const r = await fetch(`/api/net/sessions/${encodeURIComponent(token)}/trace${q}`);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<TraceView>;
}

/**
 * Run `load` now and again `ms` after each run settles (0: once), never on a fixed beat,
 * so a slow load (a long session's trace) never stacks requests behind it. `live()` turns
 * false once cancelled; returns the cancel, for an effect's cleanup.
 */
export function pollSettled(load: (live: () => boolean) => Promise<unknown>, ms: number): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    void load(() => live).catch(() => {}).finally(() => { if (live && ms > 0) timer = setTimeout(run, ms); });
  };
  run();
  return () => { live = false; clearTimeout(timer); };
}

/** The trace for `query`, re-read every `refreshMs` (0: once per query). `key` must change when the query does. */
export function useNetTrace(token: string | null, query: TraceQuery, key: string, refreshMs = 0): { view: TraceView | null; error: string | null } {
  const [state, setState] = useState<{ view: TraceView | null; error: string | null; key: string | null }>({ view: null, error: null, key: null });
  useEffect(() => {
    if (!token) return;
    return pollSettled((live) => fetchTrace(token, query)
      .then((view) => { if (live()) setState({ view, error: null, key }); })
      .catch((e: Error) => { if (live()) setState((s) => ({ ...s, error: e.message, key })); }), refreshMs);
    // `query` is described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, key, refreshMs]);
  return state.key === key ? { view: state.view, error: state.error } : { view: null, error: null };
}

/** Tool calls that started in [from, to], across turns: the Map ribbon's markers. Re-asked when `from` moves. */
export function useNetCalls(token: string, from: number, to: number): TraceCall[] {
  const [calls, setCalls] = useState<TraceCall[]>([]);
  useEffect(() => {
    let live = true;
    fetch(`/api/net/sessions/${encodeURIComponent(token)}/calls?from=${Math.round(from)}&to=${Math.round(to)}`)
      .then((r) => (r.ok ? r.json() : { calls: [] }))
      .then((j: { calls?: TraceCall[] }) => { if (live) setCalls(j.calls ?? []); })
      .catch(() => { if (live) setCalls([]); });
    return () => { live = false; };
  }, [token, from, to]);
  return calls;
}

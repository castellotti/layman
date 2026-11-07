/**
 * One turn's trace from Layman's own API (`GET /api/net/sessions/:token/trace`),
 * for the views that show a piece of it outside the Trace tab: the detail
 * card's "Agent asked for", and the Map ribbon's tool-call markers. Only
 * Layman is ever asked.
 */
import { useEffect, useState } from 'react';
import type { NetRange, NetTokens, NetTokenSums, SessionDownload, TraceCall, TraceView } from '../lib/netobs-types.js';

export type TraceQuery = { turn: string } | { at: number } | null;

/** GET a Layman API path, throwing its `error` (else the status) when it fails. */
export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/** One turn's trace; with a `range`, the turns counted and stepped through are those begun in it. */
export function fetchTrace(token: string, query: TraceQuery, range: NetRange | null = null): Promise<TraceView> {
  const q = new URLSearchParams();
  if (query) {
    if ('turn' in query) q.set('turn', query.turn);
    else q.set('at', String(Math.round(query.at)));
  }
  setRange(q, range);
  const qs = q.toString();
  return getJson<TraceView>(`/api/net/sessions/${encodeURIComponent(token)}/trace${qs ? `?${qs}` : ''}`);
}

/** A range's `from`/`to` (ms) query values; none for All records. */
function setRange(q: URLSearchParams, range: NetRange | null): void {
  if (!range) return;
  q.set('from', String(range.from));
  if (range.to !== null) q.set('to', String(range.to));
}

/** The session's LLM tokens in a range (server `pi/usage.ts`), the same `from`/`to` as the trace. */
export function fetchTokens(token: string, range: NetRange | null): Promise<NetTokenSums> {
  const q = new URLSearchParams();
  setRange(q, range);
  const qs = q.toString();
  return getJson<NetTokenSums>(`/api/net/sessions/${encodeURIComponent(token)}/tokens${qs ? `?${qs}` : ''}`);
}

/**
 * The session's LLM tokens in `range`, null when there are none to show. An open range (or All
 * records) is re-read every `refreshMs` while the tab is visible: new calls land in the transcript.
 */
export function useNetTokens(token: string, range: NetRange | null, refreshMs: number): NetTokens | null {
  const [state, setState] = useState<{ key: string; tokens: NetTokens | null }>({ key: '', tokens: null });
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  const key = `${token} ${from} ${to}`;
  useEffect(() => {
    const r = from === null ? null : { from, to };
    let loaded = false;
    return pollSettled((live) => (loaded && document.hidden ? Promise.resolve() : fetchTokens(token, r)
      .then((j) => { if (live()) setState({ key, tokens: j.tokens }); })
      .catch(() => { if (live()) setState({ key, tokens: null }); })
      .finally(() => { loaded = true; })), to === null ? refreshMs : 0);
    // `key` describes token and range.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs]);
  // Another session or range: never the last one's figures while this one loads.
  return state.key === key ? state.tokens : null;
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

/** Files `web_download` saved in the glove session, re-read every `refreshMs` (the Trace tab's Downloads panel). */
export function useNetDownloads(token: string, refreshMs = 10_000): { downloads: SessionDownload[] | null; error: string | null } {
  const [state, setState] = useState<{ token: string; downloads: SessionDownload[] | null; error: string | null }>({ token, downloads: null, error: null });
  useEffect(() => pollSettled((live) => getJson<{ downloads: SessionDownload[] }>(`/api/net/sessions/${encodeURIComponent(token)}/downloads`)
    .then((j) => {
      // Keep the previous list when nothing changed, so a quiet poll does not re-render the panel.
      if (live()) setState((s) => (s.token === token && !s.error && JSON.stringify(s.downloads) === JSON.stringify(j.downloads) ? s : { token, downloads: j.downloads, error: null }));
    })
    .catch((e: Error) => { if (live()) setState((s) => ({ ...s, token, error: e.message })); }), refreshMs), [token, refreshMs]);
  return state.token === token ? { downloads: state.downloads, error: state.error } : { downloads: null, error: null };
}

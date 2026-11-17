/**
 * The Styx matrix feed as the Matrix tabs ask for it (docs/extensions/styx.md). Pure.
 * `MatrixRow` mirrors `packages/server/src/styx/matrix.ts`; keep the two in step by hand.
 */

export interface MatrixRow {
  /** `host:port` (host alone for a target with no URL), lower-case. */
  address: string;
  sent: number;
  received: number;
  /** How many times it was reached; at least 1. */
  count: number;
  /** How many of those glove refused. */
  blocked: number;
  /** Left the sandbox outside any tunnel, and is not a known VPN route. */
  untunnelled: boolean;
}

export type MatrixWindow = '1m' | '15m' | '1h' | 'all';

/** The picker's choices, in order, with the feed's `relative` value (none: the whole record). */
export const MATRIX_WINDOWS: ReadonlyArray<{ id: MatrixWindow; label: string; relative: string | null }> = [
  { id: '1m', label: '1m', relative: '60s' },
  { id: '15m', label: '15m', relative: '15m' },
  { id: '1h', label: '1h', relative: '1h' },
  { id: 'all', label: 'All', relative: null },
];

export const DEFAULT_MATRIX_WINDOW: MatrixWindow = '15m';

export function parseMatrixWindow(raw: string): MatrixWindow | null {
  return MATRIX_WINDOWS.some((w) => w.id === raw) ? (raw as MatrixWindow) : null;
}

/**
 * The `?…` of a Styx feed's URL (or ''): one session and a window. No session: every live session,
 * which the server limits to 15 minutes, so "All" there asks for the longest window it can answer
 * instead of the whole record it cannot. The Gibson feeds ask the same way (`gibson-feed.ts`).
 */
export function feedQuery(opts: { sessionId: string | null; window: MatrixWindow }): string {
  const params = new URLSearchParams();
  if (opts.sessionId) params.set('session', opts.sessionId);
  const relative = MATRIX_WINDOWS.find((w) => w.id === opts.window)?.relative ?? null;
  if (relative) params.set('relative', relative);
  else if (!opts.sessionId) params.set('relative', '1d');
  const q = params.toString();
  return q ? `?${q}` : '';
}

export function matrixUrl(opts: { sessionId: string | null; window: MatrixWindow }): string {
  return `/api/styx/v1/matrix${feedQuery(opts)}`;
}

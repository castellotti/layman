import type { StatusDotState, StateChipVariant } from '../components/primitives/index.js';
import type { TimelineEvent } from './types.js';
import type { SessionInfo } from './ws-protocol.js';

/** sessionName if set, else the last path segment of cwd, else a short sessionId prefix. */
export function sessionDisplayName(
  sessionName: string | undefined,
  cwd: string | undefined,
  sessionId: string
): string {
  if (sessionName) return sessionName;
  if (cwd) return cwd.split('/').filter(Boolean).pop() ?? cwd;
  return sessionId.slice(0, 8);
}

export function getSessionDisplayName(session: SessionInfo): string {
  return sessionDisplayName(session.sessionName, session.cwd, session.sessionId);
}

/**
 * The single definition of "live" every consumer must agree on: a session the
 * gate still considers active. Note it is `active !== false`, not `active ===
 * true` — a session with `active` unset (never suspended) is live, and only an
 * explicit `active: false` (idle-tombstoned/suspended) drops it. Duplicating
 * that subtlety inline is how the Dashboard and the Sessions tab drifted apart.
 */
export function isSessionLive(session: SessionInfo): boolean {
  return session.active !== false;
}

/** How the Dashboard orders its sessions: by last activity, or as the user dragged them. */
export type DashboardSortMode = 'recent' | 'custom';

/**
 * The sessions the Dashboard lists, in its order: live and not dismissed, matching `filter`
 * (name, cwd or id), then most recently active first, or in `order` once the user has dragged
 * them (sessions missing from it go last). The glove picker follows it (`netPickerOrder`).
 */
export function orderDashboardSessions(
  sessions: readonly SessionInfo[],
  opts: { dismissed: ReadonlySet<string>; sortMode: DashboardSortMode; order: readonly string[]; filter?: string },
): SessionInfo[] {
  const q = (opts.filter ?? '').trim().toLowerCase();
  const shown = sessions.filter((s) => isSessionLive(s) && !opts.dismissed.has(s.sessionId)
    && (!q || (s.sessionName ?? '').toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q)));
  if (opts.sortMode === 'custom') {
    const at = new Map(opts.order.map((id, i) => [id, i]));
    return shown.sort((a, b) => (at.get(a.sessionId) ?? 999) - (at.get(b.sessionId) ?? 999));
  }
  return shown.sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Color for a context-window-usage percentage, shared by the dashboard row and pane header. */
export function contextPctColor(pct: number, fallback: string): string {
  if (pct >= 75) return 'var(--error)';
  if (pct >= 60) return 'var(--warn)';
  return fallback;
}

export function deriveSessionState(events: TimelineEvent[], sessionActive: boolean): {
  dotState: StatusDotState;
  chipVariant: StateChipVariant;
  lastEvent: TimelineEvent | undefined;
} {
  const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
  const last = meaningful[meaningful.length - 1];

  if (!sessionActive) return { dotState: 'ended', chipVariant: 'ended', lastEvent: last };
  if (!last) return { dotState: 'idle', chipVariant: 'idle', lastEvent: last };

  if (last.type === 'stop_failure' || last.type === 'tool_call_failed') {
    return { dotState: 'error', chipVariant: 'error', lastEvent: last };
  }
  if (last.type === 'permission_request' && !last.data.decision) {
    return { dotState: 'permission', chipVariant: 'permission', lastEvent: last };
  }
  if (last.type === 'tool_call_pending' && !last.data.decision) {
    return { dotState: 'running', chipVariant: 'running', lastEvent: last };
  }
  if (last.type === 'agent_stop' || last.type === 'session_end') {
    return { dotState: 'idle', chipVariant: 'idle', lastEvent: last };
  }
  return { dotState: 'running', chipVariant: 'running', lastEvent: last };
}

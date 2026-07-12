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

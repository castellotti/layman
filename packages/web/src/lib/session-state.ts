import type { StatusDotState, StateChipVariant } from '../components/primitives/index.js';
import type { TimelineEvent } from './types.js';

export function deriveSessionState(events: TimelineEvent[], sessionActive: boolean): {
  dotState: StatusDotState;
  chipVariant: StateChipVariant;
} {
  if (!sessionActive) return { dotState: 'ended', chipVariant: 'ended' };

  const meaningful = events.filter(e => e.type !== 'session_metrics' && e.type !== 'notification');
  const last = meaningful[meaningful.length - 1];

  if (!last) return { dotState: 'idle', chipVariant: 'idle' };

  if (last.type === 'stop_failure' || last.type === 'tool_call_failed') {
    return { dotState: 'error', chipVariant: 'error' };
  }
  if (last.type === 'permission_request' && !last.data.decision) {
    return { dotState: 'permission', chipVariant: 'permission' };
  }
  if (last.type === 'tool_call_pending' && !last.data.decision) {
    return { dotState: 'running', chipVariant: 'running' };
  }
  if (last.type === 'agent_stop' || last.type === 'session_end') {
    return { dotState: 'idle', chipVariant: 'idle' };
  }
  return { dotState: 'running', chipVariant: 'running' };
}

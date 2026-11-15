import type { EventType } from './types.js';

/**
 * Events that say a session exists but not that it has done anything: a harness starting up loads
 * its instructions, reports its status line, may change a setting, and that is all many sessions
 * ever do (a `claude` opened and closed, a helper process). A session with only these is *quiet*
 * (`SessionInfo.quiet`), and the Dashboard can list it without opening its pane.
 */
export const QUIET_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'session_start',
  'session_end',
  'session_metrics',
  'notification',
  'instructions_loaded',
  'config_change',
  'setup',
  'cwd_changed',
  'file_changed',
  'model_change',
  'teammate_idle',
  'drift_check',
]);

export function isQuietEvent(type: EventType): boolean {
  return QUIET_EVENT_TYPES.has(type);
}

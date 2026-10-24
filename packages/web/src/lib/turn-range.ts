/**
 * A turn as a time range for the network tabs ("Network for this turn"): from its prompt to when
 * its last event finished, with a little grace either side for the gate's record batching and a
 * pooled connection's tail. Times are the transcript's when the harness kept them
 * (`data.transcriptAt` / `transcriptCompletedAt`): a passive watcher's `timestamp` is when it
 * *read* the event, so a range from it is approximate, and says so. A turn still running gives
 * an open range (`to: null`).
 *
 * Mirrors `turnEnd` in packages/server/src/netobs/trace.ts, which the Trace tab's turns use:
 * change both or neither. On both sides `live` is the glove gate's (`NetSessionSummary.live`,
 * `NetStore.live`), not the Layman session's, and `last` is the last turn of its Layman session.
 */
import type { TimelineEvent } from './types.js';
import type { NetRange } from './netobs-types.js';
import { getEffectiveAgentContent } from './reasoning.js';

/** Before the prompt: the gate batches records, so a flow the prompt caused can be stamped a little early. */
export const TURN_LEAD_MS = 1000;
/** After the end: a pooled connection's last bytes and the gate's batching. */
export const TURN_TAIL_MS = 2000;

export interface TurnSpan {
  startedAt: number;
  /** Null while the turn is running. */
  endedAt: number | null;
  exact: boolean;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** When an event finished: the transcript's completion time, else its time, else when it was read. */
const doneAt = (e: TimelineEvent) => num(e.data.transcriptCompletedAt) ?? num(e.data.transcriptAt) ?? e.timestamp;

/** Whether an event ends a turn: a stop, the session's end, or an answer that said something. */
function closes(e: TimelineEvent): boolean {
  if (e.type === 'agent_stop' || e.type === 'session_end' || e.type === 'stop_failure') return true;
  return e.type === 'agent_response' && getEffectiveAgentContent(e).response.trim() !== '';
}

/**
 * The span of a turn from the events it owns (its prompt first), or null for none. `last`: it is
 * its Layman session's last turn; `live`: the glove gate is running. Only the last turn of a live
 * session whose last event does not close it is running; any other turn ended when its last event
 * finished.
 */
export function turnSpan(owned: readonly TimelineEvent[], { last, live }: { last: boolean; live: boolean }): TurnSpan | null {
  if (!owned.length) return null;
  const prompt = owned[0];
  const at = num(prompt.data.transcriptAt);
  const running = last && live && !closes(owned[owned.length - 1]);
  return {
    startedAt: at ?? prompt.timestamp,
    endedAt: running ? null : Math.max(...owned.map(doneAt)),
    exact: at !== null,
  };
}

export function turnRange(span: TurnSpan): NetRange {
  return { from: span.startedAt - TURN_LEAD_MS, to: span.endedAt === null ? null : span.endedAt + TURN_TAIL_MS };
}

/** What the button's tooltip says about the range it sets. */
export const TURN_RANGE_TIP = `From ${TURN_LEAD_MS / 1000} s before the prompt to ${TURN_TAIL_MS / 1000} s after the turn ended (the gate batches records, and a pooled connection's last bytes trail), or until now while it runs. From the transcript's times when the harness kept them; otherwise approximate.`;

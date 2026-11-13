/**
 * What the activity map shows besides its geometry, pure so it is tested in node: which session it
 * follows, the pulses in flight, the words for a row of the feed. `components/activity/` only draws.
 */
import type { Board, BoardEntry } from './activity-board.js';
import { lanes } from './activity-map.js';
import { safeLabel, type StationId, type StationSetup } from './station.js';
import { STATION_STYLE } from './station-style.js';
import { eventDetail, kindLabel } from './event-styles.js';
import { isSessionLive } from './session-state.js';
import type { SessionInfo } from './ws-protocol.js';
import type { TimelineEvent } from './types.js';

/**
 * The session the map follows: the one open in the app, else the newest live session, else the
 * newest of all. Null with no sessions at all.
 */
export function pickSession(activeSessionId: string | null, sessions: readonly SessionInfo[]): string | null {
  if (activeSessionId) return activeSessionId;
  const newest = (list: readonly SessionInfo[]) =>
    list.reduce<SessionInfo | null>((best, s) => (!best || s.lastSeen > best.lastSeen ? s : best), null);
  return (newest(sessions.filter(isSessionLive)) ?? newest(sessions))?.sessionId ?? null;
}

/** How long a pulse takes along a spoke, and how long after it a finished call's return still flies. */
export const PULSE_MS = 900;

/**
 * A pulse: `out` from the core (or the Agents station, for a subagent's call) to a station, `in`
 * from a station to the core (something pushed in, or a call's answer coming back), `run` looping
 * out while a call is still going. `lane` is its sideways offset from its spoke's centre line.
 */
export interface Pulse {
  key: string;
  station: StationId;
  from: 'core' | 'agents';
  kind: 'out' | 'in' | 'run';
  /** Hollow: a signal nobody asked for (pushed into the context). */
  hollow: boolean;
  /** Refused or failed: drawn in the alarm colour. */
  bad: boolean;
  lane: number;
  /** How far into its flight it is, in ms, so a redraw never restarts it. */
  age: number;
}

const MAX_PULSES = 14;

/** The pulses to draw at `now`: calls still running, and the start and end of recent ones. */
export function pulsesOf(board: Board, now: number): Pulse[] {
  const out: Omit<Pulse, 'lane'>[] = [];
  const bad = (e: BoardEntry) => e.status === 'err' || e.status === 'block';
  for (const e of board.entries) {
    const from = e.from === 'agents' ? 'agents' : 'core';
    if (e.status === 'run') {
      out.push({ key: `${e.eventId}:run`, station: e.station, from, kind: 'run', hollow: false, bad: false, age: Math.max(0, now - e.startedAt) });
      continue;
    }
    const sinceStart = now - e.startedAt;
    if (sinceStart >= 0 && sinceStart < PULSE_MS) {
      const inbound = e.from === 'inbound';
      out.push({ key: `${e.eventId}:${inbound ? 'in' : 'out'}`, station: e.station, from, kind: inbound ? 'in' : 'out', hollow: inbound, bad: bad(e), age: sinceStart });
    }
    if (e.from !== 'inbound' && e.endedAt !== undefined && e.endedAt > e.startedAt) {
      const sinceEnd = now - e.endedAt;
      if (sinceEnd >= 0 && sinceEnd < PULSE_MS) {
        out.push({ key: `${e.eventId}:back`, station: e.station, from, kind: 'in', hollow: false, bad: bad(e), age: sinceEnd });
      }
    }
  }
  const recent = out.slice(-MAX_PULSES);
  // Pulses that share a spoke, a direction and a moment fly side by side.
  const groups = new Map<string, number[]>();
  recent.forEach((p, i) => {
    const k = `${p.station}|${p.from}|${p.kind === 'in' ? 'in' : 'out'}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  });
  const laneOf = new Array<number>(recent.length).fill(0);
  for (const idx of groups.values()) {
    const offsets = lanes(idx.length);
    idx.forEach((i, k) => { laneOf[i] = offsets[k]; });
  }
  return recent.map((p, i) => ({ ...p, lane: laneOf[i] }));
}

/** A count in a few characters: 999, 1.2k, 12k. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/**
 * The words for a feed row. In full, what the Logs row says (the command, the path, the query); with
 * names only, `safeLabel`'s name and nothing of the content, for a shared screen.
 */
export function entryLabel(event: TimelineEvent | undefined, station: StationId, namesOnly: boolean, setup: StationSetup): string {
  if (!event) return STATION_STYLE[station].label;
  const tool = event.data.toolName;
  if (tool) return namesOnly ? safeLabel(tool, event.data.toolInput, setup) : eventDetail(event);
  if (namesOnly) return kindLabel(event.type);
  const detail = eventDetail(event);
  return detail || kindLabel(event.type);
}

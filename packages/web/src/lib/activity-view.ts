/**
 * What the activity map shows besides its geometry, pure so it is tested in node: which session it
 * follows, the pulses in flight, the words for a row of the feed. `components/activity/` only draws.
 */
import { isFault, type Board, type EntryStatus } from './activity-board.js';
import { byteWear, lanes, wear } from './activity-map.js';
import type { GloveStations } from './activity-glove.js';
import type { RouteId } from './net-topology.js';
import { formatBytes } from './net-format.js';
import { countLabel } from './format.js';
import { safeLabel, STATION_IDS, type StationId, type StationSetup } from './station.js';
import { STATION_STYLE } from './station-style.js';
import { eventDetail, kindLabel } from './event-styles.js';
import { isSessionLive, newestSession } from './session-state.js';
import type { SessionInfo } from './ws-protocol.js';
import type { TimelineEvent } from './types.js';

/**
 * The session the map follows: the one open in the app, else the newest live session, else the
 * newest of all. Null with no sessions at all.
 */
export function pickSession(activeSessionId: string | null, sessions: readonly SessionInfo[]): string | null {
  if (activeSessionId) return activeSessionId;
  return (newestSession(sessions.filter(isSessionLive)) ?? newestSession(sessions))?.sessionId ?? null;
}

/** How long a pulse takes along a spoke, and how long after it a finished call's return still flies. */
export const PULSE_MS = 900;

/**
 * A pulse: `out` from the core (or the Agents station, for a subagent's call) to a station, `in`
 * from a station to the core (something pushed in, or a call's answer coming back), `run` looping
 * out while a call is still going. `lane` is its sideways offset from its spoke's centre line, for
 * the moment it appears (the component keeps it, so a dot never jumps sideways mid-flight). A key
 * names the station too: a decision's Guard entry shares its call's event.
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
  for (const e of board.entries) {
    const from = e.from === 'agents' ? 'agents' : 'core';
    if (e.status === 'run') {
      out.push({ key: `${e.eventId}:${e.station}:run`, station: e.station, from, kind: 'run', hollow: false, bad: false, age: Math.max(0, now - e.startedAt) });
      continue;
    }
    const sinceStart = now - e.startedAt;
    if (sinceStart >= 0 && sinceStart < PULSE_MS) {
      const inbound = e.from === 'inbound';
      out.push({ key: `${e.eventId}:${e.station}:${inbound ? 'in' : 'out'}`, station: e.station, from, kind: inbound ? 'in' : 'out', hollow: inbound, bad: isFault(e.status), age: sinceStart });
    }
    if (e.from !== 'inbound' && e.endedAt !== undefined && e.endedAt > e.startedAt) {
      const sinceEnd = now - e.endedAt;
      if (sinceEnd >= 0 && sinceEnd < PULSE_MS) {
        out.push({ key: `${e.eventId}:${e.station}:back`, station: e.station, from, kind: 'in', hollow: false, bad: isFault(e.status), age: sinceEnd });
      }
    }
  }
  // A running call keeps its pulse however many short ones follow it; the newest of the rest fill up.
  const runs = out.filter((p) => p.kind === 'run').slice(-MAX_PULSES);
  const rest = out.filter((p) => p.kind !== 'run');
  const recent = [...runs, ...rest.slice(rest.length - (MAX_PULSES - runs.length))];
  // Pulses that share a spoke, a direction and a moment fly side by side.
  const groups = new Map<string, number[]>();
  recent.forEach((p, i) => {
    const k = `${p.station}|${p.from}|${p.kind === 'in' ? 'in' : 'out'}`;
    const group = groups.get(k);
    if (group) group.push(i); else groups.set(k, [i]);
  });
  const laneOf = new Array<number>(recent.length).fill(0);
  for (const idx of groups.values()) {
    const offsets = lanes(idx.length);
    idx.forEach((i, k) => { laneOf[i] = offsets[k]; });
  }
  return recent.map((p, i) => ({ ...p, lane: laneOf[i] }));
}

/**
 * The words for a feed row. In full, what the Logs row says (the command, the path, the query); with
 * names only, `safeLabel`'s name and nothing of the content, for a shared screen.
 */
export function entryLabel(event: TimelineEvent | undefined, station: StationId, namesOnly: boolean, setup: StationSetup): string {
  if (!event) return STATION_STYLE[station].label;
  const tool = event.data.toolName;
  if (namesOnly) return tool ? safeLabel(tool, event.data.toolInput, setup) : kindLabel(event.type);
  return eventDetail(event) || kindLabel(event.type);
}

/** How a feed row's status reads: a word (none for a plain success, which shows its duration) and its colour. */
export const ENTRY_STATUS: Record<EntryStatus, { word: string; color: string }> = {
  run: { word: 'running', color: 'var(--accent)' },
  ok: { word: '', color: 'var(--text-faint)' },
  err: { word: 'failed', color: 'var(--error)' },
  block: { word: 'refused', color: 'var(--warn)' },
  unended: { word: 'no end', color: 'var(--text-faint)' },
};

/** The map's summary for a screen reader: each station that saw work, with its count. */
export function mapTitle(name: string, board: Board): string {
  const counts = STATION_IDS.filter((s) => board.counts[s]).map((s) => `${STATION_STYLE[s].label} ${board.counts[s]}`);
  return `Activity of ${name}: ${counts.join(', ') || 'nothing yet'}`;
}

/** A station lights up for this long after its last call started. */
export const GLOW_MS = 3000;
/** A leg of the route holds this long after it was drawn, then fades over the next. */
export const LEG_HOLD_MS = 40_000;
export const LEG_FADE_MS = 20_000;

/**
 * How visible a leg of the route is: the newer legs stronger (`k` of `legs`, oldest first), and on
 * a live session one older than `LEG_HOLD_MS` fading out. A finished session shows its whole route.
 */
export function legOpacity(k: number, legs: number, age: number, live: boolean): number {
  const fade = live ? Math.max(0, Math.min(1, 1 - (age - LEG_HOLD_MS) / LEG_FADE_MS)) : 1;
  return (0.15 + (0.55 * (k + 1)) / Math.max(1, legs)) * fade;
}

/** When each station's latest call started. */
export function lastStarts(board: Board): Map<StationId, number> {
  const out = new Map<StationId, number>();
  for (const e of board.entries) out.set(e.station, Math.max(out.get(e.station) ?? 0, e.startedAt));
  return out;
}

/** One station as the map draws it: Layman's own (a `StationId`) or a glove gate (`gate:<service>`). */
export interface StationSpec {
  id: string;
  label: string;
  /** Its tooltip: what lands there, and what it amounts to. */
  about: string;
  color: string;
  glyph: StationId;
  /** The figure beside it (a count of calls, or bytes for a gate), null with nothing yet. */
  amount: string | null;
  /** How worn its spoke is, 0..1. */
  wear: number;
  runs: number;
  faults: number;
  /** When its latest call started (0: never), for the glow after a call. */
  lastStart: number;
}

/** A gate's colour, by the route its traffic takes (the Topology tab's). */
const ROUTE_COLOR: Record<RouteId, string> = {
  tunnel: 'var(--net-tunnel)', local: 'var(--net-local)', llm: 'var(--net-local)', direct: 'var(--error)',
};

/**
 * The stations of a session's map: Layman's own, worn by their counts, with Network replaced by
 * the glove gates when the session is behind one (worn by their bytes), where Network was.
 */
export function stationSpecs(board: Board, glove: GloveStations | null): StationSpec[] {
  const running = new Map<string, number>();
  for (const e of board.entries) if (e.status === 'run') running.set(e.station, (running.get(e.station) ?? 0) + 1);
  const starts = lastStarts(board);
  const out: StationSpec[] = [];
  for (const id of STATION_IDS) {
    if (id === 'network' && glove) {
      for (const g of glove.gates) {
        const refused = g.blocked > 0 ? `, ${g.blocked} refused` : '';
        out.push({
          id: g.id, label: g.label, color: ROUTE_COLOR[g.route], glyph: 'network',
          about: `glove's ${g.service} gate: ${formatBytes(g.bytes)} in ${g.flows} connection${g.flows === 1 ? '' : 's'}${refused}`,
          amount: g.bytes > 0 ? formatBytes(g.bytes) : null, wear: byteWear(g.bytes), runs: 0, faults: 0, lastStart: 0,
        });
      }
      continue;
    }
    const style = STATION_STYLE[id];
    const count = board.counts[id] ?? 0;
    const bytes = id === 'browser' && glove ? glove.browserBytes : 0;
    out.push({
      id, label: style.label, color: style.color, glyph: id,
      about: `${style.about}${bytes > 0 ? ` (${formatBytes(bytes)} through glove's gate)` : ''}`,
      amount: count > 0 ? countLabel(count) : null,
      wear: Math.max(wear(count), byteWear(bytes)),
      runs: running.get(id) ?? 0, faults: board.faults[id] ?? 0, lastStart: starts.get(id) ?? 0,
    });
  }
  return out;
}

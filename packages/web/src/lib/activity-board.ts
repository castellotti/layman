/**
 * The activity board: what a session's events add up to at each station (`lib/station.ts`). Pure: one
 * pass over the events, oldest first, recomputed whenever they change, so it reads a recorded session
 * and a live one the same way and needs nothing stored.
 *
 * A tool call is usually one event whose type changes in place (pending, approved, completed). Two
 * cases record a second event instead and leave the call's own event open: a failure (a separate
 * `tool_call_failed` from the hooks) and a watcher that sees the call and its result apart (Mistral
 * Vibe records `tool_call_approved`, then `tool_call_completed`). The second event closes the open
 * call of the same tool, the one with the same input first, else the oldest, and counts nothing. A call still open when its session ends, or when the person sends the next prompt,
 * never reported an end; it is `unended`, not running and not a fault.
 */
import type { TimelineEvent } from './types.js';
import { eventStation, isPushedMemory, NO_SETUP, stationOf, type StationId, type StationSetup } from './station.js';
import { isDuplicatePrompt, sortStable } from './turns.js';

/** `run` is still going; `err` failed; `block` was refused; `unended` never reported an end. */
export type EntryStatus = 'run' | 'ok' | 'err' | 'block' | 'unended';

/** Where an entry's work came from: the main loop, a subagent, or pushed in from outside. */
export type EntryFrom = 'core' | 'agents' | 'inbound';

export interface BoardEntry {
  /** The event this entry stands for. A Guard entry shares its call's event. */
  eventId: string;
  station: StationId;
  from: EntryFrom;
  status: EntryStatus;
  startedAt: number;
  endedAt?: number;
}

export interface Board {
  /** The newest entries, oldest first, and every entry still running however old. */
  entries: BoardEntry[];
  /** Entries per station over the whole session: what wears a spoke. */
  counts: Partial<Record<StationId, number>>;
  /** Memory pushed into the context unasked (`isPushedMemory`), also counted in `counts.memory`. */
  pushed: number;
  /** Failed or refused entries per station since the person's last prompt. */
  faults: Partial<Record<StationId, number>>;
  /** Subagents started and not yet stopped. */
  agents: number;
  /** Prompts so far, duplicates of one prompt counted once (the turn rule). */
  turns: number;
  /** The context window's fill, from the newest `session_metrics` that reported one. */
  context?: number;
  /** The model the session last reported. */
  model?: string;
}

export interface BoardOptions {
  setup?: StationSetup;
  /** The session is over: whatever is still open never ended, and no subagent is alive. */
  ended?: boolean;
  /** How many finished entries to keep (running ones are always kept). */
  keep?: number;
}

const KEEP = 200;

/** Events that report on work already counted elsewhere (the Agent call itself; the task list). */
const NOT_WORK = new Set(['subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle', 'post_compact', 'elicitation_result']);

const isFault = (status: EntryStatus): boolean => status === 'err' || status === 'block';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * The station a tool call works at. `eventStation` files a decided call (approved, denied,
 * delegated) under Guard, which is right for a Logs row; the board counts the call at its tool's
 * station and the decision at Guard, separately.
 */
const stationCache = new WeakMap<StationSetup, WeakMap<TimelineEvent, StationId>>();

function toolStationOf(event: TimelineEvent, setup: StationSetup): StationId {
  let bySetup = stationCache.get(setup);
  if (!bySetup) { bySetup = new WeakMap(); stationCache.set(setup, bySetup); }
  const hit = bySetup.get(event);
  if (hit) return hit;
  const station = stationOf(event.data.toolName ?? '', event.data.toolInput, setup);
  bySetup.set(event, station);
  return station;
}

/** A transcript's own times when a passive watcher recorded the event late, else the event's. */
const startOf = (e: TimelineEvent): number => e.data.transcriptAt ?? e.timestamp;
const endOf = (e: TimelineEvent): number => e.data.transcriptCompletedAt ?? e.data.completedAt ?? e.timestamp;

/** Every event of a session reduced to its board. */
export function reduceBoard(events: readonly TimelineEvent[], options: BoardOptions = {}): Board {
  const setup = options.setup ?? NO_SETUP;
  const keep = options.keep ?? KEEP;
  const all: BoardEntry[] = [];
  const counts: Partial<Record<StationId, number>> = {};
  let faults: Partial<Record<StationId, number>> = {};
  let pushed = 0;
  let turns = 0;
  let context: number | undefined;
  let model: string | undefined;
  /** Open calls by tool name, oldest first, for a separate result event to close. */
  const open = new Map<string, { entry: BoardEntry; input: string }[]>();
  /** The open call a result event belongs to: the same tool and input, else the oldest of the tool. */
  const claim = (tool: string, input: string): BoardEntry | undefined => {
    const queue = open.get(tool);
    if (!queue) return undefined;
    const [found] = queue.splice(Math.max(0, queue.findIndex((c) => c.input === input)), 1);
    if (queue.length === 0) open.delete(tool);
    return found.entry;
  };
  /** Subagents alive, by type: a stop names only its type. */
  const alive = new Map<string, number>();
  let openPrompt: TimelineEvent | null = null;
  /** Open elicitations (an MCP server asking the person), closed by their result. */
  const asking: BoardEntry[] = [];
  /** Entries still running, so closing them does not walk the whole session. */
  const running = new Set<BoardEntry>();

  const fault = (station: StationId): void => {
    if (station !== 'you') faults[station] = (faults[station] ?? 0) + 1;
  };
  const add = (entry: BoardEntry): BoardEntry => {
    all.push(entry);
    if (entry.status === 'run') running.add(entry);
    counts[entry.station] = (counts[entry.station] ?? 0) + 1;
    if (isFault(entry.status)) fault(entry.station);
    return entry;
  };
  const close = (entry: BoardEntry, status: EntryStatus, at: number): void => {
    running.delete(entry);
    entry.status = status;
    entry.endedAt = Math.max(entry.startedAt, at);
    if (isFault(status)) fault(entry.station);
  };
  /** Everything still running is over without a word: the session ended or a new prompt began. */
  const closeAll = (at: number): void => {
    for (const e of [...running]) close(e, 'unended', at);
    open.clear();
    asking.length = 0;
  };

  for (const event of sortStable([...events])) {
    const { type, data } = event;
    const from: EntryFrom = data.subagentId ? 'agents' : 'core';
    const at = startOf(event);

    if (type === 'session_metrics') {
      if (typeof data.contextUsedPct === 'number') context = data.contextUsedPct;
      model = str(data.modelDisplayName) ?? str(data.modelId) ?? model;
      continue;
    }
    if (type === 'session_end') {
      closeAll(event.timestamp);
      alive.clear();
      continue;
    }
    if (type === 'subagent_start' || type === 'subagent_stop') {
      const kind = data.agentType ?? '';
      const n = alive.get(kind) ?? 0;
      if (type === 'subagent_start') alive.set(kind, n + 1);
      else if (n > 0) alive.set(kind, n - 1);
      continue;
    }
    if (type === 'elicitation_result') {
      const asked = asking.pop();
      if (asked) close(asked, 'ok', at);
      continue;
    }

    if (type === 'user_prompt') {
      if (openPrompt && isDuplicatePrompt(event, openPrompt)) continue;
      openPrompt = event;
      turns++;
      closeAll(at);
      // A new message clears what went wrong on the way to the last answer.
      faults = {};
      add({ eventId: event.id, station: 'you', from: 'inbound', status: 'ok', startedAt: at, endedAt: at });
      continue;
    }

    if (type.startsWith('tool_call_')) {
      const station = toolStationOf(event, setup);
      const tool = data.toolName ?? '';
      const input = JSON.stringify(data.toolInput ?? {});
      const decided = data.decision !== undefined;
      if (decided) add({ eventId: event.id, station: 'guard', from, status: 'ok', startedAt: at, endedAt: at });
      if (type === 'tool_call_delegated') continue; // the call itself arrives as its own event
      if (type === 'tool_call_pending' || type === 'tool_call_approved') {
        const entry = add({ eventId: event.id, station, from, status: 'run', startedAt: at });
        const queue = open.get(tool) ?? [];
        queue.push({ entry, input });
        open.set(tool, queue);
        continue;
      }
      if (type === 'tool_call_failed') {
        const call = claim(tool, input);
        if (call) { call.eventId = event.id; close(call, 'err', at); }
        else add({ eventId: event.id, station, from, status: 'err', startedAt: at, endedAt: at });
        continue;
      }
      if (type === 'tool_call_completed' && !decided) {
        const call = claim(tool, input);
        if (call) { call.eventId = event.id; close(call, 'ok', endOf(event)); continue; }
      }
      const status: EntryStatus = type === 'tool_call_denied' ? 'block' : 'ok';
      add({ eventId: event.id, station, from, status, startedAt: at, endedAt: Math.max(at, endOf(event)) });
      continue;
    }

    if (NOT_WORK.has(type)) continue;
    const station = eventStation(type, data as Record<string, unknown>, setup);
    if (station === undefined) {
      if (typeof data.model === 'string' && data.model) model = data.model;
      continue;
    }
    if (type === 'agent_response' && typeof data.model === 'string' && data.model) model = data.model;

    const pushedIn = isPushedMemory(type) || type === 'file_changed';
    if (isPushedMemory(type)) pushed++;
    let status: EntryStatus = 'ok';
    if (type === 'stop_failure') status = 'err';
    else if (type === 'permission_denied') status = 'block';
    else if (type === 'drift_alert' && data.driftLevel === 'red') status = 'block';
    if (type === 'elicitation') {
      asking.push(add({ eventId: event.id, station, from, status: 'run', startedAt: at }));
      continue;
    }
    add({ eventId: event.id, station, from: pushedIn ? 'inbound' : from, status, startedAt: at, endedAt: at });
  }

  if (options.ended) {
    const last = events.reduce((m, e) => Math.max(m, e.timestamp), 0);
    closeAll(last);
    alive.clear();
  }

  let agents = 0;
  for (const n of alive.values()) agents += n;
  const from = all.length - keep;
  const entries = from <= 0 ? all : all.filter((e, i) => i >= from || e.status === 'run');
  return { entries, counts, pushed, faults, agents, turns, ...(context !== undefined ? { context } : {}), ...(model ? { model } : {}) };
}

/** How many entries run at once at each station: the map's `×3`. */
export function runningAt(board: Board): Partial<Record<StationId, number>> {
  const out: Partial<Record<StationId, number>> = {};
  for (const e of board.entries) if (e.status === 'run') out[e.station] = (out[e.station] ?? 0) + 1;
  return out;
}

export interface RouteStop { station: StationId; at: number }

/**
 * The stations the main loop went through, oldest first, the last `max` of them. Model steps and
 * subagents' work are left out, and a station visited twice in a row is one stop (at its latest).
 */
export function routeOf(entries: readonly BoardEntry[], max = 7): RouteStop[] {
  const stops: RouteStop[] = [];
  for (const e of entries) {
    if (e.from === 'agents' || e.station === 'model') continue;
    const last = stops[stops.length - 1];
    if (last && last.station === e.station) last.at = e.startedAt;
    else stops.push({ station: e.station, at: e.startedAt });
  }
  return stops.slice(-max);
}

/** A row of the folded feed: one entry, or a run of finished ones at one station shown as the newest. */
export interface FeedRow { entry: BoardEntry; times: number; tookMs: number }

const isPlain = (e: BoardEntry): boolean => e.status === 'ok';

/**
 * The feed, newest first, at most `max` rows. Finished calls in a row at one station, from the same
 * place, fold into one row (`+2`); a running, failed or refused entry always stands alone.
 */
export function foldRows(entries: readonly BoardEntry[], max = 16): FeedRow[] {
  const rows: FeedRow[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const took = e.endedAt === undefined ? 0 : Math.max(0, e.endedAt - e.startedAt);
    const last = rows[rows.length - 1];
    if (last && isPlain(e) && isPlain(last.entry) && last.entry.station === e.station && last.entry.from === e.from) {
      last.times++;
      last.tookMs += took;
      continue;
    }
    if (rows.length === max) break;
    rows.push({ entry: e, times: 1, tookMs: took });
  }
  return rows;
}

/**
 * A session's recorded events joined with what the live store holds for it, by event id, the live
 * copy winning (it has the latest type and data of a call that changed in place). The live store
 * holds only what arrived since the page loaded (and the WebSocket's short replay), and the
 * recording only what was written when it was fetched, so neither alone is the session.
 */
export function mergeSessionEvents(recorded: readonly TimelineEvent[], live: readonly TimelineEvent[]): TimelineEvent[] {
  if (live.length === 0) return recorded as TimelineEvent[];
  if (recorded.length === 0) return live as TimelineEvent[];
  const liveIds = new Set(live.map((e) => e.id));
  return sortStable([...recorded.filter((e) => !liveIds.has(e.id)), ...live]);
}

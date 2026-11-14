/**
 * The activity board: what a session's events add up to at each station (`lib/station.ts`). Pure: one
 * pass over the events, oldest first, recomputed whenever they change, so it reads a recorded session
 * and a live one the same way and needs nothing stored.
 *
 * A tool call is usually one event whose type changes in place (pending, approved, completed). Two
 * cases record a second event instead and leave the call's own event open: a failure (a separate
 * `tool_call_failed` from the hooks) and a watcher that sees the call and its result apart (Mistral
 * Vibe records `tool_call_approved`, then `tool_call_completed`). The second event closes the open
 * call of the same tool and the same input, and counts nothing. Only those: on every other harness a
 * `tool_call_completed` is the call itself, and must never close a sibling still running. A call still open when its session ends, or when the person sends the next prompt,
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
  /** The kind of work: its glyph and colour in the feed. */
  station: StationId;
  /**
   * The map station it is drawn on: its `station`, or for a gloved session's network call the
   * glove gate its connections went through (`BoardOptions.place`). Counts, faults, the route and
   * pulses are by this.
   */
  on: string;
  from: EntryFrom;
  status: EntryStatus;
  startedAt: number;
  endedAt?: number;
}

export interface Board {
  /** The newest entries, oldest first, and every entry still running however old. */
  entries: BoardEntry[];
  /** Entries per map station (`on`) over the whole session: what wears a spoke. */
  counts: Partial<Record<string, number>>;
  /** Memory pushed into the context unasked (`isPushedMemory`), also counted in `counts.memory`. */
  pushed: number;
  /** Failed or refused entries per map station since the person's last prompt. */
  faults: Partial<Record<string, number>>;
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
  /**
   * Where a tool call is drawn when not on its own station: a gloved session's network call on
   * the gate its connections went through (`lib/activity-glove.ts` `placeCalls`). Null keeps it.
   */
  place?: (event: TimelineEvent, station: StationId) => string | null;
}

const KEEP = 200;

/** Harnesses that record a call's result as an event of its own, apart from the call. */
const RESULT_APART = new Set(['mistral-vibe']);

/** A tool input as a key, to match a result to its call; cached because Write inputs hold whole files. */
const inputCache = new WeakMap<TimelineEvent, string>();
function inputKey(event: TimelineEvent): string {
  let key = inputCache.get(event);
  if (key === undefined) { key = `${event.data.toolName ?? ''}\u0000${JSON.stringify(event.data.toolInput ?? {})}`; inputCache.set(event, key); }
  return key;
}

/** Events that report on work already counted elsewhere (the Agent call itself; the task list). */
const NOT_WORK = new Set(['subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle', 'post_compact', 'elicitation_result']);

/** Refused or failed. */
export const isFault = (status: EntryStatus): boolean => status === 'err' || status === 'block';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const stationCache = new WeakMap<StationSetup, WeakMap<TimelineEvent, StationId>>();

/**
 * The station a tool call works at. `eventStation` files a decided call (approved, denied,
 * delegated) under Guard, which is right for a Logs row; the board counts the call at its tool's
 * station and the decision at Guard, separately.
 */
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
  const counts: Partial<Record<string, number>> = {};
  let faults: Partial<Record<string, number>> = {};
  let pushed = 0;
  let turns = 0;
  let context: number | undefined;
  let model: string | undefined;
  /**
   * Calls with no result yet, by tool and input, oldest first, for a result recorded apart to close.
   * A call marked `unended` at a prompt stays here: its result may still come, and closes it then.
   */
  const open = new Map<string, BoardEntry[]>();
  const claim = (key: string): BoardEntry | undefined => {
    const queue = open.get(key);
    const found = queue?.shift();
    if (queue && queue.length === 0) open.delete(key);
    return found;
  };
  /** Subagents alive, by type: a stop names only its type. */
  const alive = new Map<string, number>();
  let openPrompt: TimelineEvent | null = null;
  /** Open elicitations (an MCP server asking the person), closed by their result. */
  const asking: BoardEntry[] = [];
  /** Entries still running, so closing them does not walk the whole session. */
  const running = new Set<BoardEntry>();

  const fault = (on: string): void => {
    if (on !== 'you') faults[on] = (faults[on] ?? 0) + 1;
  };
  const add = (draft: Omit<BoardEntry, 'on'> & { on?: string }): BoardEntry => {
    const entry: BoardEntry = { ...draft, on: draft.on ?? draft.station };
    all.push(entry);
    if (entry.status === 'run') running.add(entry);
    counts[entry.on] = (counts[entry.on] ?? 0) + 1;
    if (isFault(entry.status)) fault(entry.on);
    return entry;
  };
  const close = (entry: BoardEntry, status: EntryStatus, at: number): void => {
    // A late result of a call the last prompt already closed belongs to that turn, whose faults are gone.
    const wasRunning = running.delete(entry);
    entry.status = status;
    entry.endedAt = Math.max(entry.startedAt, at);
    if (wasRunning && isFault(status)) fault(entry.on);
  };
  /** Everything still running is over without a word: the session ended or a new prompt began. */
  const closeAll = (at: number): void => {
    for (const e of [...running]) close(e, 'unended', at);
    asking.length = 0;
  };

  const ordered = sortStable(events);
  for (const event of ordered) {
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
      const on = options.place?.(event, station) ?? station;
      const decided = data.decision !== undefined;
      if (decided) add({ eventId: event.id, station: 'guard', from, status: 'ok', startedAt: at, endedAt: at });
      if (type === 'tool_call_delegated') continue; // the call itself arrives as its own event
      if (type === 'tool_call_pending' || type === 'tool_call_approved') {
        const entry = add({ eventId: event.id, station, on, from, status: 'run', startedAt: at });
        const key = inputKey(event);
        const queue = open.get(key);
        if (queue) queue.push(entry); else open.set(key, [entry]);
        continue;
      }
      if (type === 'tool_call_failed') {
        const call = claim(inputKey(event));
        if (call) { call.eventId = event.id; close(call, 'err', at); }
        else add({ eventId: event.id, station, on, from, status: 'err', startedAt: at, endedAt: at });
        continue;
      }
      if (type === 'tool_call_completed' && !decided && RESULT_APART.has(event.agentType)) {
        const call = claim(inputKey(event));
        if (call) { call.eventId = event.id; close(call, 'ok', endOf(event)); continue; }
      }
      const status: EntryStatus = type === 'tool_call_denied' ? 'block' : 'ok';
      add({ eventId: event.id, station, on, from, status, startedAt: at, endedAt: Math.max(at, endOf(event)) });
      continue;
    }

    if (NOT_WORK.has(type)) continue;
    const station = eventStation(type, data as Record<string, unknown>, setup);
    if (station === undefined) {
      if (typeof data.model === 'string' && data.model) model = data.model;
      continue;
    }
    if (type === 'agent_response' && typeof data.model === 'string' && data.model) model = data.model;

    const memoryIn = isPushedMemory(type);
    if (memoryIn) pushed++;
    const pushedIn = memoryIn || type === 'file_changed';
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
    closeAll(ordered.at(-1)?.timestamp ?? 0);
    alive.clear();
  }

  let agents = 0;
  for (const n of alive.values()) agents += n;
  const from = all.length - keep;
  const entries = from <= 0 ? all : all.filter((e, i) => i >= from || e.status === 'run');
  return { entries, counts, pushed, faults, agents, turns, ...(context !== undefined ? { context } : {}), ...(model ? { model } : {}) };
}

/** How many entries run at once at each station: the map's `×3`. */
export function runningAt(board: Board): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const e of board.entries) if (e.status === 'run') out[e.on] = (out[e.on] ?? 0) + 1;
  return out;
}

/** A stop of the route, at a map station (`BoardEntry.on`). */
export interface RouteStop { station: string; at: number }

/**
 * The stations the main loop went through, oldest first, the last `max` of them. Left out: model
 * steps, subagents' work, Guard (a decision sits beside a call, not on the way) and what was pushed
 * in (instructions loaded, a file changed outside); the person's prompt stays. A station visited
 * twice in a row is one stop (at its latest).
 */
export function routeOf(entries: readonly BoardEntry[], max = 7): RouteStop[] {
  const stops: RouteStop[] = [];
  for (const e of entries) {
    if (e.from === 'agents' || e.station === 'model' || e.station === 'guard') continue;
    if (e.from === 'inbound' && e.station !== 'you') continue;
    const last = stops[stops.length - 1];
    if (last && last.station === e.on) last.at = e.startedAt;
    else stops.push({ station: e.on, at: e.startedAt });
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
    if (last && isPlain(e) && isPlain(last.entry) && last.entry.on === e.on && last.entry.from === e.from) {
      last.times++;
      last.tookMs += took;
      continue;
    }
    if (rows.length === max) break;
    rows.push({ entry: e, times: 1, tookMs: took });
  }
  return rows;
}

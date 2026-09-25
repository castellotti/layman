/**
 * Client-side network state: how `net:*` frames fold into what the four
 * network tabs render. Pure, so it is tested in node; `stores/netStore.ts` is a
 * thin Zustand wrapper around it.
 *
 * Every delta carries the *latest full value* of whatever changed (see the
 * server's `NetStore.takeDelta`), so applying one is replace-by-key, never
 * add — which also makes a delta that overlaps the snapshot harmless.
 */
import type {
  DestinationAggregate,
  ExitRecord,
  FlowView,
  NetCounters,
  NetGateView,
  NetServerMessage,
  NetSessionFile,
  NetSessionSummary,
  NetTotals,
  RateBucket,
  RulesView,
} from './netobs-types.js';

/** Closed flows kept client-side beyond every open one. The server's snapshot sends up to 500. */
export const MAX_CLOSED_FLOWS = 2_000;
/** 1 s buckets kept client-side: one hour. */
export const MAX_BUCKETS = 3_600;

export interface NetSessionData {
  token: string;
  env: string;
  name: string;
  session: NetSessionFile | null;
  gate: NetGateView;
  exit: ExitRecord | null;
  exits: ExitRecord[];
  rules: RulesView;
  destinations: Map<string, DestinationAggregate>;
  flows: Map<string, FlowView>;
  buckets: Map<number, RateBucket>;
  totals: NetTotals;
  counters: NetCounters;
  emptyFolded: number;
  historyTruncated: boolean;
}

/** What became of one `net:rules:apply` this client sent: did the write reach disk? */
export interface NetOpResult {
  token: string;
  kind: string;
  /** Null until the server answers. */
  ok: boolean | null;
  error: string | null;
  at: number;
}

export interface NetClientState {
  sessions: NetSessionSummary[];
  /** False until the first `net:sessions` frame: "no sessions" and "not told yet" differ. */
  sessionsKnown: boolean;
  /** The token this client asked the server for (at most one). */
  subscribed: string | null;
  /** Data for `subscribed`; null until its snapshot arrives. */
  data: NetSessionData | null;
  /** This client's rules operations by opId; the gate's verdict is in `data.rules.write`. */
  ops: Record<string, NetOpResult>;
}

export const initialNetState: NetClientState = {
  sessions: [],
  sessionsKnown: false,
  subscribed: null,
  data: null,
  ops: {},
};

/** Operations kept for their result notices; older ones are dropped. */
const MAX_OPS = 20;

/** Record an operation this client is about to send. */
export function startOp(state: NetClientState, opId: string, token: string, kind: string, at: number): NetClientState {
  const ops = Object.fromEntries(Object.entries({ ...state.ops, [opId]: { token, kind, ok: null, error: null, at } }).slice(-MAX_OPS));
  return { ...state, ops };
}

function trimFlows(flows: Map<string, FlowView>): Map<string, FlowView> {
  const closed = [...flows.values()].filter((f) => f.phase === 'close');
  if (closed.length <= MAX_CLOSED_FLOWS) return flows;
  closed.sort((a, b) => a.lastT - b.lastT);
  const drop = new Set(closed.slice(0, closed.length - MAX_CLOSED_FLOWS).map((f) => f.id));
  return new Map([...flows].filter(([id]) => !drop.has(id)));
}

function trimBuckets(buckets: Map<number, RateBucket>): Map<number, RateBucket> {
  if (buckets.size <= MAX_BUCKETS) return buckets;
  const keep = [...buckets.keys()].sort((a, b) => a - b).slice(-MAX_BUCKETS);
  return new Map(keep.map((t) => [t, buckets.get(t)!]));
}

/** Fold one `net:*` frame into the state. Frames for a token this client is not subscribed to are ignored. */
export function applyNetMessage(state: NetClientState, msg: NetServerMessage): NetClientState {
  if (msg.type === 'net:sessions') return { ...state, sessions: msg.sessions, sessionsKnown: true };
  if (msg.type === 'net:rules:result') {
    const op = state.ops[msg.opId];
    if (!op) return state;
    return { ...state, ops: { ...state.ops, [msg.opId]: { ...op, ok: msg.ok, error: msg.error } } };
  }
  if (msg.token !== state.subscribed) return state;

  if (msg.type === 'net:snapshot') {
    const s = msg.snapshot;
    return {
      ...state,
      data: {
        token: s.token,
        env: s.env,
        name: s.name,
        session: s.session,
        gate: s.gate,
        exit: s.exit,
        exits: s.exits,
        rules: s.rules,
        destinations: new Map(s.destinations.map((d) => [d.key, d])),
        flows: new Map(s.flows.map((f) => [f.id, f])),
        buckets: new Map(s.buckets.map((b) => [b.t, b])),
        totals: s.totals,
        counters: s.counters,
        emptyFolded: s.emptyFolded,
        historyTruncated: s.historyTruncated,
      },
    };
  }

  const data = state.data;
  if (!data) return state; // a delta or update before the snapshot: the snapshot will include it

  switch (msg.type) {
    case 'net:delta': {
      const d = msg.delta;
      const destinations = new Map(data.destinations);
      for (const k of d.removedDestinations) destinations.delete(k);
      for (const a of d.destinations) destinations.set(a.key, a);
      const flows = new Map(data.flows);
      for (const f of d.flows) flows.set(f.id, f);
      const buckets = new Map(data.buckets);
      for (const b of d.buckets) buckets.set(b.t, b);
      return {
        ...state,
        data: {
          ...data,
          destinations,
          flows: trimFlows(flows),
          buckets: trimBuckets(buckets),
          totals: d.totals,
          counters: d.counters,
          emptyFolded: d.emptyFolded,
        },
      };
    }
    case 'net:status':
      return { ...state, data: { ...data, gate: msg.status } };
    case 'net:exit': {
      const exits = msg.exit ? [...data.exits, msg.exit].slice(-50) : data.exits;
      return { ...state, data: { ...data, exit: msg.exit, exits } };
    }
    case 'net:rules':
      return { ...state, data: { ...data, rules: msg.rules } };
  }
}

/**
 * The glove session the tabs show when none is chosen (plan §1.2): the one whose
 * token is the `sessionName` of Layman's active session, if that is a gloved
 * one; otherwise the most recently active (the server sorts live first, then by
 * last activity).
 */
export function defaultNetToken(sessions: NetSessionSummary[], activeSessionName: string | null | undefined): string | null {
  if (activeSessionName && sessions.some((s) => s.token === activeSessionName)) return activeSessionName;
  return sessions[0]?.token ?? null;
}

export type NetTabSignal = 'alert' | 'live' | null;

/**
 * The dot on the Network tab label (plan §6.2): red while a running gate reports
 * rejected rules or has carried untunnelled traffic — the two failures that
 * must not be missable from another tab — else teal when a gate is running.
 * A finished session's history is not an alarm.
 */
export function networkTabSignal(sessions: NetSessionSummary[]): NetTabSignal {
  const live = sessions.filter((s) => s.live);
  if (live.some((s) => s.rulesOk === false || s.directFlows > 0)) return 'alert';
  return live.length ? 'live' : null;
}

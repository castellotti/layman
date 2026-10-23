/**
 * In-memory network state per glove session.
 *
 * This is deliberately **not** `EventStore`. glove writes an `update` about once
 * a second for every open flow; `EventStore.add()` would PII-scan each one, push
 * it onto the 10,000-entry ring (evicting real events), record it to SQLite and
 * broadcast it — the "ruinous for a token delta" case the root CLAUDE.md
 * documents for live streaming. Network data gets this store and its own
 * `net:*` WebSocket frames instead, as `LiveStreamStore` does.
 *
 * Nor is the PII filter applied to flow records: they are hostnames, IPs, ports
 * and byte counts from glove's collector, not agent-authored text, and redacting
 * hostnames would make the feature useless. The one exception is `request` in
 * `record: "full"` mode, whose URL and headers go through the string filter.
 *
 * Every aggregate is a running sum maintained by subtracting a flow's previous
 * contribution and adding its new one, so evicting closed flows from memory
 * (bounded at `maxClosedFlows`) never changes a total.
 *
 * What Layman kept from before a restart (`history.ts`) is added on top: each
 * view shows the kept totals less what the files re-read up to the kept
 * watermark (the part they already counted), plus everything read.
 */
import { EventEmitter } from 'events';
import { BLOCK_STATES, aggregateState, classifyFlow, classifySession, flowFlags, gateSince } from './classify.js';
import { groupKeyFor } from './domain.js';
import { type NetSessionLocation } from './discovery.js';
import { blankRulesView } from './control.js';
import { predict, type FlowFacts, type GateFacts, type RuleSet } from './rules.js';
import type { CarryFlow, HistoryDest, HistoryHour, HistoryRun, HistorySession } from './history.js';
import { isHopService, isLanOnlyRule, offMap } from './types.js';
import { mayGeolocate } from './geo.js';
import type {
  DestinationAggregate,
  ExitRecord,
  FlowFlags,
  FlowRecord,
  FlowView,
  GateRecord,
  GeoPoint,
  NetCounters,
  NetDelta,
  NetGateView,
  NetGloveInfo,
  NetService,
  NetSessionFile,
  NetSessionSummary,
  NetSnapshot,
  NetState,
  NetTotals,
  PolicyVerdict,
  RateBucket,
  RulesView,
  StatusRecord,
} from './types.js';

/** Before discovery has said anything about a session. */
const UNKNOWN_GLOVE: NetGloveInfo = { template: null, filter: null, transcripts: null, orphaned: false };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** A `HistoryHour`'s identity: what `net_hours` is keyed by (null run and tool as ''). */
export const hourKey = (hour: number, run: string | null, key: string, tool: string | null) => `${hour}|${run ?? ''}|${key}|${tool ?? ''}`;
const byHour = (a: HistoryHour, b: HistoryHour) =>
  a.hour - b.hour || (a.run ?? '').localeCompare(b.run ?? '') || a.key.localeCompare(b.key) || (a.tool ?? '').localeCompare(b.tool ?? '');
/** Copies of `hours`, in `net_hours` order. */
const sortedHours = (hours: Iterable<HistoryHour>) => [...hours].sort(byHour).map((h) => ({ ...h }));
/** How long after its collector's stop a record still belongs to that run. */
const RUN_STOP_GRACE_MS = 5 * SECOND;
/** 1 s buckets are kept for this long, then folded into 1 min buckets for the session. */
const SECOND_BUCKET_SPAN = 60 * MINUTE;
const SPARK_SPAN = 60 * SECOND;
const MAX_EXITS = 50;
const MAX_IPS = 8;
export const DEFAULT_MAX_CLOSED_FLOWS = 5_000;
export const SNAPSHOT_FLOW_LIMIT = 500;

/**
 * How much of a flow the kept history already counts: its records at or before
 * the history's watermark, under the destination it had then. That part stays
 * with that key even if the flow's destination is refined later: the kept row
 * for that key is what holds it.
 */
interface PreWatermark {
  key: string | null;
  up: number;
  down: number;
  counted: boolean;
  blocked: NetState | null;
  direct: boolean;
  /** The kept history's carry entry for this flow has been applied. */
  carried: boolean;
}
const NO_PRE: PreWatermark = { key: null, up: 0, down: 0, counted: false, blocked: null, direct: false, carried: false };
type Seen = { up: number; down: number; flows: number; blocked: number };

interface FlowEntry {
  rec: FlowRecord;
  pre: PreWatermark;
  tOpen: number;
  lastT: number;
  lastActivityAt: number;
  state: NetState;
  flags: FlowFlags;
  destKey: string | null;
  groupKey: string;
  spark: Map<number, RateBucket>;
}

interface AggEntry {
  agg: Omit<DestinationAggregate, 'state' | 'spark' | 'policy' | 'geoIp' | 'geo'>;
  /** Open flows and their current states: open flows are never evicted. */
  open: Map<string, NetState>;
  /** The flow with the latest `t_open`, and its state. */
  latest: { id: string; tOpen: number; state: NetState } | null;
  spark: Map<number, RateBucket>;
  /** Source of `DestinationAggregate.geoIp`, with its flow's `t_open` (earliest wins). */
  geoIp: { ip: string; tOpen: number } | null;
}

/** A gate process, keyed by its `run` id (glove's record contract). */
interface RunState {
  service: string | null;
  ended: boolean;
}

interface SessionData {
  loc: NetSessionLocation;
  /** What glove says about it (`setGlove`), for the picker. */
  glove: NetGloveInfo;
  /** The last filter grant's `since` Layman saw (`history.ts`): what makes a revocation visible. */
  filterSince: string | null;
  /** Whether the control directory was seen under that grant (`history.ts`). */
  filterSawDir: boolean;
  /** What Layman kept from before this process, and its destinations by key. */
  history: { s: HistorySession; dests: Map<string, HistoryDest> } | null;
  /** No files: shown from `history` alone. */
  historyOnly: boolean;
  /** Session-wide sum of what re-read records up to the watermark contributed. */
  seen: { up: number; down: number; flows: number; guard: number; userRule: number; def: number; direct: number };
  /** The same per destination key, by the key each flow had at the watermark. */
  seenByKey: Map<string, Seen>;
  runs: Map<string, RunState>;
  /** The latest run seen per service: a newer one means the forwarder restarted. */
  serviceRun: Map<string, string>;
  /** Traffic per hour per destination, by `hourKey` (`HistoryHour`), and those changed since the last save. */
  hours: Map<string, HistoryHour>;
  dirtyHours: Set<string>;
  /** The collector's runs (`HistoryRun`): one per `glove up`. `runOrder` is them by start, for `runAt`. */
  gateRuns: Map<string, HistoryRun>;
  runOrder: HistoryRun[] | null;
  flows: Map<string, FlowEntry>;
  /** Closed flow ids, oldest close first, for eviction. */
  closedOrder: string[];
  aggs: Map<string, AggEntry>;
  seconds: Map<number, RateBucket>;
  minutes: Map<number, RateBucket>;
  status: StatusRecord | null;
  statusMtimeMs: number | null;
  session: NetSessionFile | null;
  /** The services `session` makes hops (`isHopService`), kept with it: asked once per flow record. */
  hopServices: ReadonlySet<string>;
  exits: ExitRecord[];
  rules: RulesView;
  counters: NetCounters;
  historyTruncated: boolean;
  bytesUp: number;
  bytesDown: number;
  flowCount: number;
  stateCounts: Map<NetState, number>;
  directFlows: number;
  firstSeen: number | null;
  /** Latest record time. Sparklines anchor here, so a stopped gate's sparklines freeze rather than drain. */
  lastT: number | null;
  gate: NetGateView;
  /** The exit IP the last `gateSince` saw, to tell a new exit from the same one. */
  sinceExitIp: string | null;
  /** The collector run the last `gateSince` saw: a new one is a new `glove up`. */
  sinceRunId: string | null;
  /** The enforced rule set and the one on disk, for each destination's predicted policy. */
  policy: { enforced: RuleSet | null; written: RuleSet | null };
  dirtyFlows: Set<string>;
  dirtyAggs: Set<string>;
  removedAggs: Set<string>;
  dirtyBuckets: Set<number>;
  dirtyTotals: boolean;
}

export interface NetStoreOptions {
  /** Applied to `request.url` and header values (record: full). */
  stringFilter?: (text: string) => string;
  /** Offline geolocation of an IP (`geo.ts`), or null when there is no database. */
  geolocate?: (ip: string) => GeoPoint | null;
  maxClosedFlows?: number;
}

/**
 * A destination's aggregate key: lower-cased `host:port`, or `@service` when there is no host.
 * Persisted history reloads under it too (persist.ts), or a host with capitals would reload as a
 * second, history-only destination beside the live one and its traffic would count twice.
 */
export function destKey(host: string | null, port: number | null, service: string): string {
  return host === null ? `@${service}` : `${host.toLowerCase()}:${port ?? 0}`;
}

function destKeyFor(rec: FlowRecord): string {
  return destKey(rec.dest.host, rec.dest.port, rec.service);
}

function inc<K>(m: Map<K, number>, k: K, by: number): void {
  const v = (m.get(k) ?? 0) + by;
  if (v === 0) m.delete(k);
  else m.set(k, v);
}

function addBucket(m: Map<number, RateBucket>, t: number, up: number, down: number): RateBucket {
  const b = m.get(t) ?? { t, up: 0, down: 0 };
  b.up += up;
  b.down += down;
  m.set(t, b);
  return b;
}

/** A sparkline's buckets: the last `SPARK_SPAN` before the session's latest record, oldest first. */
function sparkWindow(m: Map<number, RateBucket>, lastT: number | null): RateBucket[] {
  const from = (lastT ?? 0) - SPARK_SPAN;
  return [...m.values()].filter((b) => b.t > from).sort((a, b) => a.t - b.t).map((b) => ({ ...b }));
}

function pushUnique(list: string[], v: string | null | undefined, max = Infinity): void {
  if (v && !list.includes(v)) {
    list.push(v);
    if (list.length > max) list.shift();
  }
}

/** A destination's predicted verdict under the enforced rule set and the one on disk. */
function policyFor(
  policy: SessionData['policy'], facts: FlowFacts, gate: GateFacts, lanOnly = false,
): { enforced: PolicyVerdict | null; written: PolicyVerdict | null } {
  const one = (set: RuleSet | null): PolicyVerdict | null => {
    if (!set) return null;
    const v = predict(set, facts, gate);
    // On a corporate route an allow only reaches the corporate proxy, whose allowlist decides.
    return {
      action: v.action, rule: v.rule,
      ...(gate.corporate && v.action === 'allow' ? { allowlist: true } : {}),
      // `--lan-only` decides at connect time, on a resolution Layman never sees: not predicted.
      ...(lanOnly ? { lanOnly: true } : {}),
    };
  };
  return { enforced: one(policy.enforced), written: one(policy.written) };
}

/** A destination's flags from its latest flow's: unresolved only while no flow brought an IP. */
const destFlags = (f: FlowFlags, ips: readonly string[]): FlowFlags => ({ ...f, unresolved: f.unresolved && ips.length === 0 });

export class NetStore extends EventEmitter {
  private sessions = new Map<string, SessionData>();
  private readonly stringFilter?: (text: string) => string;
  private readonly geolocate?: (ip: string) => GeoPoint | null;
  private readonly maxClosedFlows: number;

  constructor(opts: NetStoreOptions = {}) {
    super();
    this.stringFilter = opts.stringFilter;
    this.geolocate = opts.geolocate;
    this.maxClosedFlows = opts.maxClosedFlows ?? DEFAULT_MAX_CLOSED_FLOWS;
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  has(token: string): boolean {
    return this.sessions.has(token);
  }

  tokens(): string[] {
    return [...this.sessions.keys()];
  }

  location(token: string): NetSessionLocation | null {
    return this.sessions.get(token)?.loc ?? null;
  }

  ensure(loc: NetSessionLocation): void {
    if (this.sessions.has(loc.token)) return;
    this.sessions.set(loc.token, {
      loc,
      glove: { ...UNKNOWN_GLOVE },
      filterSince: null,
      filterSawDir: false,
      history: null,
      historyOnly: false,
      seen: { up: 0, down: 0, flows: 0, guard: 0, userRule: 0, def: 0, direct: 0 },
      seenByKey: new Map(),
      runs: new Map(),
      serviceRun: new Map(),
      hours: new Map(),
      dirtyHours: new Set(),
      gateRuns: new Map(),
      runOrder: null,
      flows: new Map(),
      closedOrder: [],
      aggs: new Map(),
      seconds: new Map(),
      minutes: new Map(),
      status: null,
      statusMtimeMs: null,
      session: null,
      hopServices: new Set(),
      exits: [],
      rules: blankRulesView(loc),
      policy: { enforced: null, written: null },
      counters: { records: 0, invalid: 0, skipped: 0, gaps: 0 },
      historyTruncated: false,
      bytesUp: 0,
      bytesDown: 0,
      flowCount: 0,
      stateCounts: new Map(),
      directFlows: 0,
      firstSeen: null,
      lastT: null,
      gate: classifySession({ status: null, statusMtimeMs: null, exit: null, session: null }, Date.now()),
      sinceExitIp: null,
      sinceRunId: null,
      dirtyFlows: new Set(),
      dirtyAggs: new Set(),
      removedAggs: new Set(),
      dirtyBuckets: new Set(),
      dirtyTotals: false,
    });
  }

  remove(token: string): void {
    this.sessions.delete(token);
  }

  /**
   * What Layman kept for a session (`history.ts`). Call before its files are
   * read: the watermark decides which re-read records the kept totals hold.
   * A session with no files yet is created, history only.
   */
  setHistory(h: HistorySession, now = Date.now()): void {
    if (!this.sessions.has(h.token)) {
      this.ensure({ token: h.token, netDir: '', controlDir: '', rulesPath: '' });
      const s = this.sessions.get(h.token)!;
      s.historyOnly = true;
      // Nothing to write to: every toggle and the Rules panel say why.
      s.rules = { ...s.rules, control: { state: 'disabled', detail: 'History only: glove’s files for this session are gone, so there are no rules to change.' } };
      this.useSessionFile(s, h.sessionFile);
      if (h.lastExit) s.exits.push(h.lastExit);
      s.status = h.lastStatus;
      // Its runs first: the gate's "since" is dated from them (a stopped gate since its run's stop).
      for (const r of h.runs ?? []) s.gateRuns.set(r.run, { ...r });
      s.runOrder = null;
      this.refreshGate(s, now, false);
    }
    const s = this.sessions.get(h.token)!;
    if (s.filterSince === null) {
      s.filterSince = h.filterSince;
      s.filterSawDir = h.filterSawDir;
    }
    if (s.counters.records > 0) return; // too late to tell re-read records from new ones
    s.history = { s: h, dests: new Map(h.destinations.map((d) => [d.key, d])) };
    for (const hr of h.hours ?? []) s.hours.set(hourKey(hr.hour, hr.run, hr.key, hr.tool), { ...hr });
    for (const r of h.runs ?? []) s.gateRuns.set(r.run, { ...r });
    s.runOrder = null;
  }

  /** A history-only session whose files have (re)appeared. */
  relocate(loc: NetSessionLocation): void {
    const s = this.sessions.get(loc.token);
    if (!s) return;
    s.loc = loc;
    s.historyOnly = false;
    s.rules = blankRulesView(loc);
    // The gate view it kept describes the past: start again, so its "since" is read from the
    // records about to be re-read rather than dated as changes seen now.
    s.gate = classifySession({ status: null, statusMtimeMs: null, exit: null, session: null }, Date.now());
    s.sinceExitIp = null;
    s.sinceRunId = null;
  }

  /** What glove says about a session now (discovery, every poll). */
  setGlove(token: string, glove: NetGloveInfo): void {
    const s = this.sessions.get(token);
    if (s) s.glove = glove;
  }

  /**
   * Remember the filter grant's `since` while it is granted, and whether its control directory
   * is there. A new `since` is a re-grant whose directory glove has not made yet, so it starts
   * unseen. Returns true when the directory went away under the same grant: a revocation.
   */
  noteFilterGrant(token: string, since: string, dirPresent: boolean): boolean {
    const s = this.sessions.get(token);
    if (!s) return false;
    if (s.filterSince !== since) {
      s.filterSince = since;
      s.filterSawDir = false;
    }
    if (dirPresent) s.filterSawDir = true;
    return !dirPresent && s.filterSawDir;
  }

  /** The last filter grant Layman saw for this session, from this process or kept history (`setHistory` folds it in). */
  filterSince(token: string): string | null {
    return this.sessions.get(token)?.filterSince ?? null;
  }

  isHistoryOnly(token: string): boolean {
    return this.sessions.get(token)?.historyOnly ?? false;
  }

  // ─── Ingest ───────────────────────────────────────────────────────────────

  /** One flow record, in file order. Emits `changed`. */
  ingestFlow(token: string, rec: FlowRecord, now = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.counters.records++;
    const t = Date.parse(rec.t);
    const prev = s.flows.get(rec.id);
    if (rec.run) this.noteRun(s, rec.run, rec.service, now);

    // bytes are cumulative (rule 1): the flow's total is its latest record's,
    // and the rate is the difference. Taking the max keeps a stray older record
    // from ever running a total backwards.
    const before = prev ? prev.rec.bytes : { up: 0, down: 0 };
    const bytes = { up: Math.max(before.up, rec.bytes.up), down: Math.max(before.down, rec.bytes.down) };
    const dUp = bytes.up - before.up;
    const dDown = bytes.down - before.down;

    // The latest record decides everything else, including `dest` (rule 2) —
    // except that a close is final, and an older record never overrides a newer.
    const newer = !prev || (t >= prev.lastT && !(prev.rec.phase === 'close' && rec.phase !== 'close'));
    const latest: FlowRecord = newer ? { ...rec, bytes } : { ...prev!.rec, bytes };
    const tOpen = Date.parse(latest.t_open);
    const entry: FlowEntry = {
      rec: latest,
      pre: prev?.pre ?? NO_PRE,
      tOpen: Number.isFinite(tOpen) ? tOpen : t,
      lastT: prev ? Math.max(prev.lastT, t) : t,
      lastActivityAt: dUp || dDown || !prev ? Math.max(prev?.lastActivityAt ?? 0, t) : prev.lastActivityAt,
      state: 'active',
      flags: flowFlags(latest, this.isHop(s, latest.service)),
      destKey: null,
      groupKey: groupKeyFor(latest.dest.host, latest.service),
      spark: prev?.spark ?? new Map(),
    };
    entry.state = this.classify(s, entry, now);
    entry.destKey = entry.state === 'empty' ? null : destKeyFor(latest);
    if (s.history) {
      const { watermark, carry } = s.history.s;
      const c = carry[rec.id];
      // Before the watermark: the kept rows hold it. At or after it: only what a carried flow held.
      if (t < watermark) this.countPre(s, entry, bytes);
      else if (c && !entry.pre.carried) this.carryPre(s, entry, c);
    }

    this.apply(s, rec.id, prev ?? null, entry);
    this.credit(s, rec, entry, prev, t, before, bytes);

    if (dUp || dDown) {
      const sec = Math.floor(t / SECOND) * SECOND;
      addBucket(entry.spark, sec, dUp, dDown);
      if (entry.destKey) {
        const agg = s.aggs.get(entry.destKey);
        if (agg) addBucket(agg.spark, sec, dUp, dDown);
      }
      // A hop's bytes are the next leg's too (the llm hop and llm-upstream carry one
      // request): the session counts them once, at the leg that reaches the destination.
      if (!entry.flags.hop) {
        addBucket(s.seconds, sec, dUp, dDown);
        s.dirtyBuckets.add(sec);
        s.bytesUp += dUp;
        s.bytesDown += dDown;
      }
    }
    if (s.firstSeen === null || entry.tOpen < s.firstSeen) s.firstSeen = entry.tOpen;
    if (s.lastT === null || t > s.lastT) s.lastT = t;
    if (!prev) s.flowCount++;
    if (latest.phase === 'close' && prev?.rec.phase !== 'close') {
      s.closedOrder.push(rec.id);
      this.evict(s);
    }
    s.dirtyTotals = true;
    this.emit('changed', token);
  }

  /**
   * Count a flow record into its hour (of its collector run). The kept hours already hold every
   * record before the watermark, so those are skipped; a carried flow (`CarryFlow`) counts only
   * what it moved beyond what the kept rows held for it; and a record in the watermark's own
   * millisecond that is not carried was not read then, so it is new. Kept history from before
   * the hours existed (no `hours`) holds none of them: everything read is counted.
   */
  private credit(
    s: SessionData, rec: FlowRecord, entry: FlowEntry, prev: FlowEntry | undefined, t: number,
    before: { up: number; down: number }, bytes: { up: number; down: number },
  ): void {
    const kept = s.history?.s.hours !== undefined ? s.history.s : null;
    if (kept && t < kept.watermark) return;
    const c = kept?.carry[rec.id];
    const up = Math.max(0, bytes.up - Math.max(before.up, c?.up ?? 0));
    const down = Math.max(0, bytes.down - Math.max(before.down, c?.down ?? 0));
    const opened = !prev && !c;
    const refused = BLOCK_STATES.has(entry.state) && !(prev && BLOCK_STATES.has(prev.state)) && !c?.blocked;
    const key = entry.destKey;
    if (!key || (!up && !down && !opened && !refused)) return;

    const run = this.runAt(s, t)?.run ?? null;
    const hour = Math.floor(t / HOUR) * HOUR;
    const tool = entry.rec.tool;
    const k = hourKey(hour, run, key, tool);
    const h = s.hours.get(k) ?? {
      hour, run, key, tool, hop: entry.flags.hop, bytesUp: 0, bytesDown: 0, flows: 0, blocked: 0, blockedGuard: 0, blockedRule: 0, direct: 0, first: t, last: t,
    };
    h.bytesUp += up;
    h.bytesDown += down;
    h.flows += opened ? 1 : 0;
    h.blocked += refused ? 1 : 0;
    h.blockedGuard += refused && entry.state === 'guard' ? 1 : 0;
    h.blockedRule += refused && entry.state === 'user_rule' ? 1 : 0;
    h.direct += opened && entry.flags.scope === 'direct' ? 1 : 0;
    h.hop = entry.flags.hop;
    h.first = Math.min(h.first, t);
    h.last = Math.max(h.last, t);
    s.hours.set(k, h);
    s.dirtyHours.add(k);
  }

  /**
   * The collector run a record at `t` belongs to: the latest started at or before it, unless that
   * one had stopped by then (a gap between runs). Forwarders' last records trail the collector's
   * stop by moments, hence the grace.
   */
  private runAt(s: SessionData, t: number): HistoryRun | null {
    let found: HistoryRun | null = null;
    for (const r of this.runsByStart(s)) {
      if (r.started > t) break;
      found = r;
    }
    return found && (found.ended === null || t <= found.ended + RUN_STOP_GRACE_MS) ? found : null;
  }

  /** The collector's runs by start (`runOrder`, rebuilt when a run is added or starts earlier). */
  private runsByStart(s: SessionData): HistoryRun[] {
    return (s.runOrder ??= [...s.gateRuns.values()].sort((a, b) => a.started - b.started));
  }

  /** A record from before the kept watermark: the kept rows hold it, under the flow's key then. */
  private countPre(s: SessionData, entry: FlowEntry, bytes: { up: number; down: number }): void {
    const was = entry.pre;
    this.setPre(s, entry, {
      key: entry.destKey,
      up: Math.max(was.up, bytes.up),
      down: Math.max(was.down, bytes.down),
      counted: true,
      blocked: was.blocked ?? (BLOCK_STATES.has(entry.state) ? entry.state : null),
      direct: was.direct || entry.flags.scope === 'direct',
      carried: false,
    });
  }

  /** A carried flow (`CarryFlow`) reached the watermark: the kept rows hold exactly what it held there. */
  private carryPre(s: SessionData, entry: FlowEntry, c: CarryFlow): void {
    const was = entry.pre;
    this.setPre(s, entry, {
      key: c.key,
      up: Math.max(was.up, c.up),
      down: Math.max(was.down, c.down),
      counted: true,
      blocked: c.blocked ?? was.blocked,
      direct: c.direct || was.direct,
      carried: true,
    });
  }

  private setPre(s: SessionData, entry: FlowEntry, pre: PreWatermark): void {
    const was = entry.pre;
    // The session totals leave a hop's bytes out (`ingestFlow`), so what they kept does too.
    if (!entry.flags.hop) {
      s.seen.up += pre.up - was.up;
      s.seen.down += pre.down - was.down;
    }
    if (!was.counted) s.seen.flows++;
    if (!was.direct && pre.direct) s.seen.direct++;
    const cat = (b: NetState | null) => (b === 'guard' ? 'guard' : b === 'user_rule' ? 'userRule' : b ? 'def' : null);
    if (cat(was.blocked) !== cat(pre.blocked)) {
      if (cat(was.blocked)) s.seen[cat(was.blocked)!]--;
      if (cat(pre.blocked)) s.seen[cat(pre.blocked)!]++;
    }
    const move = (p: PreWatermark, sign: 1 | -1) => {
      if (!p.key) return;
      const k = s.seenByKey.get(p.key) ?? { up: 0, down: 0, flows: 0, blocked: 0 };
      k.up += sign * p.up;
      k.down += sign * p.down;
      k.flows += sign * (p.counted ? 1 : 0);
      k.blocked += sign * (p.blocked ? 1 : 0);
      s.seenByKey.set(p.key, k);
    };
    move(was, -1);
    move(pre, 1);
    entry.pre = pre;
  }

  /** The service glove declared under `name` for a session, if any. */
  private declared(s: SessionData, name: string | null): NetService | undefined {
    return name ? s.session?.services?.find((sv) => sv.service === name) : undefined;
  }

  /** Sets the session file and the hop services it implies; true when those changed. */
  private useSessionFile(s: SessionData, file: NetSessionFile | null): boolean {
    s.session = file;
    const services = file?.services ?? [];
    const hops = new Set(services.filter((sv) => isHopService(sv, services)).map((sv) => sv.service));
    const changed = hops.size !== s.hopServices.size || [...hops].some((h) => !s.hopServices.has(h));
    s.hopServices = hops;
    return changed;
  }

  /** The service's traffic goes on through another gate (`isHopService`): its flows are hops. */
  private isHop(s: SessionData, service: string): boolean {
    return s.hopServices.has(service);
  }

  /**
   * session.json changed which services are hops (it was missing or unreadable when
   * their flows were read, or glove rewrote `next` or `observed`): re-flag the stored
   * flows, moving their bytes out of the totals or back in, so a flow is never counted
   * at both legs or at neither. The 1 s rate buckets still held are moved too; what
   * was already folded into 1 min buckets stays as it was counted.
   */
  private reflagHops(s: SessionData): boolean {
    let changed = false;
    const flipped = new Map<string, boolean>();
    const cutoff = (s.lastT ?? 0) - SECOND_BUCKET_SPAN;
    for (const [id, e] of s.flows) {
      const hop = this.isHop(s, e.rec.service);
      if (hop === e.flags.hop) continue;
      const sign = hop ? -1 : 1;
      s.bytesUp += sign * e.rec.bytes.up;
      s.bytesDown += sign * e.rec.bytes.down;
      // What the kept rows hold for it (`setPre`) follows the same rule.
      s.seen.up += sign * e.pre.up;
      s.seen.down += sign * e.pre.down;
      for (const [t, b] of e.spark) {
        if (t < cutoff) continue;
        addBucket(s.seconds, t, sign * b.up, sign * b.down);
        s.dirtyBuckets.add(t);
      }
      e.flags = flowFlags(e.rec, hop);
      s.dirtyFlows.add(id);
      // A destination's flags are its latest flow's (`apply`), and that flow's service flips with this one's.
      const agg = e.destKey ? s.aggs.get(e.destKey) : undefined;
      if (agg?.latest?.id === id) {
        agg.agg.flags = destFlags(e.flags, agg.agg.ips);
        s.dirtyAggs.add(e.destKey!);
      }
      if (e.destKey) flipped.set(e.destKey, hop);
      changed = true;
    }
    // The hours follow: a hop is a property of the service, so every hour of the destination flips with it.
    for (const [k, h] of s.hours) {
      const hop = flipped.get(h.key);
      if (hop === undefined || h.hop === hop) continue;
      h.hop = hop;
      s.dirtyHours.add(k);
    }
    return changed;
  }

  private classify(s: SessionData, e: FlowEntry, now: number): NetState {
    const run = e.rec.run ? s.runs.get(e.rec.run) : undefined;
    return classifyFlow({ ...e.rec, lastActivityAt: e.lastActivityAt, runEnded: run?.ended === true }, now);
  }

  /**
   * glove's gate lifecycle, read in file order (glove's record contract; this is
   * a port of glove's reference `ended_runs`, `extensions/observe/netview.py`, and must stay one).
   * A run ends at a `stop` for it, or when a later run appears for the same
   * service (the forwarder restarted); any later record of the run itself
   * revives it. A `stop` ends only its own run and never displaces the service's
   * current one: the collector's inferred stop for a crashed run can land after
   * its restarted replacement's `start`. Collector records (`role: "collect"`)
   * say nothing about forwarders and are skipped.
   */
  ingestGate(token: string, rec: GateRecord, now = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.counters.records++;
    if (rec.role === 'collect') this.noteGateRun(s, rec);
    if (rec.role !== 'forward') return;
    if (rec.event === 'stop') {
      if (!s.runs.has(rec.run)) s.runs.set(rec.run, { service: rec.service, ended: false });
      this.setRunEnded(s, rec.run, true, now);
    } else {
      this.noteRun(s, rec.run, rec.service, now);
    }
    this.emit('changed', token);
  }

  /**
   * A collector record: when a `glove up` started and stopped. Taking the earliest start and the
   * latest stop makes reading a record twice (a restart, a range) change nothing.
   */
  private noteGateRun(s: SessionData, rec: GateRecord): void {
    const t = Date.parse(rec.t);
    const known = s.gateRuns.get(rec.run);
    const r = known ?? { run: rec.run, started: t, ended: null, inferred: false };
    r.started = Math.min(r.started, t);
    if (rec.event === 'stop') {
      if (r.ended === null || t >= r.ended) r.inferred = rec.inferred;
      r.ended = Math.max(r.ended ?? t, t);
    }
    if (!known || r.started !== known.started) s.runOrder = null;
    s.gateRuns.set(rec.run, r);
  }

  /** A forwarder record (a `start`, or any flow record) of `run`: it is alive, and its service's current run. */
  private noteRun(s: SessionData, run: string, service: string | null, now: number): void {
    const known = s.runs.get(run);
    if (!known) s.runs.set(run, { service, ended: false });
    else if (known.ended) this.setRunEnded(s, run, false, now);
    if (service === null) return;
    const previous = s.serviceRun.get(service);
    s.serviceRun.set(service, run);
    if (previous && previous !== run) this.setRunEnded(s, previous, true, now);
  }

  /** Mark a run ended (or revived) and re-classify its unclosed flows. */
  private setRunEnded(s: SessionData, run: string, ended: boolean, now: number): void {
    const r = s.runs.get(run);
    if (!r || r.ended === ended) return;
    r.ended = ended;
    for (const [id, e] of s.flows) {
      if (e.rec.run !== run || e.rec.phase === 'close') continue;
      const state = this.classify(s, e, now);
      if (state !== e.state) this.apply(s, id, e, { ...e, state });
    }
    s.dirtyTotals = true;
  }

  /**
   * Move a flow from its previous contribution to its new one: session state
   * counts, and the destination aggregate(s) it counts toward.
   */
  private apply(s: SessionData, id: string, prev: FlowEntry | null, next: FlowEntry): void {
    if (prev) {
      inc(s.stateCounts, prev.state, -1);
      if (prev.flags.scope === 'direct') s.directFlows--;
    }
    inc(s.stateCounts, next.state, 1);
    if (next.flags.scope === 'direct') s.directFlows++;

    if (prev?.destKey) this.unaggregate(s, id, prev, prev.destKey !== next.destKey);
    if (next.destKey) this.aggregate(s, id, next);
    s.flows.set(id, next);
    s.dirtyFlows.add(id);
  }

  private unaggregate(s: SessionData, id: string, prev: FlowEntry, moving: boolean): void {
    const e = s.aggs.get(prev.destKey!);
    if (!e) return;
    e.agg.bytesUp -= prev.rec.bytes.up;
    e.agg.bytesDown -= prev.rec.bytes.down;
    e.agg.flows--;
    if (BLOCK_STATES.has(prev.state)) {
      e.agg.blocked--;
      const k = prev.rec.rule ?? '';
      if (--e.agg.blockedBy[k] <= 0) delete e.agg.blockedBy[k];
    }
    e.open.delete(id);
    if (moving) {
      if (e.latest?.id === id) e.latest = null;
      s.dirtyAggs.add(prev.destKey!);
      if (e.agg.flows <= 0) {
        s.aggs.delete(prev.destKey!);
        s.dirtyAggs.delete(prev.destKey!);
        s.removedAggs.add(prev.destKey!);
      }
    }
  }

  private aggregate(s: SessionData, id: string, next: FlowEntry): void {
    const key = next.destKey!;
    let e = s.aggs.get(key);
    const r = next.rec;
    if (!e) {
      const service = (s.session?.services ?? []).find((sv) => sv.service === r.service);
      e = {
        agg: {
          key,
          host: r.dest.host,
          port: r.dest.port,
          groupKey: next.groupKey,
          endpoint: r.dest.host === null ? service?.listen ?? r.service : null,
          ips: [],
          services: [],
          tools: [],
          clients: [],
          scope: r.scope,
          resolution: r.dest.resolution,
          bytesUp: 0,
          bytesDown: 0,
          flows: 0,
          openFlows: 0,
          blocked: 0,
          firstSeen: next.tOpen,
          lastSeen: next.lastT,
          rule: null,
          blockedBy: {},
          flags: next.flags,
        },
        open: new Map(),
        latest: null,
        spark: new Map(),
        geoIp: null,
      };
      s.aggs.set(key, e);
      s.removedAggs.delete(key);
    }
    const a = e.agg;
    a.bytesUp += r.bytes.up;
    a.bytesDown += r.bytes.down;
    a.flows++;

    if (BLOCK_STATES.has(next.state)) {
      a.blocked++;
      a.blockedBy[r.rule ?? ''] = (a.blockedBy[r.rule ?? ''] ?? 0) + 1;
      if (r.rule !== null || next.state === 'default_block') a.rule = r.rule;
    }
    if (r.phase !== 'close') e.open.set(id, next.state);
    a.openFlows = e.open.size;
    pushUnique(a.ips, r.dest.ip, MAX_IPS);
    if (r.dest.ip && mayGeolocate(r.dest.resolution) && (e.geoIp === null || next.tOpen < e.geoIp.tOpen)) {
      e.geoIp = { ip: r.dest.ip, tOpen: next.tOpen };
    }
    pushUnique(a.services, r.service);
    pushUnique(a.tools, r.tool);
    pushUnique(a.clients, r.client);
    a.firstSeen = Math.min(a.firstSeen, next.tOpen);
    a.lastSeen = Math.max(a.lastSeen, next.lastT);
    if (!e.latest || e.latest.id === id || next.tOpen >= e.latest.tOpen) {
      e.latest = { id, tOpen: next.tOpen, state: next.state };
      a.scope = r.scope;
      a.resolution = r.dest.resolution;
      a.flags = destFlags(next.flags, a.ips);
    }
    s.dirtyAggs.add(key);
  }

  private evict(s: SessionData): void {
    while (s.closedOrder.length > this.maxClosedFlows) {
      const id = s.closedOrder.shift()!;
      s.flows.delete(id);
    }
  }

  ingestExit(token: string, rec: ExitRecord, now = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.counters.records++;
    s.exits.push(rec);
    if (s.exits.length > MAX_EXITS) s.exits.shift();
    this.refreshGate(s, now, true);
    this.emit('exit', token);
  }

  setStatus(token: string, status: StatusRecord | null, mtimeMs: number | null, now = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.status = status;
    s.statusMtimeMs = mtimeMs;
    this.refreshGate(s, now, true);
  }

  setSessionFile(token: string, file: NetSessionFile | null, now = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s) return;
    if (this.useSessionFile(s, file) && this.reflagHops(s)) {
      s.dirtyTotals = true;
      this.emit('changed', token);
    }
    this.refreshGate(s, now, true);
  }

  setRules(token: string, rules: RulesView): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.rules = rules;
    this.emit('rules', token);
  }

  /** The geolocation database changed: every destination's location may have, so all are re-sent. */
  refreshGeo(): void {
    for (const [token, s] of this.sessions) {
      for (const k of s.aggs.keys()) s.dirtyAggs.add(k);
      this.emit('changed', token);
    }
  }

  /** New rule sets: every destination's predicted policy may change, so all are re-sent. */
  setPolicy(token: string, policy: { enforced: RuleSet | null; written: RuleSet | null }): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.policy = policy;
    for (const k of s.aggs.keys()) s.dirtyAggs.add(k);
    this.emit('changed', token);
  }

  noteRead(token: string, info: { invalid?: number; skipped?: number; gaps?: number; historyTruncated?: boolean }): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.counters.invalid += info.invalid ?? 0;
    s.counters.skipped += info.skipped ?? 0;
    s.counters.gaps += info.gaps ?? 0;
    if (info.historyTruncated) s.historyTruncated = true;
    if (info.invalid || info.skipped || info.gaps) s.dirtyTotals = true;
  }

  // ─── Time ─────────────────────────────────────────────────────────────────

  /**
   * Re-classify what depends on the clock — an open flow going idle, a gate
   * heartbeat going stale — and fold old 1 s buckets into minutes.
   */
  tick(now = Date.now()): void {
    for (const [token, s] of this.sessions) {
      let changed = false;
      for (const [id, e] of s.flows) {
        if (e.rec.phase === 'close') continue;
        const state = this.classify(s, e, now);
        if (state === e.state) continue;
        this.apply(s, id, e, { ...e, state });
        changed = true;
      }
      this.compact(s);
      this.refreshGate(s, now, false);
      if (changed) {
        s.dirtyTotals = true;
        this.emit('changed', token);
      }
    }
  }

  private compact(s: SessionData): void {
    if (s.lastT === null) return;
    const cutoff = s.lastT - SECOND_BUCKET_SPAN;
    for (const [t, b] of s.seconds) {
      if (t >= cutoff) continue;
      addBucket(s.minutes, Math.floor(t / MINUTE) * MINUTE, b.up, b.down);
      s.seconds.delete(t);
    }
    const sparkCutoff = s.lastT - 2 * SPARK_SPAN;
    for (const e of s.aggs.values()) {
      for (const t of e.spark.keys()) if (t < sparkCutoff) e.spark.delete(t);
    }
    for (const e of s.flows.values()) {
      for (const t of e.spark.keys()) if (t < sparkCutoff) e.spark.delete(t);
    }
  }

  /** Emits `status` when the gate view changed in a way the UI shows. */
  private refreshGate(s: SessionData, now: number, force: boolean): void {
    const next = classifySession(
      { status: s.status, statusMtimeMs: s.statusMtimeMs, exit: s.exits[s.exits.length - 1] ?? null, session: s.session },
      now,
    );
    const prev = s.gate;
    const runs = this.runsByStart(s);
    const run = runs.at(-1) ?? null;
    const beat = s.status?.t ? Date.parse(s.status.t) : s.statusMtimeMs;
    next.since = gateSince(prev, next, {
      exits: s.exits, run: run && { id: run.run, started: run.started, ended: run.ended }, prevExitIp: s.sinceExitIp, prevRunId: s.sinceRunId,
    }, beat ?? null, now);
    s.sinceExitIp = s.exits.at(-1)?.ip ?? null;
    s.sinceRunId = run?.run ?? null;
    s.gate = next;
    if (force || prev.freshness !== next.freshness) this.emit('status', s.loc.token);
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  private flowView(s: SessionData, id: string, e: FlowEntry): FlowView {
    const r = e.rec;
    let request = r.request;
    if (request && this.stringFilter) {
      const f = this.stringFilter;
      request = {
        method: request.method,
        url: request.url === null ? null : f(request.url),
        ...(request.headers
          ? { headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, f(v)])) }
          : {}),
      };
    }
    return {
      id,
      phase: r.phase,
      tOpen: e.tOpen,
      tClose: r.t_close ? Date.parse(r.t_close) : null,
      lastT: e.lastT,
      lastActivityAt: e.lastActivityAt,
      service: r.service,
      tool: r.tool,
      client: r.client,
      proto: r.proto,
      dest: r.dest,
      scope: r.scope,
      route: r.route,
      bytes: r.bytes,
      verdict: r.verdict,
      rule: r.rule,
      closeReason: r.close_reason,
      request,
      state: e.state,
      flags: e.flags,
      destKey: e.destKey,
      groupKey: e.groupKey,
      spark: sparkWindow(e.spark, s.lastT),
    };
  }

  private aggView(s: SessionData, e: AggEntry): DestinationAggregate {
    const states = [...e.open.values()];
    if (e.latest) states.unshift(e.latest.state);
    const a = this.withHistory(e.agg, this.kept(s, e.agg.key));
    const facts = {
      host: a.host, ip: a.ips[0] ?? null, port: a.port, service: a.services[0] ?? null, tool: a.tools[0] ?? null, scope: a.scope,
    };
    const gate = { proxy: this.viaProxy(s, a.services[0] ?? null, a.resolution), resolution: a.resolution, corporate: this.corporate(s, a.services[0] ?? null) };
    return {
      ...a,
      policy: policyFor(s.policy, facts, gate, Object.keys(a.blockedBy).some(isLanOnlyRule) || isLanOnlyRule(a.rule)),
      // Only an IP glove resolved inside the tunnel (or a literal), never a local link or a hop.
      geoIp: e.geoIp?.ip ?? null,
      geo: this.geolocate && e.geoIp && !offMap(a) ? this.geolocate(e.geoIp.ip) : null,
      // A flow whose gate went away is unclosed but not open in any sense the UI means.
      openFlows: [...e.open.values()].filter((st) => st !== 'gate_lost').length,
      ips: [...a.ips],
      blockedBy: { ...a.blockedBy },
      services: [...a.services],
      tools: [...a.tools],
      clients: [...a.clients],
      state: aggregateState(states),
      spark: sparkWindow(e.spark, s.lastT),
    };
  }

  /**
   * Whether a destination came through an `http-proxy` listener, where glove's guard runs.
   * The declared service says so; without one (a history-only destination), the resolution
   * does: only a proxy destination is ever `unavailable` or `in-tunnel` (`ForwardSpec.display_ip`).
   */
  private viaProxy(s: SessionData, service: string | null, resolution: string | null): GateFacts['proxy'] {
    const declared = this.declared(s, service);
    if (declared?.mode) return declared.mode === 'http-proxy';
    return resolution === 'unavailable' || resolution === 'in-tunnel';
  }

  /**
   * Whether a destination went out through glove's `corporate` egress: its service's
   * declared route, or, without one, the session's `upstream_kind`.
   */
  private corporate(s: SessionData, service: string | null): boolean {
    const declared = this.declared(s, service);
    if (declared?.route) return declared.route.kind === 'corporate';
    return s.session?.upstream_kind === 'corporate';
  }

  /** What the kept history holds for a destination beyond what the files re-read: kept − seen. Null when nothing. */
  private kept(s: SessionData, key: string): { h: HistoryDest; c: Seen } | null {
    const h = s.history?.dests.get(key);
    if (!h) return null;
    const seen = s.seenByKey.get(key) ?? { up: 0, down: 0, flows: 0, blocked: 0 };
    const c = {
      up: Math.max(0, h.bytesUp - seen.up),
      down: Math.max(0, h.bytesDown - seen.down),
      flows: Math.max(0, h.flows - seen.flows),
      blocked: Math.max(0, h.blocked - seen.blocked),
    };
    return c.up || c.down || c.flows ? { h, c } : null;
  }

  /** A destination's live totals plus what the kept history holds beyond the re-read part. */
  private withHistory(a: AggEntry['agg'], k: { h: HistoryDest; c: Seen } | null): AggEntry['agg'] {
    if (!k) return a;
    const { h, c } = k;
    return {
      ...a,
      bytesUp: a.bytesUp + c.up,
      bytesDown: a.bytesDown + c.down,
      flows: a.flows + c.flows,
      blocked: a.blocked + c.blocked,
      firstSeen: Math.min(a.firstSeen, h.firstSeen),
      lastSeen: Math.max(a.lastSeen, h.lastSeen),
      ips: a.ips.length || !h.lastIp ? a.ips : [h.lastIp],
      tools: a.tools.length || !h.tool ? a.tools : [h.tool],
    };
  }

  /** A destination only the kept history knows: what is left of it once the files are re-read. */
  private historyView(s: SessionData, h: HistoryDest, c: Seen): DestinationAggregate {
    const facts = { host: h.host, ip: h.lastIp, port: h.port, service: null, tool: h.tool, scope: h.scope };
    const gate = { proxy: this.viaProxy(s, null, h.resolution ?? null), resolution: h.resolution ?? null, corporate: this.corporate(s, null) };
    return {
      key: h.key, host: h.host, port: h.port, groupKey: h.groupKey, endpoint: h.host === null ? h.key.replace(/^@/, '') : null,
      ips: h.lastIp ? [h.lastIp] : [], services: [], tools: h.tool ? [h.tool] : [], clients: [],
      scope: h.scope ?? 'unknown', resolution: h.resolution ?? 'unavailable',
      bytesUp: c.up, bytesDown: c.down, flows: c.flows, openFlows: 0, blocked: c.blocked,
      firstSeen: h.firstSeen, lastSeen: h.lastSeen, state: h.lastState ?? 'finished', rule: null, blockedBy: {},
      flags: flowFlags({
        dest: { host: h.host, ip: h.lastIp, port: h.port, resolution: h.resolution ?? 'unavailable' },
        scope: h.scope ?? 'unknown', proto: null, client: null, tool: h.tool,
      }, h.hop === true),
      spark: [], policy: policyFor(s.policy, facts, gate), geoIp: null, geo: null,
    };
  }

  /** Every destination as All records shows it (no flows): what a range's hourly part takes host and scope from. */
  destinations(token: string): DestinationAggregate[] {
    const s = this.sessions.get(token);
    return s ? this.destViews(s) : [];
  }

  /** Every destination: live ones with their history, then those only the history has. */
  private destViews(s: SessionData): DestinationAggregate[] {
    const out = [...s.aggs.values()].map((e) => this.aggView(s, e));
    for (const k of this.historyOnlyKeys(s)) {
      const kept = this.kept(s, k)!;
      out.push(this.historyView(s, kept.h, kept.c));
    }
    return out;
  }

  /** Kept destinations with nothing live and something the files no longer account for. */
  private historyOnlyKeys(s: SessionData): string[] {
    if (!s.history) return [];
    return [...s.history.dests.keys()].filter((k) => !s.aggs.has(k) && this.kept(s, k) !== null);
  }

  private totals(s: SessionData): NetTotals {
    const n = (st: NetState) => s.stateCounts.get(st) ?? 0;
    let open = 0;
    for (const e of s.flows.values()) if (e.rec.phase !== 'close' && e.state !== 'gate_lost') open++;
    const h = s.history?.s;
    const kept = (v: number | undefined, seen: number) => Math.max(0, (v ?? 0) - seen);
    const destinations = s.aggs.size + this.historyOnlyKeys(s).length;
    return {
      bytesUp: s.bytesUp + kept(h?.bytesUp, s.seen.up),
      bytesDown: s.bytesDown + kept(h?.bytesDown, s.seen.down),
      flows: s.flowCount + kept(h?.flows, s.seen.flows),
      openFlows: open,
      gateLost: n('gate_lost'),
      destinations,
      blocked: {
        guard: n('guard') + kept(h?.blockedGuard, s.seen.guard),
        userRule: n('user_rule') + kept(h?.blockedRule, s.seen.userRule),
        default: n('default_block') + kept(h?.blockedDefault, s.seen.def),
      },
      directFlows: s.directFlows + kept(h?.directFlows, s.seen.direct),
      broken: n('broken'),
    };
  }

  /** Flows open now or with a record at the latest record time (`CarryFlow`), as the totals count them. */
  private carryOf(s: SessionData): Record<string, CarryFlow> {
    const out: Record<string, CarryFlow> = {};
    for (const [id, e] of s.flows) {
      if (e.rec.phase === 'close' && e.lastT !== s.lastT) continue;
      out[id] = {
        key: e.destKey, up: e.rec.bytes.up, down: e.rec.bytes.down,
        blocked: BLOCK_STATES.has(e.state) ? e.state : null, direct: e.flags.scope === 'direct',
      };
    }
    return out;
  }

  /**
   * What to keep of a session (`history.ts`): the totals and destinations as
   * shown, and the latest record time they include. Null before anything was read.
   * `changedHours` carries only the hours changed since `hoursSaved`, as a save
   * every 30 s needs; by default every hour is in it.
   */
  rollup(token: string, changedHours = false): HistorySession | null {
    const s = this.sessions.get(token);
    if (!s || (s.lastT === null && !s.history)) return null;
    const t = this.totals(s);
    const h = s.history?.s;
    const dests = this.destViews(s);
    const first = Math.min(s.firstSeen ?? Infinity, h?.firstSeen ?? Infinity, ...dests.map((d) => d.firstSeen));
    return {
      token, filterSince: s.filterSince, filterSawDir: s.filterSawDir,
      firstSeen: Number.isFinite(first) ? first : 0,
      lastSeen: Math.max(s.lastT ?? 0, h?.lastSeen ?? 0),
      watermark: Math.max(s.lastT ?? -Infinity, h?.watermark ?? -Infinity),
      carry: this.carryOf(s),
      bytesUp: t.bytesUp, bytesDown: t.bytesDown, flows: t.flows,
      blockedGuard: t.blocked.guard, blockedRule: t.blocked.userRule, blockedDefault: t.blocked.default, directFlows: t.directFlows,
      lastExit: s.exits[s.exits.length - 1] ?? h?.lastExit ?? null,
      lastStatus: s.status ?? h?.lastStatus ?? null,
      sessionFile: s.session ?? h?.sessionFile ?? null,
      destinations: dests.map((d) => ({
        key: d.key, host: d.host, port: d.port, groupKey: d.groupKey, lastIp: d.ips[0] ?? null, scope: d.scope, resolution: d.resolution,
        tool: d.tools[0] ?? null, firstSeen: d.firstSeen, lastSeen: d.lastSeen, bytesUp: d.bytesUp, bytesDown: d.bytesDown,
        flows: d.flows, blocked: d.blocked, lastState: d.state, hop: d.flags.hop,
      })),
      hours: sortedHours(changedHours ? [...s.dirtyHours].map((k) => s.hours.get(k)!) : s.hours.values()),
      runs: this.runsByStart(s).map((r) => ({ ...r })),
    };
  }

  /** The changed hours of the last `rollup(…, true)` were kept. */
  hoursSaved(token: string): void {
    this.sessions.get(token)?.dirtyHours.clear();
  }

  /** Traffic per hour per destination, oldest first (`HistoryHour`). */
  hourly(token: string): HistoryHour[] {
    const s = this.sessions.get(token);
    return s ? sortedHours(s.hours.values()) : [];
  }

  /** The collector's runs, oldest first (`HistoryRun`). */
  gateRuns(token: string): HistoryRun[] {
    const s = this.sessions.get(token);
    return s ? this.runsByStart(s).map((r) => ({ ...r })) : [];
  }

  /** Forwarder runs that are over (for the cross-check against glove's `ended_runs`). */
  endedRuns(token: string): string[] {
    const s = this.sessions.get(token);
    return s ? [...s.runs].filter(([, r]) => r.ended).map(([id]) => id).sort() : [];
  }

  /** status.json as last read: the write confirmation needs its raw rules hashes. */
  statusRecord(token: string): StatusRecord | null {
    return this.sessions.get(token)?.status ?? null;
  }

  gate(token: string): NetGateView | null {
    return this.sessions.get(token)?.gate ?? null;
  }

  exit(token: string): ExitRecord | null {
    const s = this.sessions.get(token);
    return s?.exits[s.exits.length - 1] ?? null;
  }

  rules(token: string): RulesView | null {
    return this.sessions.get(token)?.rules ?? null;
  }

  snapshot(token: string, flowLimit = SNAPSHOT_FLOW_LIMIT): NetSnapshot | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    const open: Array<[string, FlowEntry]> = [];
    const closed: Array<[string, FlowEntry]> = [];
    for (const pair of s.flows) (pair[1].rec.phase === 'close' ? closed : open).push(pair);
    closed.sort((a, b) => b[1].lastT - a[1].lastT);
    const picked = [...open, ...closed.slice(0, Math.max(0, flowLimit - open.length))].sort(
      (a, b) => a[1].tOpen - b[1].tOpen,
    );
    return {
      token,
      session: s.session,
      gate: s.gate,
      exit: s.exits[s.exits.length - 1] ?? null,
      exits: [...s.exits],
      rules: s.rules,
      destinations: this.destViews(s),
      flows: picked.map(([id, e]) => this.flowView(s, id, e)),
      buckets: [...s.seconds.values()].sort((a, b) => a.t - b.t).map((b) => ({ ...b })),
      totals: this.totals(s),
      counters: { ...s.counters },
      emptyFolded: s.stateCounts.get('empty') ?? 0,
      historyTruncated: s.historyTruncated,
      historyOnly: s.historyOnly,
      range: null,
    };
  }

  /** Everything changed since the previous call, or null if nothing did. Clears the dirty sets. */
  takeDelta(token: string): NetDelta | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (!s.dirtyFlows.size && !s.dirtyAggs.size && !s.removedAggs.size && !s.dirtyBuckets.size && !s.dirtyTotals) {
      return null;
    }
    const delta: NetDelta = {
      flows: [...s.dirtyFlows].flatMap((id) => {
        const e = s.flows.get(id);
        return e ? [this.flowView(s, id, e)] : [];
      }),
      destinations: [
        ...[...s.dirtyAggs].flatMap((k) => {
          const e = s.aggs.get(k);
          return e ? [this.aggView(s, e)] : [];
        }),
        ...[...s.removedAggs].flatMap((k) => {
          const kept = s.aggs.has(k) ? null : this.kept(s, k);
          return kept ? [this.historyView(s, kept.h, kept.c)] : [];
        }),
      ],
      // A destination whose last live flow moved away is still one the history has.
      removedDestinations: [...s.removedAggs].filter((k) => !(!s.aggs.has(k) && this.kept(s, k))),
      buckets: [...s.dirtyBuckets].flatMap((t) => {
        const b = s.seconds.get(t);
        return b ? [{ ...b }] : [];
      }),
      totals: this.totals(s),
      counters: { ...s.counters },
      emptyFolded: s.stateCounts.get('empty') ?? 0,
    };
    this.clearDirty(s);
    return delta;
  }

  /** Drop pending changes: nobody is subscribed, and a subscriber starts from a snapshot. */
  discardDelta(token: string): void {
    const s = this.sessions.get(token);
    if (s) this.clearDirty(s);
  }

  private clearDirty(s: SessionData): void {
    s.dirtyFlows.clear();
    s.dirtyAggs.clear();
    s.removedAggs.clear();
    s.dirtyBuckets.clear();
    s.dirtyTotals = false;
  }

  /** Flows from memory, oldest first, with `tOpen` after `since`. */
  flows(token: string, since = 0, limit = 500): FlowView[] | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    return [...s.flows]
      .filter(([, e]) => e.tOpen > since)
      .sort((a, b) => a[1].tOpen - b[1].tOpen)
      .slice(0, Math.max(0, limit))
      .map(([id, e]) => this.flowView(s, id, e));
  }

  /** Flows opened in [from, to], oldest first: what one turn's trace joins against. */
  flowsBetween(token: string, from: number, to: number): FlowView[] | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    return [...s.flows]
      .filter(([, e]) => e.tOpen >= from && e.tOpen <= to)
      .sort((a, b) => a[1].tOpen - b[1].tOpen)
      .map(([id, e]) => this.flowView(s, id, e));
  }

  /** Flows opened before `t` and not closed before it: kept-alive connections a turn starting at `t` may reuse. */
  flowsOpenAt(token: string, t: number): FlowView[] | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    return [...s.flows]
      .filter(([, e]) => e.tOpen < t)
      .sort((a, b) => a[1].tOpen - b[1].tOpen)
      .map(([id, e]) => this.flowView(s, id, e))
      // A gate_lost flow was never closed because its gate died, not because it is open.
      .filter((f) => (f.tClose ?? Infinity) >= t && f.state !== 'gate_lost');
  }

  sessionFile(token: string): NetSessionFile | null {
    return this.sessions.get(token)?.session ?? null;
  }

  /** First and latest record times, or null before any record. */
  span(token: string): { first: number; last: number } | null {
    const s = this.sessions.get(token);
    return s && s.firstSeen !== null && s.lastT !== null ? { first: s.firstSeen, last: s.lastT } : null;
  }

  /**
   * Rate buckets for a window ending at the session's latest record. `session`
   * returns the 1 min history followed by the 1 s tail, so a chart can span the
   * whole run.
   */
  buckets(token: string, windowMs: number | 'session'): RateBucket[] | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    const secs = [...s.seconds.values()].sort((a, b) => a.t - b.t).map((b) => ({ ...b }));
    if (windowMs === 'session') {
      const mins = [...s.minutes.values()].sort((a, b) => a.t - b.t).map((b) => ({ ...b }));
      return [...mins, ...secs];
    }
    const from = (s.lastT ?? 0) - windowMs;
    return secs.filter((b) => b.t > from);
  }

  /** The session's first record as far as Layman knows, kept history included; null before any. */
  firstSeen(token: string): number | null {
    const s = this.sessions.get(token);
    return s ? this.firstSeenOf(s) : null;
  }

  private firstSeenOf(s: SessionData): number | null {
    const h = s.history?.s;
    return s.firstSeen === null ? h?.firstSeen ?? null : Math.min(s.firstSeen, h?.firstSeen ?? Infinity);
  }

  summaries(): NetSessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => {
        const t = this.totals(s);
        const h = s.history?.s;
        return {
          token: s.loc.token,
          harness: s.session?.harness ?? null,
          glove: { ...(s.historyOnly ? UNKNOWN_GLOVE : s.glove) },
          live: !s.historyOnly && s.gate.freshness === 'running',
          firstSeen: this.firstSeenOf(s),
          lastSeen: s.lastT === null ? h?.lastSeen ?? null : Math.max(s.lastT, h?.lastSeen ?? 0),
          bytesUp: t.bytesUp,
          bytesDown: t.bytesDown,
          flows: t.flows,
          directFlows: t.directFlows,
          rulesOk: s.historyOnly ? null : s.status?.rules?.ok ?? null,
          historyOnly: s.historyOnly,
        };
      })
      .sort((a, b) => Number(b.live) - Number(a.live) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }
}

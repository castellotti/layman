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
 */
import { EventEmitter } from 'events';
import { BLOCK_STATES, aggregateState, classifyFlow, classifySession, flowFlags } from './classify.js';
import { groupKeyFor } from './domain.js';
import type { NetSessionLocation } from './discovery.js';
import type {
  DestinationAggregate,
  ExitRecord,
  FlowFlags,
  FlowRecord,
  FlowView,
  NetCounters,
  NetDelta,
  NetGateView,
  NetSessionFile,
  NetSessionSummary,
  NetSnapshot,
  NetState,
  NetTotals,
  RateBucket,
  RulesView,
  StatusRecord,
} from './types.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** 1 s buckets are kept for this long, then folded into 1 min buckets for the session. */
const SECOND_BUCKET_SPAN = 60 * MINUTE;
const SPARK_SPAN = 60 * SECOND;
const MAX_EXITS = 50;
const MAX_IPS = 8;
export const DEFAULT_MAX_CLOSED_FLOWS = 5_000;
export const SNAPSHOT_FLOW_LIMIT = 500;

interface FlowEntry {
  rec: FlowRecord;
  tOpen: number;
  lastT: number;
  lastActivityAt: number;
  state: NetState;
  flags: FlowFlags;
  destKey: string | null;
  groupKey: string;
}

interface AggEntry {
  agg: Omit<DestinationAggregate, 'state' | 'spark'>;
  /** Open flows and their current states: open flows are never evicted. */
  open: Map<string, NetState>;
  /** The flow with the latest `t_open`, and its state. */
  latest: { id: string; tOpen: number; state: NetState } | null;
  spark: Map<number, RateBucket>;
}

interface SessionData {
  loc: NetSessionLocation;
  flows: Map<string, FlowEntry>;
  /** Closed flow ids, oldest close first, for eviction. */
  closedOrder: string[];
  aggs: Map<string, AggEntry>;
  seconds: Map<number, RateBucket>;
  minutes: Map<number, RateBucket>;
  status: StatusRecord | null;
  statusMtimeMs: number | null;
  session: NetSessionFile | null;
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
  dirtyFlows: Set<string>;
  dirtyAggs: Set<string>;
  removedAggs: Set<string>;
  dirtyBuckets: Set<number>;
  dirtyTotals: boolean;
}

export interface NetStoreOptions {
  /** Applied to `request.url` and header values (record: full). */
  stringFilter?: (text: string) => string;
  maxClosedFlows?: number;
}

function destKeyFor(rec: FlowRecord): string {
  const { host, port } = rec.dest;
  return host === null ? `@${rec.service}` : `${host.toLowerCase()}:${port ?? 0}`;
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

function pushUnique(list: string[], v: string | null | undefined, max = Infinity): void {
  if (v && !list.includes(v)) {
    list.push(v);
    if (list.length > max) list.shift();
  }
}

export class NetStore extends EventEmitter {
  private sessions = new Map<string, SessionData>();
  private readonly stringFilter?: (text: string) => string;
  private readonly maxClosedFlows: number;

  constructor(opts: NetStoreOptions = {}) {
    super();
    this.stringFilter = opts.stringFilter;
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
      flows: new Map(),
      closedOrder: [],
      aggs: new Map(),
      seconds: new Map(),
      minutes: new Map(),
      status: null,
      statusMtimeMs: null,
      session: null,
      exits: [],
      rules: { path: loc.rulesPath, exists: false, file: null, readError: null, mtimeMs: null },
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

  // ─── Ingest ───────────────────────────────────────────────────────────────

  /** One flow record, in file order. Emits `changed`. */
  ingestFlow(token: string, rec: FlowRecord, now = Date.now()): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.counters.records++;
    const t = Date.parse(rec.t);
    const prev = s.flows.get(rec.id);

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
      tOpen: Number.isFinite(tOpen) ? tOpen : t,
      lastT: prev ? Math.max(prev.lastT, t) : t,
      lastActivityAt: dUp || dDown || !prev ? Math.max(prev?.lastActivityAt ?? 0, t) : prev.lastActivityAt,
      state: 'active',
      flags: flowFlags(latest),
      destKey: null,
      groupKey: groupKeyFor(latest.dest.host, latest.service),
    };
    entry.state = classifyFlow({ ...latest, lastActivityAt: entry.lastActivityAt }, now);
    entry.destKey = entry.state === 'empty' ? null : destKeyFor(latest);

    this.apply(s, rec.id, prev ?? null, entry);

    if (dUp || dDown) {
      const sec = Math.floor(t / SECOND) * SECOND;
      addBucket(s.seconds, sec, dUp, dDown);
      s.dirtyBuckets.add(sec);
      if (entry.destKey) {
        const agg = s.aggs.get(entry.destKey);
        if (agg) addBucket(agg.spark, sec, dUp, dDown);
      }
      s.bytesUp += dUp;
      s.bytesDown += dDown;
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
    if (BLOCK_STATES.has(prev.state)) e.agg.blocked--;
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
          flags: next.flags,
        },
        open: new Map(),
        latest: null,
        spark: new Map(),
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
      if (r.rule !== null || next.state === 'default_block') a.rule = r.rule;
    }
    if (r.phase !== 'close') e.open.set(id, next.state);
    a.openFlows = e.open.size;
    pushUnique(a.ips, r.dest.ip, MAX_IPS);
    pushUnique(a.services, r.service);
    pushUnique(a.tools, r.tool);
    pushUnique(a.clients, r.client);
    a.firstSeen = Math.min(a.firstSeen, next.tOpen);
    a.lastSeen = Math.max(a.lastSeen, next.lastT);
    if (!e.latest || e.latest.id === id || next.tOpen >= e.latest.tOpen) {
      e.latest = { id, tOpen: next.tOpen, state: next.state };
      a.scope = r.scope;
      a.resolution = r.dest.resolution;
      a.flags = { ...next.flags, unresolved: next.flags.unresolved && a.ips.length === 0 };
    }
    s.dirtyAggs.add(key);
  }

  private evict(s: SessionData): void {
    while (s.closedOrder.length > this.maxClosedFlows) {
      const id = s.closedOrder.shift()!;
      s.flows.delete(id);
    }
  }

  ingestExit(token: string, rec: ExitRecord): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.counters.records++;
    s.exits.push(rec);
    if (s.exits.length > MAX_EXITS) s.exits.shift();
    this.refreshGate(s, Date.now(), true);
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
    s.session = file;
    this.refreshGate(s, now, true);
  }

  setRules(token: string, rules: RulesView): void {
    const s = this.sessions.get(token);
    if (!s) return;
    s.rules = rules;
    this.emit('rules', token);
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
        const state = classifyFlow({ ...e.rec, lastActivityAt: e.lastActivityAt }, now);
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
  }

  /** Emits `status` when the gate view changed in a way the UI shows. */
  private refreshGate(s: SessionData, now: number, force: boolean): void {
    const next = classifySession(
      { status: s.status, statusMtimeMs: s.statusMtimeMs, exit: s.exits[s.exits.length - 1] ?? null, session: s.session },
      now,
    );
    const prev = s.gate;
    s.gate = next;
    if (force || prev.freshness !== next.freshness) this.emit('status', s.loc.token);
  }

  // ─── Views ────────────────────────────────────────────────────────────────

  private flowView(id: string, e: FlowEntry): FlowView {
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
    };
  }

  private aggView(s: SessionData, e: AggEntry): DestinationAggregate {
    const states = [...e.open.values()];
    if (e.latest) states.unshift(e.latest.state);
    const from = (s.lastT ?? 0) - SPARK_SPAN;
    return {
      ...e.agg,
      ips: [...e.agg.ips],
      services: [...e.agg.services],
      tools: [...e.agg.tools],
      clients: [...e.agg.clients],
      state: aggregateState(states),
      spark: [...e.spark.values()].filter((b) => b.t > from).sort((a, b) => a.t - b.t).map((b) => ({ ...b })),
    };
  }

  private totals(s: SessionData): NetTotals {
    const n = (st: NetState) => s.stateCounts.get(st) ?? 0;
    let open = 0;
    for (const e of s.flows.values()) if (e.rec.phase !== 'close') open++;
    return {
      bytesUp: s.bytesUp,
      bytesDown: s.bytesDown,
      flows: s.flowCount,
      openFlows: open,
      destinations: s.aggs.size,
      blocked: { guard: n('guard'), userRule: n('user_rule'), default: n('default_block') },
      directFlows: s.directFlows,
      broken: n('broken'),
    };
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
      env: s.loc.env,
      name: s.loc.name,
      session: s.session,
      gate: s.gate,
      exit: s.exits[s.exits.length - 1] ?? null,
      exits: [...s.exits],
      rules: s.rules,
      destinations: [...s.aggs.values()].map((e) => this.aggView(s, e)),
      flows: picked.map(([id, e]) => this.flowView(id, e)),
      buckets: [...s.seconds.values()].sort((a, b) => a.t - b.t).map((b) => ({ ...b })),
      totals: this.totals(s),
      counters: { ...s.counters },
      emptyFolded: s.stateCounts.get('empty') ?? 0,
      historyTruncated: s.historyTruncated,
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
        return e ? [this.flowView(id, e)] : [];
      }),
      destinations: [...s.dirtyAggs].flatMap((k) => {
        const e = s.aggs.get(k);
        return e ? [this.aggView(s, e)] : [];
      }),
      removedDestinations: [...s.removedAggs],
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
      .map(([id, e]) => this.flowView(id, e));
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

  summaries(): NetSessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => ({
        token: s.loc.token,
        env: s.loc.env,
        name: s.loc.name,
        harness: s.session?.harness ?? null,
        live: s.gate.freshness === 'running',
        firstSeen: s.firstSeen,
        lastSeen: s.lastT,
        bytesUp: s.bytesUp,
        bytesDown: s.bytesDown,
        flows: s.flowCount,
        directFlows: s.directFlows,
        rulesOk: s.status?.rules?.ok ?? null,
      }))
      .sort((a, b) => Number(b.live) - Number(a.live) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  }
}

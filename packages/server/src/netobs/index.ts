/**
 * Network observability for glove sessions: discovery → tail → store → `net:*`
 * frames. See docs/extensions/glove.md ("Network") for the design and the rules
 * that must not be relaxed; docs/extensions/glove.md → Network for the design.
 *
 * Wiring lives here so `server.ts` makes one constructor call, one `start()`,
 * and hands each WebSocket to `attach()`/`subscribe()`.
 */
import { NetSessionSource, type GloveSessionInfo, type NetSessionLocation } from './discovery.js';
import { RulesControl, type ApplyResult } from './control.js';
import { GeoLocator } from './geo.js';
import { parseLine, parseSessionFile, parseStatus, type ParsedLine } from './parse.js';
import type { NetHistory } from './history.js';
import { NetStore } from './store.js';
import { DEFAULT_RANGE_SCAN_BYTES, RangeView, buildRange, rangeKey } from './range.js';
import { DEFAULT_BACKFILL_BYTES, JsonFileWatcher, NdjsonTailer } from './tail.js';
import type {
  ExitRecord,
  FilterAccess,
  GloveRegistryView,
  NetDelta,
  NetGateView,
  NetSessionFile,
  NetNotObservable,
  NetRange,
  NetRangeInfo,
  NetSessionSummary,
  NetSnapshot,
  RulesOp,
  RulesView,
  StatusRecord,
} from './types.js';
import { isDir } from '../glove/registry.js';
import { join } from 'path';

export { NetStore } from './store.js';
export type * from './types.js';

/** The `net:*` frames this module sends. Part of `ServerMessage` (types/index.ts). */
export type NetServerMessage =
  | { type: 'net:sessions'; sessions: NetSessionSummary[]; notObservable: NetNotObservable[]; registry: GloveRegistryView }
  | { type: 'net:snapshot'; token: string; snapshot: NetSnapshot }
  /** `range`: the key of the range it is for (`NetRangeInfo.key`), or null for All records. */
  | { type: 'net:delta'; token: string; range: string | null; delta: NetDelta }
  | { type: 'net:status'; token: string; status: NetGateView }
  | { type: 'net:exit'; token: string; range: string | null; exit: ExitRecord | null }
  | { type: 'net:rules'; token: string; rules: RulesView }
  /** The outcome of one `net:rules:apply`, to the socket that sent it. Confirmation follows in `net:rules`. */
  | { type: 'net:rules:result'; token: string; opId: string; ok: boolean; error: string | null }
  /** A ranged snapshot being built: how much of glove's files it has read. */
  | { type: 'net:range:progress'; token: string; range: string; scannedBytes: number; totalBytes: number };

/** What server.ts's WebSocket handler holds. */
export interface NetSocket {
  readyState: number;
  send: (data: string) => void;
}

/** Tail polling, the same cadence as glove's own reload loop. */
export const POLL_MS = 1_000;
/** At most one `net:delta` per session per this interval. */
export const COALESCE_MS = 500;

export interface NetObsOptions {
  /** Expanded glove home (`~/.glove`), or null when glove or its network views are off. */
  getGloveHome: () => string | null;
  stringFilter?: (text: string) => string;
  /** `glove.network.controlEnabled`: false leaves every toggle read-only. */
  controlEnabled?: () => boolean;
  /** Expanded `glove.network.geoipDbPath`, or '' for none. */
  getGeoPath?: () => string;
  pollMs?: number;
  coalesceMs?: number;
  budgetBytes?: number;
  /** Where totals are kept across restarts (`persist.ts`); none in most tests. */
  history?: NetHistory;
  /** How often rollups are written (30 s). */
  persistMs?: number;
  /** Most of glove's files one time range reads (`range.ts`). */
  rangeBudgetBytes?: number;
}

const PERSIST_MS = 30_000;
/** Built ranges kept for a later subscriber once nobody is looking at them. */
export const MAX_IDLE_RANGES = 4;
/** At most one `net:range:progress` per range per this interval. */
const PROGRESS_MS = 250;

/** One socket's subscription: a glove session, and the key of its time range (null: All records). */
interface Sub {
  token: string | null;
  range: string | null;
}

/** A time range of one session (`range.ts`), shared by every socket that asks for it. */
interface RangeEntry {
  view: RangeView;
  /** Null until the scan has finished. */
  info: NetRangeInfo | null;
  /** Records read live while the scan ran, applied once it is done. Null after. */
  pending: ParsedLine[] | null;
  lastUsed: number;
  lastProgress: number;
}

const entryId = (token: string, key: string) => `${token}|${key}`;

class SessionReader {
  readonly flows: NdjsonTailer;
  readonly exits: NdjsonTailer;
  readonly status: JsonFileWatcher<StatusRecord>;
  readonly session: JsonFileWatcher<NetSessionFile>;
  private gapsSeen = 0;

  constructor(readonly loc: NetSessionLocation, budgetBytes: number) {
    this.flows = new NdjsonTailer(loc.netDir, 'flows', budgetBytes);
    this.exits = new NdjsonTailer(loc.netDir, 'exit', budgetBytes);
    this.status = new JsonFileWatcher(join(loc.netDir, 'status.json'), (t) => parseStatus(JSON.parse(t)));
    this.session = new JsonFileWatcher(join(loc.netDir, 'session.json'), (t) => parseSessionFile(JSON.parse(t)));
  }

  /**
   * Read everything new into the store. session.json first, so aggregates can name service endpoints.
   * `onRecord` sees each record too: the ranged views that reach into the present follow it.
   */
  poll(store: NetStore, now: number, onRecord?: (p: ParsedLine) => void): void {
    const token = this.loc.token;
    if (this.session.poll()) store.setSessionFile(token, this.session.value, now);

    let invalid = 0;
    let skipped = 0;
    for (const line of this.exits.poll()) {
      const p = parseLine(line);
      if (p.kind === 'exit') store.ingestExit(token, p.record);
      else if (p.kind === 'invalid') invalid++;
      else skipped++;
      onRecord?.(p);
    }
    for (const line of this.flows.poll()) {
      const p = parseLine(line);
      if (p.kind === 'flow') store.ingestFlow(token, p.record, now);
      else if (p.kind === 'gate') store.ingestGate(token, p.record, now);
      else if (p.kind === 'invalid') invalid++;
      else skipped++;
      onRecord?.(p);
    }
    const gaps = this.flows.gaps + this.exits.gaps - this.gapsSeen;
    this.gapsSeen += gaps;
    store.noteRead(token, {
      invalid,
      skipped,
      gaps,
      historyTruncated: this.flows.historyTruncated,
    });

    if (this.status.poll()) store.setStatus(token, this.status.value, this.status.mtimeMs, now);
  }
}

export class NetObs {
  readonly store: NetStore;
  private readonly source: NetSessionSource;
  private readonly readers = new Map<string, SessionReader>();
  private readonly subs = new Map<NetSocket, Sub>();
  /** Time ranges by `entryId`. */
  private readonly ranges = new Map<string, RangeEntry>();
  private readonly rangeBudgetBytes: number;
  private readonly storeOpts: ConstructorParameters<typeof NetStore>[0];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private readonly history: NetHistory | null;
  private readonly persistMs: number;
  private historyLoaded = false;
  private listSig = '';
  private readonly pollMs: number;
  private readonly coalesceMs: number;
  private readonly budgetBytes: number;
  private readonly getGloveHome: () => string | null;
  private registry: GloveRegistryView = { state: 'absent', detail: '' };
  private notObservable: NetNotObservable[] = [];
  private readonly control: RulesControl;
  readonly geo: GeoLocator;

  constructor(opts: NetObsOptions) {
    this.getGloveHome = opts.getGloveHome;
    this.control = new RulesControl({ controlEnabled: opts.controlEnabled ?? (() => true) });
    this.source = new NetSessionSource(opts.getGloveHome);
    this.geo = new GeoLocator(opts.getGeoPath ?? (() => ''));
    this.geo.refresh();
    this.storeOpts = { stringFilter: opts.stringFilter, geolocate: (ip) => this.geo.lookup(ip) };
    this.store = new NetStore(this.storeOpts);
    this.rangeBudgetBytes = opts.rangeBudgetBytes ?? DEFAULT_RANGE_SCAN_BYTES;
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_BACKFILL_BYTES;
    this.history = opts.history ?? null;
    this.persistMs = opts.persistMs ?? PERSIST_MS;

    this.store.on('changed', (token: string) => this.onChanged(this.store, token, null));
    // The gate and the rules are the same whatever the range: every subscriber of the session gets them.
    this.store.on('status', (token: string) => {
      const status = this.store.gate(token);
      if (status) this.sendTo(token, { type: 'net:status', token, status });
    });
    this.store.on('exit', (token: string) => this.sendTo(token, { type: 'net:exit', token, range: null, exit: this.store.exit(token) }, null));
    this.store.on('rules', (token: string) => {
      const rules = this.store.rules(token);
      if (rules) this.sendTo(token, { type: 'net:rules', token, rules });
    });
  }

  start(): void {
    if (this.pollTimer) return;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollMs);
    this.pollTimer.unref?.();
    if (this.history) {
      this.persistTimer = setInterval(() => this.persist(), this.persistMs);
      this.persistTimer.unref?.();
    }
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persistTimer = null;
    this.persist();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** One discovery + read pass. Public so tests can drive it without timers. */
  poll(now = Date.now()): void {
    if (this.getGloveHome() === null) {
      // Glove (or its network views) switched off: keep what was read, then
      // forget everything, so the header goes back to exactly what it was.
      this.persist();
      this.historyLoaded = false;
      // Rules state too: the sessions come back with an empty rules view, and a control that
      // still held the old signature would see nothing new and never send it again.
      for (const token of this.readers.keys()) this.control.forget(token);
      this.readers.clear();
      this.ranges.clear();
      for (const token of this.store.tokens()) this.store.remove(token);
      this.registry = { state: 'absent', detail: '' };
      this.notObservable = [];
      this.maybeBroadcastSessions();
      return;
    }
    // What Layman kept goes in before any file is read: its watermark decides which re-read records it already holds.
    if (!this.historyLoaded) {
      this.historyLoaded = true;
      try {
        for (const h of this.history?.load() ?? []) this.store.setHistory(h, now);
      } catch (err) {
        console.warn(`[netobs] could not read kept network history: ${(err as Error).message}`);
      }
    }
    const found = this.source.discover();
    this.registry = found.registry;
    this.notObservable = found.notObservable;
    if (this.geo.refresh()) this.store.refreshGeo();

    const seen = new Set<string>();
    for (const { loc, info } of found.sessions) {
      seen.add(loc.token);
      if (!this.readers.has(loc.token)) {
        if (this.store.isHistoryOnly(loc.token)) this.store.relocate(loc);
        else this.store.ensure(loc);
        this.readers.set(loc.token, new SessionReader(loc, this.budgetBytes));
      }
      try {
        this.readers.get(loc.token)!.poll(this.store, now, this.forwarder(loc.token, now));
        this.noteGlove(loc, info);
        this.pollRules(loc, now);
      } catch (err) {
        // A read error on one session must not stop the others, or the poll loop.
        console.warn(`[netobs] ${loc.token}: ${(err as Error).message}`);
      }
    }
    // A session whose directory vanished stops being read but stays listed:
    // what was read from it is still true. Its reader is kept, not dropped: one
    // failed directory read (a Docker Desktop bind mount can return an empty
    // listing) would otherwise have a new reader re-read every file from the
    // start into the same session, counting its flows and exits twice.
    for (const token of this.readers.keys()) {
      if (!seen.has(token)) this.control.forget(token);
    }
    this.store.tick(now);
    for (const e of this.ranges.values()) if (e.info) e.view.store.tick(e.view.clock(now));
    this.maybeBroadcastSessions();
  }

  /**
   * Where a session's newly read records go besides the live store: every range of it.
   * A range that ended in the past drops them itself (`RangeView`), so one that reaches
   * into the present, or ends later today, follows the gate as All records does.
   */
  private forwarder(token: string, now: number): ((p: ParsedLine) => void) | undefined {
    const entries = [...this.ranges.values()].filter((e) => e.view.token === token);
    if (!entries.length) return undefined;
    return (p) => {
      for (const e of entries) {
        if (e.pending) e.pending.push(p);
        else e.view.record(p, now);
      }
    };
  }

  /**
   * Write every session's rollup, when session recording is on.
   * Public so tests (and shutdown) can drive it.
   */
  persist(): void {
    if (!this.history?.enabled()) return;
    const rows = this.store.tokens()
      .filter((t) => !this.store.isHistoryOnly(t)) // unchanged since it was loaded
      .map((t) => this.store.rollup(t))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    try {
      this.history.save(rows);
    } catch (err) {
      console.warn(`[netobs] could not keep network history: ${(err as Error).message}`);
    }
  }

  /**
   * glove's grants for a session, every poll. glove records a revocation
   * nowhere (the grant just reads `granted: false` again, and `control/<id>/`
   * goes), so Layman remembers the last grant it saw, across restarts too
   * (`history.ts`), and calls a grant that has gone `revoked`.
   */
  private noteGlove(loc: NetSessionLocation, info: GloveSessionInfo): void {
    const token = loc.token;
    const grant = info.grants.filter;
    const granted = grant?.granted === true;
    const since = grant?.since ?? '';
    let filter: FilterAccess;
    if (granted) {
      filter = this.store.noteFilterGrant(token, since, isDir(loc.controlDir)) ? 'revoked' : 'granted';
    } else {
      filter = this.store.filterSince(token) !== null ? 'revoked' : 'not-granted';
    }
    const orphaned = info.orphaned !== null;
    this.control.setAccess(loc, { filter, orphaned });
    this.store.setGlove(token, {
      template: info.template,
      filter,
      transcripts: info.grants.observe ? info.grants.observe.transcripts : null,
      orphaned,
    });
  }

  /** rules.json and the gate's verdict on it; pushes `net:rules` and new policy predictions when they change. */
  private pollRules(loc: NetSessionLocation, now: number): void {
    if (!this.control.poll(loc, this.store.statusRecord(loc.token), now)) return;
    this.store.setRules(loc.token, this.control.view(loc.token)!);
    this.setPolicy(loc.token);
  }

  /** New rule sets: re-predict every destination's verdict, in All records and in every range. */
  private setPolicy(token: string): void {
    const sets = this.control.sets(token);
    this.store.setPolicy(token, sets);
    for (const e of this.ranges.values()) if (e.info && e.view.token === token) e.view.store.setPolicy(token, sets);
  }

  /**
   * Change rules.json. The WebSocket and REST share this. The
   * result says whether the write reached disk; whether the gate took it
   * arrives later, in `net:rules`, by the hash rule.
   */
  applyRules(token: string, op: RulesOp, opId: string, now = Date.now()): ApplyResult {
    const loc = this.store.location(token);
    if (!loc) return { ok: false, error: `No glove network session '${token}'` };
    const result = this.control.apply(loc, this.store.statusRecord(token), op, opId, now);
    this.store.setRules(token, this.control.view(token)!);
    this.setPolicy(token);
    return result;
  }

  /** `net:rules:apply` from a socket: apply, and answer that socket. */
  applyFromSocket(socket: NetSocket, token: string, op: RulesOp, opId: string): void {
    const result = this.applyRules(token, op, opId);
    this.send(socket, { type: 'net:rules:result', token, opId, ...result });
  }

  /** Every session with data: an observe export, or history kept from one. */
  sessions(): NetSessionSummary[] {
    return this.store.summaries();
  }

  /** The registered sessions Layman may not read, for the picker to list disabled. Never among `sessions()`. */
  notObservableSessions(): NetNotObservable[] {
    const known = new Set(this.store.summaries().map((s) => s.token));
    return this.notObservable.filter((n) => !known.has(n.token));
  }

  /** The state of glove's registry, for the "upgrade glove" notice. */
  registryView(): GloveRegistryView {
    return this.registry;
  }

  // ─── Sockets ──────────────────────────────────────────────────────────────

  /** A new WebSocket: it gets the (small) session list, and nothing else until it subscribes. */
  attach(socket: NetSocket): void {
    this.subs.set(socket, { token: null, range: null });
    this.send(socket, { type: 'net:sessions', sessions: this.sessions(), notObservable: this.notObservableSessions(), registry: this.registry });
  }

  detach(socket: NetSocket): void {
    this.subs.delete(socket);
    this.pruneRanges();
  }

  /**
   * One session at a time per socket; null unsubscribes. With a `range`, the
   * snapshot is that window's (`range.ts`), sent once its files are read; a
   * range already built for another socket (or recently) is sent at once.
   */
  subscribe(socket: NetSocket, token: string | null, range: NetRange | null = null): void {
    const key = token !== null && range ? rangeKey(range) : null;
    this.subs.set(socket, { token, range: key });
    this.pruneRanges();
    if (token === null) return;
    if (!range) {
      const snapshot = this.store.snapshot(token);
      if (snapshot) this.send(socket, { type: 'net:snapshot', token, snapshot });
      return;
    }
    const entry = this.rangeEntry(token, range);
    if (!entry) return;
    entry.lastUsed = Date.now();
    if (entry.info) this.send(socket, { type: 'net:snapshot', token, snapshot: this.rangeSnapshot(entry) });
  }

  /** A time range's entry, starting its scan if it is new. Null for a session Layman has no files for. */
  private rangeEntry(token: string, range: NetRange): RangeEntry | null {
    const id = entryId(token, rangeKey(range));
    const known = this.ranges.get(id);
    if (known) return known;
    const loc = this.store.location(token);
    if (!loc) return null;
    const entry: RangeEntry = {
      view: new RangeView(token, range, this.store.sessionFile(token), this.storeOpts),
      info: null, pending: [], lastUsed: Date.now(), lastProgress: 0,
    };
    this.ranges.set(id, entry);
    const wanted = () => this.ranges.get(id) === entry;
    void buildRange(entry.view, loc.netDir, {
      budgetBytes: this.rangeBudgetBytes,
      cancelled: () => !wanted(),
      onProgress: (scannedBytes, totalBytes) => {
        const now = Date.now();
        if (now - entry.lastProgress < PROGRESS_MS) return;
        entry.lastProgress = now;
        this.sendTo(token, { type: 'net:range:progress', token, range: entry.view.key, scannedBytes, totalBytes }, entry.view.key);
      },
    }).then((info) => {
      if (!wanted()) return;
      for (const p of entry.pending ?? []) entry.view.record(p);
      entry.pending = null;
      entry.info = info;
      // From here `setPolicy` keeps it current, as it does All records.
      entry.view.store.setPolicy(token, this.control.sets(token));
      // The snapshot holds everything read so far; deltas start from here.
      entry.view.store.discardDelta(token);
      entry.view.store.on('changed', () => this.onChanged(entry.view.store, token, entry.view.key));
      entry.view.store.on('exit', () => this.sendTo(token, { type: 'net:exit', token, range: entry.view.key, exit: entry.view.store.exit(token) }, entry.view.key));
      const targets = this.subscribers(token, entry.view.key);
      if (targets.length) {
        const json = JSON.stringify({ type: 'net:snapshot', token, snapshot: this.rangeSnapshot(entry) } satisfies NetServerMessage);
        for (const s of targets) if (s.readyState === 1) s.send(json);
      }
    }).catch((err: Error) => {
      console.warn(`[netobs] ${token}: could not read the range ${entry.view.key}: ${err.message}`);
      if (wanted()) this.ranges.delete(id);
    });
    return entry;
  }

  private rangeSnapshot(entry: RangeEntry): NetSnapshot {
    const token = entry.view.token;
    return entry.view.snapshot({
      session: this.store.sessionFile(token),
      gate: this.store.gate(token),
      rules: this.store.rules(token),
    }, entry.info!);
  }

  /**
   * Drop ranges nobody is subscribed to, keeping the `MAX_IDLE_RANGES` most recently
   * used finished ones for the next subscriber (switching tabs, or Back). A range
   * still being read with nobody waiting is dropped, which stops its scan.
   */
  private pruneRanges(): void {
    const used = new Set<string>();
    for (const sub of this.subs.values()) if (sub.token !== null && sub.range !== null) used.add(entryId(sub.token, sub.range));
    const idle = [...this.ranges].filter(([id]) => !used.has(id));
    for (const [id, e] of idle) if (!e.info) this.ranges.delete(id);
    const kept = idle.filter(([, e]) => e.info).sort((a, b) => b[1].lastUsed - a[1].lastUsed);
    for (const [id] of kept.slice(MAX_IDLE_RANGES)) this.ranges.delete(id);
  }

  /** A session's subscribers: all of them, or only those of one range (null: All records). */
  private subscribers(token: string, range?: string | null): NetSocket[] {
    const out: NetSocket[] = [];
    for (const [socket, sub] of this.subs) {
      if (sub.token === token && (range === undefined || sub.range === range)) out.push(socket);
    }
    return out;
  }

  private send(socket: NetSocket, msg: NetServerMessage): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(msg));
  }

  private sendTo(token: string, msg: NetServerMessage, range?: string | null): void {
    const targets = this.subscribers(token, range);
    if (!targets.length) return;
    const json = JSON.stringify(msg);
    for (const s of targets) if (s.readyState === 1) s.send(json);
  }

  /**
   * Coalesce to one delta per session (and range) per `coalesceMs`: glove already
   * writes at about 1 Hz per flow, and a burst of opens must not become a burst of
   * frames to every dashboard. The trailing timer guarantees the last state of a
   * burst is sent. A session nobody is watching accumulates nothing — a
   * subscriber starts from a snapshot.
   */
  private onChanged(store: NetStore, token: string, range: string | null): void {
    if (!this.subscribers(token, range).length) {
      store.discardDelta(token);
      return;
    }
    const timer = range === null ? token : entryId(token, range);
    if (this.timers.has(timer)) return;
    this.timers.set(
      timer,
      setTimeout(() => {
        this.timers.delete(timer);
        const delta = store.takeDelta(token);
        if (delta) this.sendTo(token, { type: 'net:delta', token, range, delta }, range);
      }, this.coalesceMs),
    );
  }

  /** Re-send the list only when something the picker shows changed. */
  private maybeBroadcastSessions(): void {
    const sessions = this.sessions();
    const notObservable = this.notObservableSessions();
    const sig = JSON.stringify([this.registry, notObservable, sessions.map((s) => [s.token, s.live, s.rulesOk, s.directFlows > 0, s.harness, s.glove])]);
    if (sig === this.listSig) return;
    this.listSig = sig;
    for (const socket of this.subs.keys()) this.send(socket, { type: 'net:sessions', sessions, notObservable, registry: this.registry });
  }
}

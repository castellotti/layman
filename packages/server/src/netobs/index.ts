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
import type { ControlAccess } from './writer.js';
import { GeoLocator } from './geo.js';
import { parseLine, parseSessionFile, parseStatus } from './parse.js';
import type { NetHistory } from './history.js';
import { NetStore } from './store.js';
import { DEFAULT_BACKFILL_BYTES, JsonFileWatcher, NdjsonTailer } from './tail.js';
import type {
  ExitRecord,
  FilterAccess,
  GloveRegistryView,
  NetDelta,
  NetGateView,
  NetSessionFile,
  NetSessionSummary,
  NetSnapshot,
  RulesOp,
  RulesView,
  StatusRecord,
} from './types.js';
import { statSync } from 'fs';
import { join } from 'path';

export { NetStore } from './store.js';
export type * from './types.js';

/** The `net:*` frames this module sends. Part of `ServerMessage` (types/index.ts). */
export type NetServerMessage =
  | { type: 'net:sessions'; sessions: NetSessionSummary[]; registry: GloveRegistryView }
  | { type: 'net:snapshot'; token: string; snapshot: NetSnapshot }
  | { type: 'net:delta'; token: string; delta: NetDelta }
  | { type: 'net:status'; token: string; status: NetGateView }
  | { type: 'net:exit'; token: string; exit: ExitRecord | null }
  | { type: 'net:rules'; token: string; rules: RulesView }
  /** The outcome of one `net:rules:apply`, to the socket that sent it. Confirmation follows in `net:rules`. */
  | { type: 'net:rules:result'; token: string; opId: string; ok: boolean; error: string | null };

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
}

const PERSIST_MS = 30_000;

/** A registered session without the observe grant: no data, and none will be looked for. */
function notObservableSummary(token: string, harness: string, template: string | null): NetSessionSummary {
  return {
    token, harness, live: false, firstSeen: null, lastSeen: null, bytesUp: 0, bytesDown: 0, flows: 0, directFlows: 0,
    rulesOk: null, historyOnly: false,
    glove: { template, filter: null, transcripts: null, orphaned: false, notObservable: true },
  };
}

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

  /** Read everything new into the store. session.json first, so aggregates can name service endpoints. */
  poll(store: NetStore, now: number): void {
    const token = this.loc.token;
    if (this.session.poll()) store.setSessionFile(token, this.session.value, now);

    let invalid = 0;
    let skipped = 0;
    for (const line of this.exits.poll()) {
      const p = parseLine(line);
      if (p.kind === 'exit') store.ingestExit(token, p.record);
      else if (p.kind === 'invalid') invalid++;
      else skipped++;
    }
    for (const line of this.flows.poll()) {
      const p = parseLine(line);
      if (p.kind === 'flow') store.ingestFlow(token, p.record, now);
      else if (p.kind === 'gate') store.ingestGate(token, p.record, now);
      else if (p.kind === 'invalid') invalid++;
      else skipped++;
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
  private readonly subs = new Map<NetSocket, string | null>();
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
  /** glove's grant per session, as of the last poll: the writer checks it again on every apply. */
  private readonly access = new Map<string, ControlAccess>();
  /** Sessions whose control directory Layman has seen: one that disappears while granted is being revoked. */
  private readonly hadControlDir = new Set<string>();
  private registry: GloveRegistryView = { state: 'absent', detail: '' };
  private notObservable: NetSessionSummary[] = [];
  private readonly control: RulesControl;
  readonly geo: GeoLocator;

  constructor(opts: NetObsOptions) {
    this.getGloveHome = opts.getGloveHome;
    this.control = new RulesControl({ controlEnabled: opts.controlEnabled ?? (() => true) });
    this.source = new NetSessionSource(opts.getGloveHome);
    this.geo = new GeoLocator(opts.getGeoPath ?? (() => ''));
    this.geo.refresh();
    this.store = new NetStore({ stringFilter: opts.stringFilter, geolocate: (ip) => this.geo.lookup(ip) });
    this.pollMs = opts.pollMs ?? POLL_MS;
    this.coalesceMs = opts.coalesceMs ?? COALESCE_MS;
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_BACKFILL_BYTES;
    this.history = opts.history ?? null;
    this.persistMs = opts.persistMs ?? PERSIST_MS;

    this.store.on('changed', (token: string) => this.onChanged(token));
    this.store.on('status', (token: string) => {
      const status = this.store.gate(token);
      if (status) this.sendTo(token, { type: 'net:status', token, status });
    });
    this.store.on('exit', (token: string) => this.sendTo(token, { type: 'net:exit', token, exit: this.store.exit(token) }));
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
      for (const token of this.store.tokens()) this.store.remove(token);
      this.access.clear();
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
    this.notObservable = found.notObservable.map((n) => notObservableSummary(n.token, n.harness, n.template));
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
        this.readers.get(loc.token)!.poll(this.store, now);
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
    this.maybeBroadcastSessions();
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
    if (granted) this.store.noteFilterSince(token, grant.since ?? '');
    let dir = false;
    try {
      dir = statSync(loc.controlDir).isDirectory();
    } catch {
      dir = false;
    }
    if (granted && dir) this.hadControlDir.add(token);
    let filter: FilterAccess;
    if (granted) filter = !dir && this.hadControlDir.has(token) ? 'revoked' : 'granted';
    else filter = this.store.filterSince(token) !== null ? 'revoked' : 'not-granted';
    const orphaned = info.orphaned !== null;
    this.access.set(token, { filter, orphaned });
    this.store.setGlove(token, {
      template: info.template,
      filter,
      transcripts: info.grants.observe ? info.grants.observe.transcripts : null,
      orphaned,
      notObservable: false,
    });
  }

  private accessOf(token: string): ControlAccess {
    return this.access.get(token) ?? { filter: 'not-granted', orphaned: false };
  }

  /** rules.json and the gate's verdict on it; pushes `net:rules` and new policy predictions when they change. */
  private pollRules(loc: NetSessionLocation, now: number): void {
    if (!this.control.poll(loc, this.store.statusRecord(loc.token), now, this.accessOf(loc.token))) return;
    this.store.setRules(loc.token, this.control.view(loc.token)!);
    this.store.setPolicy(loc.token, this.control.sets(loc.token));
  }

  /**
   * Change rules.json. The WebSocket and REST share this. The
   * result says whether the write reached disk; whether the gate took it
   * arrives later, in `net:rules`, by the hash rule.
   */
  applyRules(token: string, op: RulesOp, opId: string, now = Date.now()): ApplyResult {
    const loc = this.store.location(token);
    if (!loc) return { ok: false, error: `No glove network session '${token}'` };
    const result = this.control.apply(loc, this.store.statusRecord(token), op, opId, now, this.accessOf(token));
    this.store.setRules(token, this.control.view(token)!);
    this.store.setPolicy(token, this.control.sets(token));
    return result;
  }

  /** `net:rules:apply` from a socket: apply, and answer that socket. */
  applyFromSocket(socket: NetSocket, token: string, op: RulesOp, opId: string): void {
    const result = this.applyRules(token, op, opId);
    this.send(socket, { type: 'net:rules:result', token, opId, ...result });
  }

  /** Every session with an export, then the registered ones Layman may not read (greyed out in the picker). */
  sessions(): NetSessionSummary[] {
    const listed = this.store.summaries();
    const known = new Set(listed.map((s) => s.token));
    return [...listed, ...this.notObservable.filter((s) => !known.has(s.token))];
  }

  /** The state of glove's registry, for the "upgrade glove" notice. */
  registryView(): GloveRegistryView {
    return this.registry;
  }

  // ─── Sockets ──────────────────────────────────────────────────────────────

  /** A new WebSocket: it gets the (small) session list, and nothing else until it subscribes. */
  attach(socket: NetSocket): void {
    this.subs.set(socket, null);
    this.send(socket, { type: 'net:sessions', sessions: this.sessions(), registry: this.registry });
  }

  detach(socket: NetSocket): void {
    this.subs.delete(socket);
  }

  /** One session at a time per socket; null unsubscribes. */
  subscribe(socket: NetSocket, token: string | null): void {
    this.subs.set(socket, token);
    if (token === null) return;
    const snapshot = this.store.snapshot(token);
    if (snapshot) this.send(socket, { type: 'net:snapshot', token, snapshot });
  }

  private subscribers(token: string): NetSocket[] {
    const out: NetSocket[] = [];
    for (const [socket, t] of this.subs) if (t === token) out.push(socket);
    return out;
  }

  private send(socket: NetSocket, msg: NetServerMessage): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(msg));
  }

  private sendTo(token: string, msg: NetServerMessage): void {
    const targets = this.subscribers(token);
    if (!targets.length) return;
    const json = JSON.stringify(msg);
    for (const s of targets) if (s.readyState === 1) s.send(json);
  }

  /**
   * Coalesce to one delta per session per `coalesceMs`: glove already writes at
   * about 1 Hz per flow, and a burst of opens must not become a burst of frames
   * to every dashboard. The trailing timer guarantees the last state of a burst
   * is sent. A session nobody is watching accumulates nothing — a subscriber
   * starts from a snapshot.
   */
  private onChanged(token: string): void {
    if (!this.subscribers(token).length) {
      this.store.discardDelta(token);
      return;
    }
    if (this.timers.has(token)) return;
    this.timers.set(
      token,
      setTimeout(() => {
        this.timers.delete(token);
        const delta = this.store.takeDelta(token);
        if (delta) this.sendTo(token, { type: 'net:delta', token, delta });
      }, this.coalesceMs),
    );
  }

  /** Re-send the list only when something the picker shows changed. */
  private maybeBroadcastSessions(): void {
    const sessions = this.sessions();
    const sig = JSON.stringify([this.registry, sessions.map((s) => [s.token, s.live, s.rulesOk, s.directFlows > 0, s.harness, s.glove])]);
    if (sig === this.listSig) return;
    this.listSig = sig;
    for (const socket of this.subs.keys()) this.send(socket, { type: 'net:sessions', sessions, registry: this.registry });
  }
}

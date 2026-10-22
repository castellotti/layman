/**
 * A glove session's records over one time window: what the network views show
 * while a time range is set.
 *
 * Built on the server from glove's files, never filtered from the live view.
 * Layman holds only the newest records in memory (the backfill budget, `tail.ts`)
 * and its kept totals have no time axis (`history.ts`), so a past window is not
 * there to filter. The window's records go into a fresh `NetStore`, so a range is
 * counted by the same code as All records. The clip below is the one addition.
 *
 * **The clip.** A flow is in the range when it has a record in it. Its bytes in
 * the range are what moved during it: its cumulative bytes at its last record in
 * the range, less those at its last record before the range (`baseline`). A pooled
 * connection opened yesterday and reused during the range counts only what it
 * carried then. To find that baseline the scan starts `LEAD_IN_MS` before `from`:
 * glove writes an `update` for an open flow every few seconds (measured on a real
 * session: 3 s typically, 30 s at the 99th percentile), so a flow open at `from`
 * has a record in the lead-in. A refusal counts when its record is in the range.
 * Gate records are read up to `to`, so the gate lifecycle (`ended_runs`) is judged
 * as it is live.
 *
 * The gate, rules and session file shown with a range are the current ones:
 * glove keeps no history of them, and the controls act on the gate now.
 */
import { open } from 'fs/promises';
import { closeSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { NetStore, type NetStoreOptions } from './store.js';
import { parseLine, type ParsedLine } from './parse.js';
import { rotatedFiles, splitLines } from './tail.js';
import type {
  ExitRecord, FlowRecord, GateRecord, NetGateView, NetRange, NetRangeInfo, NetSessionFile, NetSnapshot, RulesView,
} from './types.js';

/** How far before `from` the scan starts, to find each open flow's bytes at `from`. */
export const LEAD_IN_MS = 60 * 60_000;
/** Most of glove's files one range reads (8 rotations of 64 MB, glove's default keep). */
export const DEFAULT_RANGE_SCAN_BYTES = 512 * 1024 * 1024;
/** Past `to`, a file's scan stops at the first record this much later: glove writes in time order, nearly. */
const TAIL_SLACK_MS = 60_000;
const CHUNK = 1024 * 1024;
/** How much of a file's start or end is read to find its first or last record time. */
const EDGE_BYTES = 64 * 1024;

/** A range's key: what its frames carry, and what its cached view is found by. */
export function rangeKey(r: NetRange): string {
  return `${r.from}-${r.to ?? 'now'}`;
}

/** A range from a client, or null when it is not one. */
export function parseRange(v: unknown): NetRange | null {
  if (typeof v !== 'object' || v === null) return null;
  const { from, to } = v as { from?: unknown; to?: unknown };
  if (typeof from !== 'number' || !Number.isFinite(from) || from < 0) return null;
  if (to === null || to === undefined) return { from, to: null };
  if (typeof to !== 'number' || !Number.isFinite(to) || to < from) return null;
  return { from, to };
}

/** The live session's current state, which a range shows as it is now. */
export interface RangeContext {
  session: NetSessionFile | null;
  gate: NetGateView | null;
  rules: RulesView | null;
}

/** One session's records for one range, clipped, in a store of its own. */
export class RangeView {
  readonly key: string;
  readonly store: NetStore;
  /** Each flow's cumulative bytes at its last record before `from`. */
  private readonly baseline = new Map<string, { up: number; down: number }>();
  /** Exit records ingested, so one forwarded live after the scan also read it counts once. */
  private readonly exitSeen = new Set<string>();
  /**
   * Flow and gate records the scan read that the live reader may hand over too (`live`):
   * those written while the scan ran, or just before. Kept from `overlapFrom` on only,
   * and dropped once the live reader has caught up (`endOverlap`).
   */
  private overlap: Set<string> | null = new Set();
  private readonly overlapFrom: number;
  private sessionFile: NetSessionFile | null;

  constructor(readonly token: string, readonly range: NetRange, session: NetSessionFile | null, opts: NetStoreOptions = {}, now = Date.now()) {
    this.key = rangeKey(range);
    this.store = new NetStore(opts);
    this.store.ensure({ token, netDir: '', controlDir: '', rulesPath: '' });
    // Before any flow: which services are hops decides how their bytes count.
    this.sessionFile = session;
    this.store.setSessionFile(token, session);
    // Records reach the live reader within a poll of being written; a minute covers glove's own ordering too.
    this.overlapFrom = now - TAIL_SLACK_MS;
  }

  /** glove rewrote session.json: re-flag hops here as the live store does. */
  setSessionFile(file: NetSessionFile | null, now = Date.now()): void {
    if (file === this.sessionFile) return;
    this.sessionFile = file;
    this.store.setSessionFile(this.token, file, now);
  }

  /** The clock flows are classified against: the end of a closed range, as things stood then. */
  clock(now = Date.now()): number {
    return this.range.to === null ? now : Math.min(this.range.to, now);
  }

  private after(t: number): boolean {
    return this.range.to !== null && t > this.range.to;
  }

  flow(rec: FlowRecord, now = Date.now()): void {
    const t = Date.parse(rec.t);
    if (this.after(t)) return;
    if (t < this.range.from) {
      const b = this.baseline.get(rec.id);
      this.baseline.set(rec.id, { up: Math.max(b?.up ?? 0, rec.bytes.up), down: Math.max(b?.down ?? 0, rec.bytes.down) });
      return;
    }
    const b = this.baseline.get(rec.id);
    const bytes = b ? { up: Math.max(0, rec.bytes.up - b.up), down: Math.max(0, rec.bytes.down - b.down) } : rec.bytes;
    this.store.ingestFlow(this.token, b ? { ...rec, bytes } : rec, this.clock(now));
  }

  gate(rec: GateRecord, now = Date.now()): void {
    if (this.after(Date.parse(rec.t))) return;
    this.store.ingestGate(this.token, rec, this.clock(now));
  }

  exit(rec: ExitRecord): void {
    if (this.after(Date.parse(rec.t))) return;
    const k = JSON.stringify(rec);
    if (this.exitSeen.has(k)) return;
    this.exitSeen.add(k);
    this.store.ingestExit(this.token, rec);
  }

  /**
   * One record. `live` ones come from the live reader: a store counts a repeated flow
   * record's bytes once, but not its record count, and a repeated gate record of an old
   * run would revive it, so one the scan already read is skipped.
   */
  record(p: ParsedLine, now = Date.now(), source: 'scan' | 'live' = 'scan'): void {
    if (p.kind === 'exit') {
      this.exit(p.record);
      return;
    }
    if (p.kind !== 'flow' && p.kind !== 'gate') return;
    if (this.overlap && Date.parse(p.record.t) >= this.overlapFrom) {
      const r = p.record;
      const k = p.kind === 'flow'
        ? `f|${p.record.id}|${r.t}|${p.record.phase}|${p.record.bytes.up}|${p.record.bytes.down}`
        : `g|${p.record.run}|${p.record.event}|${r.t}`;
      if (source === 'live' && this.overlap.has(k)) return;
      if (source === 'scan') this.overlap.add(k);
    }
    if (p.kind === 'flow') this.flow(p.record, now);
    else this.gate(p.record, now);
  }

  /** The live reader has caught up with what the scan read: no more overlap to skip. */
  endOverlap(): void {
    this.overlap = null;
  }

  /**
   * The range's snapshot, with the live session's gate and rules as they are now. Its
   * predicted policy is the store's, which the owner keeps current (`store.setPolicy`).
   */
  snapshot(ctx: RangeContext, info: NetRangeInfo): NetSnapshot {
    const s = this.store.snapshot(this.token)!;
    return {
      ...s,
      session: ctx.session ?? s.session,
      gate: ctx.gate ?? s.gate,
      rules: ctx.rules ?? s.rules,
      historyTruncated: info.truncated,
      range: info,
    };
  }
}

interface ScanFile {
  path: string;
  size: number;
  first: number | null;
  last: number | null;
  /** Its first line: which file it is, whatever it is called now (glove renames on rotation). */
  head: string | null;
}

function recordTime(line: string): number | null {
  try {
    const t = (JSON.parse(line) as { t?: unknown }).t;
    const ms = typeof t === 'string' ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** A file's first line, and its first and last record times from its first and last complete lines. */
function edges(path: string, size: number): { first: number | null; last: number | null; head: string | null } {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return { first: null, last: null, head: null };
  }
  try {
    const buf = Buffer.alloc(Math.min(EDGE_BYTES, size));
    readSync(fd, buf, 0, buf.length, 0);
    const nl = buf.indexOf(0x0a);
    const head = nl === -1 ? null : buf.subarray(0, nl).toString('utf8');
    const first = head === null ? null : recordTime(head);
    const start = Math.max(0, size - EDGE_BYTES);
    const tail = Buffer.alloc(size - start);
    readSync(fd, tail, 0, tail.length, start);
    // The last complete line: a live file may end in a line still being written.
    const lines = tail.toString('utf8').split('\n').slice(start > 0 ? 1 : 0).filter((l) => l.trim());
    let last: number | null = null;
    for (let i = lines.length - 1; i >= 0 && last === null; i--) last = recordTime(lines[i]);
    return { first, last, head };
  } finally {
    closeSync(fd);
  }
}

function filesOf(netDir: string, base: string): ScanFile[] {
  const paths = [...rotatedFiles(netDir, base).map((r) => join(netDir, r.file)), join(netDir, `${base}.ndjson`)];
  const out: ScanFile[] = [];
  for (const path of paths) {
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    out.push({ path, size, ...edges(path, size) });
  }
  return out;
}

/** Whether a file can hold records for `range`, counting the lead-in. */
const overlaps = (f: ScanFile, range: NetRange) =>
  (f.last === null || f.last >= range.from - LEAD_IN_MS) && (range.to === null || f.first === null || f.first <= range.to);

/**
 * The flows files that can hold records for `range`, oldest first, within `budget`.
 * Over budget the newest win, as in the backfill, and the range says it was truncated.
 * `filesFrom` is the earliest record the range could read: glove's retention, or the budget's.
 */
export function planScan(netDir: string, range: NetRange, budget: number): { files: ScanFile[]; truncated: boolean; filesFrom: number | null } {
  const all = filesOf(netDir, 'flows');
  const wanted = all.filter((f) => overlaps(f, range));
  let left = budget;
  let truncated = false;
  const files: ScanFile[] = [];
  for (let i = wanted.length - 1; i >= 0; i--) {
    if (wanted[i].size > left) {
      truncated = true;
      break;
    }
    left -= wanted[i].size;
    files.unshift(wanted[i]);
  }
  const from = (truncated ? files : all).find((f) => f.first !== null)?.first ?? null;
  return { files, truncated, filesFrom: from };
}

/**
 * Every complete line of a file, read in chunks so a long scan yields to the event loop.
 * Stops when `onLine` returns false. Resolves to the first line read: which file it was.
 */
async function eachLine(path: string, onLine: (line: string) => boolean, onBytes: (n: number) => void): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return null;
  }
  let head: string | null = null;
  try {
    const buf = Buffer.alloc(CHUNK);
    let partial: Buffer = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (bytesRead === 0) return head;
      onBytes(bytesRead);
      const lines: string[] = [];
      partial = splitLines(partial, buf.subarray(0, bytesRead), lines);
      head ??= lines[0] ?? null;
      for (const line of lines) if (!onLine(line)) return head;
    }
  } finally {
    await fh.close();
  }
}

/** How many times a scan looks again for files glove rotated while it read. */
const ROTATION_PASSES = 3;

export interface BuildOptions {
  budgetBytes?: number;
  onProgress?: (scannedBytes: number, totalBytes: number) => void;
  /** Checked between chunks: true stops the scan (nobody wants the range any more). */
  cancelled?: () => boolean;
}

/** Read a session's files for `view`'s range into it. Resolves to what the range covers. */
export async function buildRange(view: RangeView, netDir: string, opts: BuildOptions = {}): Promise<NetRangeInfo> {
  const { range } = view;
  const plan = planScan(netDir, range, opts.budgetBytes ?? DEFAULT_RANGE_SCAN_BYTES);
  const exits = filesOf(netDir, 'exit');
  const total = plan.files.reduce((a, f) => a + f.size, 0) + exits.reduce((a, f) => a + f.size, 0);
  let scanned = 0;
  const onBytes = (n: number) => {
    scanned += n;
    opts.onProgress?.(scanned, total);
  };
  const live = () => !opts.cancelled?.();

  // Exits first and whole (they are small): the one in effect at `to` may be days older than `from`.
  for (const f of exits) {
    await eachLine(f.path, (line) => {
      view.record(parseLine(line));
      return live();
    }, onBytes);
  }
  const stopAt = range.to === null ? Infinity : range.to + TAIL_SLACK_MS;
  const read = new Set<string>();
  const scan = async (path: string) => {
    const head = await eachLine(path, (line) => {
      const p = parseLine(line);
      if ((p.kind === 'flow' || p.kind === 'gate') && Date.parse(p.record.t) > stopAt) return false;
      view.record(p);
      return live();
    }, onBytes);
    if (head !== null) read.add(head);
  };
  for (const f of plan.files) {
    if (!live()) break;
    await scan(f.path);
  }
  // glove may have rotated while the scan read: the live path then opened its new, near-empty
  // file, and the one the scan meant is under a rotated name it never planned. Files are known
  // by their first line, as the tailer knows them by content. What the live file gained after
  // the scan read it reaches the range through the live reader.
  for (let pass = 0; pass < ROTATION_PASSES && live(); pass++) {
    const missed = filesOf(netDir, 'flows').filter((f) =>
      f.path !== join(netDir, 'flows.ndjson') && f.head !== null && !read.has(f.head) && overlaps(f, range) && (f.last ?? Infinity) >= (plan.files[0]?.first ?? -Infinity));
    if (!missed.length) break;
    for (const f of missed) await scan(f.path);
  }
  return { key: view.key, from: range.from, to: range.to, filesFrom: plan.filesFrom, truncated: plan.truncated, scannedBytes: scanned };
}

/**
 * Offset-based NDJSON tailing that survives glove's rotation, plus a poller for
 * the small JSON files beside it.
 *
 * Polled, never watched: inotify does not cross Docker Desktop's file sharing
 * reliably, and glove made the same choice for its own reload loop.
 *
 * glove's writer (`glove/netgate/writer.py`) guarantees: one complete line per
 * `write(2)` on an `O_APPEND` fd; rotation renames `<base>.ndjson` to
 * `<base>-<stamp>.ndjson` (or `<base>-<stamp>-<n>.ndjson` on a same-millisecond
 * collision) and creates a fresh live file at once, so the live file is never
 * missing. A flow's `close` can land in a newer file than its `open`, which is
 * why the store keys flows by id, not by file, and why a rotated file must be
 * drained to its end by its *new* name.
 *
 * **Files are identified by content, never by inode.** The obvious design (and
 * glove's own reference tailer) follows the inode across the rename, but through
 * Docker Desktop's bind mount — the primary way Layman runs — inode numbers are
 * not stable across a host-side rename: measured, `flows.ndjson` at inode 192
 * reappeared after rotation as `flows-<ts>.ndjson` at inode 194. Matching by
 * inode therefore found nothing, counted a gap and then re-read the rotated file
 * as unseen, on every rotation. Instead the tailer keeps the first bytes it read
 * from the live file (its `head`): the live file has rotated when it no longer
 * starts with them (or is shorter than the read offset), and the rotated file
 * to drain is the one that does. Rotated files glove made meanwhile are told
 * apart by name, which glove never reuses.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;
/**
 * How much of a file's start identifies it. Flow records carry a ULID and a
 * timestamp in their first hundred bytes, so two files agreeing on this many is
 * not a coincidence that happens.
 */
const HEAD_BYTES = 1024;

/** Default per-session backfill budget: one full glove rotation (`rotate.max_bytes`). */
export const DEFAULT_BACKFILL_BYTES = 64 * 1024 * 1024;

interface Cursor {
  offset: number;
  /** Bytes after the last newline: a line still being written. Kept as bytes so a
   *  multi-byte character split across two reads is never mis-decoded. */
  partial: Buffer;
  /** The file's first bytes (up to HEAD_BYTES) as read so far: its identity. */
  head: Buffer;
}

/**
 * Rotation order key for `<base>-<stamp>[-<n>].ndjson`. Lexicographic order of
 * the *names* is wrong in exactly one case: `-` sorts before `.`, so the
 * collision file `…Z-1.ndjson` would sort before the `…Z.ndjson` it followed.
 */
function rotationKey(base: string, file: string): [string, number] | null {
  const m = new RegExp(`^${base}-(.+?)(?:-(\\d+))?\\.ndjson$`).exec(file);
  return m ? [m[1], m[2] ? Number(m[2]) : 0] : null;
}

function compareKeys(a: [string, number], b: [string, number]): number {
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1];
}

function sizeOf(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Whether the file open on `fd` starts with `head`. */
function startsWith(fd: number, head: Buffer): boolean {
  if (!head.length) return true;
  const buf = Buffer.alloc(head.length);
  const n = readSync(fd, buf, 0, head.length, 0);
  return n === head.length && buf.equals(head);
}

/** Split `partial + chunk` into complete lines, returning the new partial. */
function splitLines(partial: Buffer, chunk: Buffer, out: string[]): Buffer {
  const buf = partial.length ? Buffer.concat([partial, chunk]) : chunk;
  let start = 0;
  for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
    pushLine(buf.subarray(start, i), out);
    start = i + 1;
  }
  return Buffer.from(buf.subarray(start));
}

function pushLine(bytes: Buffer, out: string[]): void {
  const line = bytes.toString('utf8').replace(/\r$/, '');
  if (line.trim()) out.push(line);
}

export class NdjsonTailer {
  readonly livePath: string;
  private cur: Cursor | null = null;
  /** Newest rotated file already accounted for — read, or skipped by the budget. */
  private accounted: [string, number] | null = null;
  private started = false;
  /** Backfill stopped at the budget, so older rotated files were never read. */
  historyTruncated = false;
  /** Records may be missing: a rotated file disappeared before it was drained. */
  gaps = 0;

  constructor(
    private readonly dir: string,
    private readonly base: string,
    private readonly budgetBytes = DEFAULT_BACKFILL_BYTES,
  ) {
    this.livePath = join(dir, `${base}.ndjson`);
  }

  /** Complete lines appended since the previous poll, oldest first. */
  poll(): string[] {
    const lines: string[] = [];
    if (!this.started) {
      this.started = true;
      this.backfill(lines);
      return lines;
    }
    let fd: number;
    try {
      fd = openSync(this.livePath, 'r');
    } catch {
      return lines;
    }
    try {
      if (this.cur) {
        const size = fstatSync(fd).size;
        // Rotated (or rewritten): the live path no longer holds the file we were reading.
        if (!startsWith(fd, this.cur.head) || size < this.cur.offset) this.onRotation(lines);
      }
      if (!this.cur) this.cur = { offset: 0, partial: Buffer.alloc(0), head: Buffer.alloc(0) };
      this.readInto(fd, this.cur, lines);
    } finally {
      closeSync(fd);
    }
    return lines;
  }

  private rotated(): Array<{ file: string; key: [string, number] }> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .map((file) => ({ file, key: rotationKey(this.base, file) }))
      .filter((r): r is { file: string; key: [string, number] } => r.key !== null)
      .sort((a, b) => compareKeys(a.key, b.key));
  }

  /**
   * Rotated files oldest first, then the live file, within the byte budget.
   * Over budget, the *newest* files win: they hold the open flows and the
   * current state, and the SQLite rollups keep totals right across restarts.
   */
  private backfill(lines: string[]): void {
    const rotated = this.rotated();
    let budget = this.budgetBytes - (sizeOf(this.livePath) ?? 0);
    const include: string[] = [];
    for (let i = rotated.length - 1; i >= 0; i--) {
      const size = sizeOf(join(this.dir, rotated[i].file));
      if (size === null) continue;
      if (size > budget) {
        this.historyTruncated = true;
        break;
      }
      budget -= size;
      include.unshift(rotated[i].file);
    }
    for (const file of include) this.drain(join(this.dir, file), null, lines);
    if (rotated.length) this.accounted = rotated[rotated.length - 1].key;
    let fd: number;
    try {
      fd = openSync(this.livePath, 'r');
    } catch {
      return;
    }
    try {
      this.cur = { offset: 0, partial: Buffer.alloc(0), head: Buffer.alloc(0) };
      this.readInto(fd, this.cur, lines);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The live file was replaced. Finish the file we were reading — found by its
   * head among the files rotated since the last rotation — and read any other
   * file rotated meanwhile in full, in rotation order.
   */
  private onRotation(lines: string[]): void {
    const old = this.cur!;
    let drained = false;
    const newer = this.rotated().filter((r) => !this.accounted || compareKeys(r.key, this.accounted) > 0);
    for (const r of newer) {
      const path = join(this.dir, r.file);
      if (!drained && old.head.length && this.isContinuation(path, old)) {
        this.drain(path, old, lines);
        drained = true;
      } else {
        this.drain(path, null, lines);
      }
    }
    // Nothing had been read from the old file, so reading every newer rotated
    // file in full already covered it; otherwise its unread tail is gone.
    if (!drained && old.head.length) this.gaps++;
    if (newer.length) this.accounted = newer[newer.length - 1].key;
    this.cur = null;
  }

  private isContinuation(path: string, old: Cursor): boolean {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      return false;
    }
    try {
      return fstatSync(fd).size >= old.offset && startsWith(fd, old.head);
    } finally {
      closeSync(fd);
    }
  }

  /** Read a closed file to EOF, from `from`'s offset or the start. Its unterminated tail is a whole line. */
  private drain(path: string, from: Cursor | null, lines: string[]): void {
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch {
      this.gaps++;
      return;
    }
    try {
      const cursor = from ?? { offset: 0, partial: Buffer.alloc(0), head: Buffer.alloc(0) };
      this.readInto(fd, cursor, lines);
      if (cursor.partial.length) pushLine(cursor.partial, lines);
    } finally {
      closeSync(fd);
    }
  }

  /** Read from `cur.offset` to EOF, advancing the cursor and growing its head. */
  private readInto(fd: number, cur: Cursor, lines: string[]): void {
    const buf = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, cur.offset);
      if (n <= 0) break;
      const chunk = buf.subarray(0, n);
      if (cur.head.length < HEAD_BYTES && cur.offset === cur.head.length) {
        cur.head = Buffer.concat([cur.head, chunk.subarray(0, HEAD_BYTES - cur.head.length)]);
      }
      cur.offset += n;
      cur.partial = splitLines(cur.partial, chunk, lines);
    }
  }
}

/**
 * A small JSON file re-read when it changes (inode, mtime or size).
 *
 * `torn: 'retry'` is for files glove rewrites in place (status.json): a parse
 * error is taken to be a read racing a write, so the previous value is kept and
 * the file re-read next tick. `torn: 'value'` is for rules.json, which every
 * writer replaces atomically: there a parse error is the file's real content and
 * is reported, because an invalid rules file is something the user must see.
 */
export class JsonFileWatcher<T> {
  value: T | null = null;
  exists = false;
  mtimeMs: number | null = null;
  private sig: string | null = null;

  constructor(
    readonly path: string,
    private readonly parse: (text: string) => T | null,
    private readonly torn: 'retry' | 'value' = 'retry',
  ) {}

  /** True when the value (or the file's existence) changed. */
  poll(): boolean {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      if (!this.exists && this.sig === null) return false;
      this.exists = false;
      this.sig = null;
      this.mtimeMs = null;
      this.value = null;
      return true;
    }
    const sig = `${st.ino}:${st.mtimeMs}:${st.size}`;
    if (sig === this.sig) return false;
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return false;
    }
    let value: T | null;
    try {
      value = this.parse(text);
    } catch {
      value = null;
    }
    if (value === null && this.torn === 'retry') return false;
    this.sig = sig;
    this.exists = true;
    this.mtimeMs = st.mtimeMs;
    this.value = value;
    return true;
  }
}

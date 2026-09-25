import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, copyFileSync, mkdtempSync, renameSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JsonFileWatcher, NdjsonTailer } from './tail.js';
import { parseLine } from './parse.js';
import { NetStore } from './store.js';
import type { NetSessionLocation } from './discovery.js';

let dir: string;
const live = () => join(dir, 'flows.ndjson');
const line = (n: number) => JSON.stringify({ n }) + '\n';
const nums = (lines: string[]) => lines.map((l) => JSON.parse(l).n as number);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'netobs-tail-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('NdjsonTailer', () => {
  it('buffers a partial line until its newline arrives', () => {
    writeFileSync(live(), line(1) + '{"n":');
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1]);
    appendFileSync(live(), '2}\n' + line(3));
    expect(nums(t.poll())).toEqual([2, 3]);
    expect(t.poll()).toEqual([]);
  });

  it('never splits a multi-byte character across reads', () => {
    const bytes = Buffer.from('{"s":"é"}\n', 'utf8');
    const cut = bytes.indexOf(0xa9); // second byte of é
    writeFileSync(live(), bytes.subarray(0, cut));
    const t = new NdjsonTailer(dir, 'flows');
    expect(t.poll()).toEqual([]);
    appendFileSync(live(), bytes.subarray(cut));
    expect(t.poll().map((l) => JSON.parse(l).s)).toEqual(['é']);
  });

  it('follows rotation without losing or duplicating a line', () => {
    writeFileSync(live(), line(1) + line(2));
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1, 2]);
    appendFileSync(live(), line(3)); // written, not yet read
    const rotated = join(dir, 'flows-20260923T141443123Z.ndjson');
    renameSync(live(), rotated);
    appendFileSync(rotated, line(4)); // a writer still holding the old fd
    writeFileSync(live(), line(5));
    appendFileSync(live(), line(6));
    expect(nums(t.poll())).toEqual([3, 4, 5, 6]);
    appendFileSync(live(), line(7));
    expect(nums(t.poll())).toEqual([7]);
    expect(t.gaps).toBe(0);
  });

  it('drains a partial line in the rotated file as a whole line', () => {
    writeFileSync(live(), line(1) + '{"n":2}');
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1]);
    renameSync(live(), join(dir, 'flows-20260923T141443123Z.ndjson'));
    writeFileSync(live(), line(3));
    expect(nums(t.poll())).toEqual([2, 3]);
  });

  it('reads files rotated twice between polls, in rotation order', () => {
    writeFileSync(live(), line(1));
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1]);
    appendFileSync(live(), line(2));
    renameSync(live(), join(dir, 'flows-20260923T141443123Z.ndjson'));
    writeFileSync(live(), line(3));
    // Same millisecond: glove appends -1, which sorts *before* the first by name.
    renameSync(live(), join(dir, 'flows-20260923T141443123Z-1.ndjson'));
    writeFileSync(live(), line(4));
    expect(nums(t.poll())).toEqual([2, 3, 4]);
  });

  it('counts a gap when the rotated file is gone before it is drained', () => {
    writeFileSync(live(), line(1));
    const t = new NdjsonTailer(dir, 'flows');
    t.poll();
    appendFileSync(live(), line(2));
    const rotated = join(dir, 'flows-20260923T141443123Z.ndjson');
    renameSync(live(), rotated);
    unlinkSync(rotated);
    writeFileSync(live(), line(3));
    expect(nums(t.poll())).toEqual([3]);
    expect(t.gaps).toBe(1);
  });

  it('restarts from 0 when the live file is truncated in place', () => {
    writeFileSync(live(), line(1) + line(2));
    const t = new NdjsonTailer(dir, 'flows');
    t.poll();
    truncateSync(live(), 0);
    appendFileSync(live(), line(9));
    expect(nums(t.poll())).toEqual([9]);
  });

  it('backfills rotated files oldest first, then the live file', () => {
    writeFileSync(join(dir, 'flows-20260101T000000000Z.ndjson'), line(1));
    writeFileSync(join(dir, 'flows-20260102T000000000Z.ndjson'), line(2));
    writeFileSync(live(), line(3));
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1, 2, 3]);
    expect(t.historyTruncated).toBe(false);
  });

  it('keeps the newest files within the backfill budget and says so', () => {
    const big = line(0).repeat(100); // ~800 bytes
    writeFileSync(join(dir, 'flows-20260101T000000000Z.ndjson'), big);
    writeFileSync(join(dir, 'flows-20260102T000000000Z.ndjson'), line(2));
    writeFileSync(live(), line(3));
    const t = new NdjsonTailer(dir, 'flows', 200);
    expect(nums(t.poll())).toEqual([2, 3]);
    expect(t.historyTruncated).toBe(true);
    // A later rotation does not go back for the skipped file.
    appendFileSync(live(), line(4));
    renameSync(live(), join(dir, 'flows-20260103T000000000Z.ndjson'));
    writeFileSync(live(), line(5));
    expect(nums(t.poll())).toEqual([4, 5]);
  });

  /**
   * Docker Desktop's bind mount does not keep inode numbers across a host-side
   * rename (measured: 192 became 194), so these simulate exactly that with a
   * copy, which always gets a new inode. Following inodes fails both.
   */
  it('drains the rotated file even when the rename gave it a new inode', () => {
    writeFileSync(live(), line(1));
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1]);
    appendFileSync(live(), line(2));
    const rotated = join(dir, 'flows-20260923T141443123Z.ndjson');
    copyFileSync(live(), rotated); // new inode, same content
    unlinkSync(live());
    writeFileSync(live(), line(3));
    expect(nums(t.poll())).toEqual([2, 3]);
    expect(t.gaps).toBe(0);
  });

  it('does not mistake a new inode with the same content for a rotation', () => {
    writeFileSync(live(), line(1) + line(2));
    const t = new NdjsonTailer(dir, 'flows');
    expect(nums(t.poll())).toEqual([1, 2]);
    const tmp = join(dir, 'tmp');
    copyFileSync(live(), tmp);
    renameSync(tmp, live()); // same bytes, different inode
    appendFileSync(live(), line(3));
    expect(nums(t.poll())).toEqual([3]);
    expect(t.gaps).toBe(0);
  });

  it('waits for the live file to appear', () => {
    const t = new NdjsonTailer(dir, 'flows');
    expect(t.poll()).toEqual([]);
    writeFileSync(live(), line(1));
    expect(nums(t.poll())).toEqual([1]);
  });
});

describe('flow state across rotated files', () => {
  it('a close in a newer file finishes the flow its open began in an older one', () => {
    const rec = (phase: string, t: string, up: number, extra: object = {}) =>
      JSON.stringify({
        v: 1, type: 'flow', phase, id: 'f_1', env: 'e', session: 'e', t, t_open: '2026-09-23T00:00:00.000Z',
        service: 'proxy', tool: 'web_fetch', client: 'harness', proto: 'http-connect',
        dest: { host: 'arxiv.org', port: 443, ip: '151.101.3.42', resolution: 'in-tunnel' },
        scope: 'tunnelled', route: { kind: 'vpn', upstream: null }, bytes: { up, down: up * 10 },
        verdict: 'allow', rule: null, close_reason: null, request: null, ...extra,
      }) + '\n';
    const loc: NetSessionLocation = { token: 'e', env: 'e', name: 'e', netDir: dir, controlDir: dir, rulesPath: join(dir, 'r') };
    const store = new NetStore();
    store.ensure(loc);
    const t = new NdjsonTailer(dir, 'flows');
    const feed = () => {
      for (const l of t.poll()) {
        const p = parseLine(l);
        if (p.kind === 'flow') store.ingestFlow('e', p.record, Date.parse('2026-09-23T00:00:05.000Z'));
      }
    };
    writeFileSync(live(), rec('open', '2026-09-23T00:00:00.000Z', 10));
    feed();
    renameSync(live(), join(dir, 'flows-20260923T000001000Z.ndjson'));
    writeFileSync(live(), rec('update', '2026-09-23T00:00:01.000Z', 20));
    appendFileSync(live(), rec('close', '2026-09-23T00:00:02.000Z', 30, { close_reason: 'eof', t_close: '2026-09-23T00:00:02.000Z' }));
    feed();
    const snap = store.snapshot('e')!;
    expect(snap.flows).toHaveLength(1);
    expect(snap.flows[0]).toMatchObject({ phase: 'close', state: 'finished', bytes: { up: 30, down: 300 } });
    expect(snap.totals).toMatchObject({ bytesUp: 30, bytesDown: 300, flows: 1, openFlows: 0 });
  });
});

describe('parseLine', () => {
  const base = {
    v: 1, type: 'flow', phase: 'open', id: 'f_1', env: 'e', session: 'e', t: '2026-09-23T00:00:00.000Z',
    t_open: '2026-09-23T00:00:00.000Z', service: 'proxy', dest: { host: 'a.b', port: 443, ip: null, resolution: 'unavailable' },
    bytes: { up: 1, down: 2 },
  };
  it('rejects torn JSON as invalid', () => {
    expect(parseLine('{"v":1,"type":"flow","ph').kind).toBe('invalid');
  });
  it('skips an unknown type', () => {
    expect(parseLine(JSON.stringify({ v: 1, type: 'dns', q: 'x' })).kind).toBe('skipped');
  });
  it('ignores unknown fields', () => {
    const p = parseLine(JSON.stringify({ ...base, novel: { deep: true }, dest: { ...base.dest, asn: 13335 } }));
    expect(p.kind).toBe('flow');
    expect(p.kind === 'flow' && p.record.dest).toEqual(base.dest);
  });
  it('counts v: 2 as invalid rather than guessing at it', () => {
    expect(parseLine(JSON.stringify({ ...base, v: 2 })).kind).toBe('invalid');
  });
  it('rejects a flow missing its id or with an unknown phase', () => {
    expect(parseLine(JSON.stringify({ ...base, id: undefined })).kind).toBe('invalid');
    expect(parseLine(JSON.stringify({ ...base, phase: 'reopen' })).kind).toBe('invalid');
  });
});

describe('JsonFileWatcher', () => {
  it('keeps the previous value through a torn read and retries', () => {
    const p = join(dir, 'status.json');
    writeFileSync(p, JSON.stringify({ v: 1, state: 'running' }));
    const w = new JsonFileWatcher(p, (t) => JSON.parse(t) as { state: string });
    expect(w.poll()).toBe(true);
    expect(w.value?.state).toBe('running');
    writeFileSync(p, '{"v":1,"sta');
    expect(w.poll()).toBe(false);
    expect(w.value?.state).toBe('running');
    writeFileSync(p, JSON.stringify({ v: 1, state: 'stopped' }));
    expect(w.poll()).toBe(true);
    expect(w.value?.state).toBe('stopped');
  });

  it("reports an unparseable file as its value in 'value' mode", () => {
    const p = join(dir, 'rules.json');
    writeFileSync(p, 'not json');
    const w = new JsonFileWatcher(p, (t) => {
      try {
        return { ok: true, v: JSON.parse(t) };
      } catch {
        return { ok: false, v: null };
      }
    }, 'value');
    expect(w.poll()).toBe(true);
    expect(w.value).toEqual({ ok: false, v: null });
    unlinkSync(p);
    expect(w.poll()).toBe(true);
    expect(w.exists).toBe(false);
  });
});

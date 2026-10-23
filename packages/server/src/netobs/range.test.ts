import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NetObs, type NetServerMessage, type NetSocket } from './index.js';
import { NetStore } from './store.js';
import { LEAD_IN_MS, RangeView, buildRange, parseRange, planScan, rangeKey } from './range.js';
import { addGloveSession } from './testing/glove-home.js';
import type { ExitRecord, FlowRecord, GateRecord, NetRange } from './types.js';

const T0 = Date.parse('2026-10-21T00:00:00.000Z');
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

function rec(id: string, phase: FlowRecord['phase'], t: number, up: number, down: number, over: Partial<FlowRecord> = {}): FlowRecord {
  return {
    v: 1, type: 'flow', phase, id, env: 'e', session: 'e', t: iso(t), t_open: iso(over.t_open ? Date.parse(over.t_open) : t),
    t_close: phase === 'close' ? iso(t) : null, service: 'proxy', tool: 'web_fetch', client: 'harness',
    proto: 'http-connect', dest: { host: 'arxiv.org', port: 443, ip: '151.101.3.42', resolution: 'in-tunnel' },
    scope: 'tunnelled', route: { kind: 'vpn', upstream: null }, bytes: { up, down },
    verdict: 'allow', rule: null, close_reason: phase === 'close' ? 'eof' : null, request: null, run: null, ...over,
  };
}

const exit = (t: number, ip: string): ExitRecord => ({
  v: 1, type: 'exit', t: iso(t), env: 'e', session: 'e', kind: 'vpn', ip, country: 'Sweden', city: null,
  lat: null, lon: null, source: 'gluetun', healthy: true,
} as ExitRecord);

const gateRec = (t: number, event: 'start' | 'stop', run: string, service: string | null = 'proxy'): GateRecord => ({
  v: 1, type: 'gate', event, role: service === null ? 'collect' : 'forward', run, service, env: 'e', session: 'e', t: iso(t), inferred: false,
});

const ndjson = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');

function view(range: NetRange, records: FlowRecord[]): RangeView {
  const v = new RangeView('e', range, null);
  for (const r of records) v.flow(r, T0 + 24 * 60 * MIN);
  return v;
}
const totalsOf = (v: RangeView) => v.store.snapshot('e')!.totals;

describe('RangeView: the clip', () => {
  const from = T0 + 60 * MIN;
  const to = T0 + 120 * MIN;

  it('counts only what a pooled connection moved during the range, at both edges', () => {
    const open = { t_open: iso(T0) };
    const v = view({ from, to }, [
      rec('f1', 'open', T0, 100, 1000, open),
      rec('f1', 'update', from - 2 * MIN, 200, 2000, open), // the baseline
      rec('f1', 'update', from + 5 * MIN, 500, 5000, open),
      rec('f1', 'update', to + 5 * MIN, 900, 9000, open), // after the range
    ]);
    expect(totalsOf(v)).toMatchObject({ bytesUp: 300, bytesDown: 3000, flows: 1 });
    // The connection opened when it did: the range does not move its start.
    expect(v.store.snapshot('e')!.flows[0].tOpen).toBe(T0);
  });

  it('a connection that only kept alive during the range is in it, having moved nothing', () => {
    const open = { t_open: iso(T0) };
    const v = view({ from, to }, [
      rec('f1', 'update', from - MIN, 50, 500, open),
      rec('f1', 'update', from + MIN, 50, 500, open),
    ]);
    expect(totalsOf(v)).toMatchObject({ bytesUp: 0, bytesDown: 0, flows: 1 });
  });

  it('leaves out flows wholly before or after it, and an empty range shows nothing', () => {
    const v = view({ from, to }, [
      rec('early', 'close', from - 10 * MIN, 10, 10),
      rec('late', 'open', to + MIN, 10, 10),
    ]);
    expect(totalsOf(v)).toMatchObject({ bytesUp: 0, bytesDown: 0, flows: 0, destinations: 0 });
  });

  it('counts a refusal when its record is in the range', () => {
    const block = { verdict: 'block', rule: 'r_1', close_reason: 'blocked' } as const;
    const v = view({ from, to }, [
      rec('b1', 'close', from - MIN, 0, 0, block),
      rec('b2', 'close', from + MIN, 0, 0, block),
    ]);
    expect(totalsOf(v).blocked.userRule).toBe(1);
  });

  it('keeps the exit in effect at the end of the range, once each', () => {
    const v = new RangeView('e', { from, to }, null);
    v.exit(exit(T0, '1.1.1.1'));
    v.exit(exit(from + MIN, '2.2.2.2'));
    v.exit(exit(from + MIN, '2.2.2.2')); // read by the scan and forwarded live
    v.exit(exit(to + MIN, '3.3.3.3'));
    const snap = v.store.snapshot('e')!;
    expect(snap.exit?.ip).toBe('2.2.2.2');
    expect(snap.exits.map((x) => x.ip)).toEqual(['1.1.1.1', '2.2.2.2']);
  });

  it('classifies a closed range as things stood at its end', () => {
    const v = new RangeView('e', { from, to }, null);
    expect(v.clock(to + 99 * MIN)).toBe(to);
    expect(new RangeView('e', { from, to: null }, null).clock(to + 99 * MIN)).toBe(to + 99 * MIN);
  });
});

describe('parseRange and rangeKey', () => {
  it('accepts a closed or open range, and nothing else', () => {
    expect(parseRange({ from: 5, to: 9 })).toEqual({ from: 5, to: 9 });
    expect(parseRange({ from: 5, to: null })).toEqual({ from: 5, to: null });
    expect(parseRange({ from: 5 })).toEqual({ from: 5, to: null });
    for (const bad of [null, undefined, 3, {}, { from: -1 }, { from: 9, to: 5 }, { from: '5' }, { from: 5, to: 'x' }, { from: Infinity }]) {
      expect(parseRange(bad)).toBeNull();
    }
    expect(rangeKey({ from: 5, to: null })).toBe('5-now');
    expect(rangeKey({ from: 5, to: 9 })).toBe('5-9');
  });
});

describe('buildRange: reading glove’s files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'netobs-range-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Day one in a rotated file, day two in the live one; a flow per hour, 10/100 bytes each. */
  function twoDays(): FlowRecord[] {
    const all: FlowRecord[] = [];
    for (let h = 0; h < 48; h++) {
      const t = T0 + h * 60 * MIN;
      all.push(rec(`f${h}`, 'open', t, 0, 0), rec(`f${h}`, 'close', t + MIN, 10, 100));
    }
    writeFileSync(join(dir, 'flows-20261022T000000000Z.ndjson'), ndjson(all.slice(0, 48)));
    writeFileSync(join(dir, 'flows.ndjson'), ndjson(all.slice(48)));
    return all;
  }

  it('reads a range across a rotation boundary', async () => {
    twoDays();
    const range = { from: T0 + 22 * 60 * MIN, to: T0 + 26 * 60 * MIN - 1 }; // hours 22–25
    const v = new RangeView('e', range, null);
    const info = await buildRange(v, dir);
    expect(totalsOf(v)).toMatchObject({ flows: 4, bytesUp: 40, bytesDown: 400 });
    expect(info).toMatchObject({ key: rangeKey(range), truncated: false, filesFrom: T0, sessionFrom: T0 });
  });

  it('skips files that end before the lead-in, and says when the range starts before glove’s files', async () => {
    twoDays();
    const day2 = { from: T0 + 30 * 60 * MIN, to: null };
    const plan = planScan(dir, day2, Infinity);
    expect(plan.files.map((f) => f.path.endsWith('flows.ndjson'))).toEqual([true]);

    // The lead-in reaches back into the rotated file for a range starting just after its last record…
    const rotatedLast = T0 + 23 * 60 * MIN + MIN;
    expect(planScan(dir, { from: rotatedLast + LEAD_IN_MS / 2, to: null }, Infinity).files).toHaveLength(2);
    // …and no further.
    expect(planScan(dir, { from: rotatedLast + LEAD_IN_MS + 1, to: null }, Infinity).files).toHaveLength(1);

    const before = new RangeView('e', { from: T0 - 24 * 60 * MIN, to: T0 + 60 * MIN }, null);
    const info = await buildRange(before, dir);
    expect(info.filesFrom).toBe(T0);
    expect(info.filesFrom! > before.range.from).toBe(true);
  });

  it('over the byte budget, keeps the newest files and says the range was truncated', async () => {
    twoDays();
    const live = planScan(dir, { from: 0, to: null }, Infinity).files.at(-1)!;
    const v = new RangeView('e', { from: 0, to: null }, null);
    const info = await buildRange(v, dir, { budgetBytes: live.size });
    expect(info.truncated).toBe(true);
    expect(info.filesFrom).toBe(T0 + 24 * 60 * MIN);
    expect(totalsOf(v).flows).toBe(24);
  });

  it('a range around everything counts exactly what All records does', async () => {
    const all = twoDays();
    // Pooled flows, a hop-free refusal and a forwarder lifecycle, so more than the plain path is compared.
    const extra: Array<FlowRecord | GateRecord> = [
      gateRec(T0 + 47 * 60 * MIN, 'start', 'g_1'),
      rec('p1', 'open', T0 + 47 * 60 * MIN, 1, 1, { run: 'g_1' }),
      rec('p1', 'update', T0 + 47 * 60 * MIN + 5000, 70, 700, { run: 'g_1', t_open: iso(T0 + 47 * 60 * MIN) }),
      rec('b1', 'close', T0 + 47 * 60 * MIN, 0, 0, { verdict: 'block', rule: 'builtin:metadata', close_reason: 'blocked', dest: { host: '169.254.169.254', port: 80, ip: null, resolution: 'literal' } }),
    ];
    appendFileSync(join(dir, 'flows.ndjson'), ndjson(extra));
    const now = T0 + 48 * 60 * MIN;
    const live = new NetStore();
    live.ensure({ token: 'e', netDir: dir, controlDir: '', rulesPath: '' });
    for (const r of [...all, ...extra]) {
      if (r.type === 'flow') live.ingestFlow('e', r, now);
      else live.ingestGate('e', r, now);
    }
    const v = new RangeView('e', { from: 0, to: null }, null);
    await buildRange(v, dir);
    v.store.tick(now);
    live.tick(now);
    const a = live.snapshot('e')!;
    const b = v.store.snapshot('e')!;
    expect(b.totals).toEqual(a.totals);
    const strip = (d: typeof a.destinations) => d.map(({ spark: _s, ...rest }) => rest).sort((x, y) => x.key.localeCompare(y.key));
    expect(strip(b.destinations)).toEqual(strip(a.destinations));
  });

  it('reads the file glove rotated away while the scan was reading an older one', async () => {
    twoDays();
    const v = new RangeView('e', { from: 0, to: null }, null);
    let rotated = false;
    await buildRange(v, dir, {
      // Mid-scan, while the rotated file is being read: day two rotates, and a new live file starts.
      onProgress: () => {
        if (rotated) return;
        rotated = true;
        renameSync(join(dir, 'flows.ndjson'), join(dir, 'flows-20261023T000000000Z.ndjson'));
        writeFileSync(join(dir, 'flows.ndjson'), ndjson([rec('day3', 'close', T0 + 49 * 60 * MIN, 1, 1)]));
      },
    });
    expect(rotated).toBe(true);
    expect(totalsOf(v).flows).toBe(49);
  });

  it('does not count a record twice when the scan and the live reader both hand it over', () => {
    const v = new RangeView('e', { from: 0, to: null }, null, {}, T0);
    const line = { kind: 'flow' as const, record: rec('f1', 'close', T0 + 1000, 5, 50) };
    v.record(line, T0, 'scan');
    v.record(line, T0, 'live');
    expect(v.store.snapshot('e')!.counters.records).toBe(1);
    // Once the live reader has caught up, a record it hands over is new, whatever its content.
    v.endOverlap();
    v.record(line, T0, 'live');
    expect(v.store.snapshot('e')!.counters.records).toBe(2);
  });

  describe('the part glove no longer holds, from the hourly history', () => {
    /** All records, read once from everything: its hours are what Layman kept. */
    const allRecords = (records: FlowRecord[]) => {
      const live = new NetStore();
      live.ensure({ token: 'e', netDir: '', controlDir: '', rulesPath: '' });
      for (const r of records) live.ingestFlow('e', r, T0 + 72 * 60 * MIN);
      return live;
    };
    const hourlyOf = (live: NetStore) => ({ hours: live.hourly('e'), dests: live.snapshot('e')!.destinations });

    it('answers a range across deleted files with each hour counted once: equal to All records', async () => {
      const live = allRecords(twoDays());
      rmSync(join(dir, 'flows-20261022T000000000Z.ndjson')); // glove deleted day one
      const v = new RangeView('e', { from: 0, to: null }, null);
      const info = await buildRange(v, dir, { hourly: hourlyOf(live), sessionFrom: T0 });
      expect(info.hourly).toEqual({ from: T0, to: T0 + 24 * 60 * MIN });
      const a = live.snapshot('e')!;
      const b = v.store.snapshot('e')!;
      expect(b.totals).toMatchObject({ flows: a.totals.flows, bytesUp: a.totals.bytesUp, bytesDown: a.totals.bytesDown });
      expect(b.destinations.map((d) => [d.key, d.bytesUp, d.flows])).toEqual(a.destinations.map((d) => [d.key, d.bytesUp, d.flows]));
    });

    it('hands over at the hour after the files begin, so a mid-hour start is neither lost nor counted twice', async () => {
      const recs = [
        rec('gone', 'close', T0 + 10 * MIN, 1, 10), // deleted
        rec('kept', 'close', T0 + 40 * MIN, 2, 20), // in the files, and in the hour the history answers
        rec('late', 'close', T0 + 2 * 60 * MIN, 4, 40),
      ];
      const live = allRecords(recs);
      writeFileSync(join(dir, 'flows.ndjson'), ndjson(recs.slice(1)));
      const v = new RangeView('e', { from: 0, to: null }, null);
      const info = await buildRange(v, dir, { hourly: hourlyOf(live), sessionFrom: T0 + 10 * MIN });
      expect(info.hourly).toEqual({ from: T0, to: T0 + 60 * MIN });
      expect(totalsOf(v)).toMatchObject({ flows: 3, bytesUp: 7 });
    });

    it('answers a session whose files are gone from the hours alone', async () => {
      const live = allRecords(twoDays());
      const v = new RangeView('e', { from: T0 + 2 * 60 * MIN, to: T0 + 4 * 60 * MIN - 1 }, null);
      const info = await buildRange(v, null, { hourly: hourlyOf(live), sessionFrom: T0 });
      // Whole hours: 02:00 to 03:59 is two hours of one flow each.
      expect(info.hourly).toEqual({ from: T0 + 2 * 60 * MIN, to: T0 + 4 * 60 * MIN });
      expect([info.filesFrom, info.scannedBytes]).toEqual([null, 0]);
      expect(totalsOf(v)).toMatchObject({ flows: 2, bytesUp: 20 });
    });

    it('fills what the budget skipped too, and leaves alone a range glove kept in full', async () => {
      const live = allRecords(twoDays());
      const liveFile = planScan(dir, { from: 0, to: null }, Infinity).files.at(-1)!;
      const cut = new RangeView('e', { from: 0, to: null }, null);
      const info = await buildRange(cut, dir, { budgetBytes: liveFile.size, hourly: hourlyOf(live), sessionFrom: T0 });
      expect([info.truncated, info.hourly?.from]).toEqual([true, T0]);
      expect(totalsOf(cut).flows).toBe(48);
      // Everything on disk: the history is not used, whatever the range.
      const whole = new RangeView('e', { from: T0 - 60 * MIN, to: null }, null);
      expect((await buildRange(whole, dir, { hourly: hourlyOf(live), sessionFrom: T0 })).hourly).toBeNull();
      expect(totalsOf(whole).flows).toBe(48);
    });
  });

  it('stops when nobody wants the range any more', async () => {
    twoDays();
    const v = new RangeView('e', { from: 0, to: null }, null);
    await buildRange(v, dir, { cancelled: () => true });
    expect(totalsOf(v).flows).toBe(0);
  });
});

class FakeSocket implements NetSocket {
  readyState = 1;
  sent: NetServerMessage[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  of<T extends NetServerMessage['type']>(type: T) {
    return this.sent.filter((m) => m.type === type) as Extract<NetServerMessage, { type: T }>[];
  }
}

describe('NetObs: ranged subscriptions', () => {
  const E = 'e-000000';
  let home: string;
  let net: string;
  let obs: NetObs;
  const now = Date.now();
  const hourAgo = now - 60 * MIN;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'netobs-ranges-'));
    net = addGloveSession(home, E).net;
    writeFileSync(join(net, 'flows.ndjson'), ndjson([
      rec('old', 'close', now - 3 * 60 * MIN, 5, 50),
      rec('mid', 'close', hourAgo + MIN, 7, 70),
    ]));
    obs = new NetObs({ getGloveHome: () => home, coalesceMs: 5 });
    obs.poll(now);
  });
  afterEach(() => {
    obs.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('without a range, the snapshot is All records, as before', () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E);
    const snap = s.of('net:snapshot')[0].snapshot;
    expect(snap.range).toBeNull();
    expect(snap).toEqual(obs.store.snapshot(E));
  });

  it('a range’s snapshot arrives once its files are read, and a later subscriber gets it at once', async () => {
    const range = { from: hourAgo, to: hourAgo + 10 * MIN };
    const a = new FakeSocket();
    obs.attach(a);
    obs.subscribe(a, E, range);
    expect(a.of('net:snapshot')).toHaveLength(0);
    await vi.waitFor(() => expect(a.of('net:snapshot')).toHaveLength(1));
    const snap = a.of('net:snapshot')[0].snapshot;
    expect(snap.range).toMatchObject({ key: rangeKey(range), from: range.from, to: range.to, truncated: false });
    expect(snap.totals).toMatchObject({ flows: 1, bytesUp: 7, bytesDown: 70 });
    // The gate and rules are the live session's.
    expect(snap.gate).toEqual(obs.store.gate(E));

    const b = new FakeSocket();
    obs.attach(b);
    obs.subscribe(b, E, range);
    expect(b.of('net:snapshot')).toHaveLength(1);
  });

  it('a range that ended gets no deltas; one running until now follows the gate', async () => {
    const closed = new FakeSocket();
    const open = new FakeSocket();
    const all = new FakeSocket();
    for (const s of [closed, open, all]) obs.attach(s);
    obs.subscribe(closed, E, { from: hourAgo, to: hourAgo + 10 * MIN });
    obs.subscribe(open, E, { from: hourAgo, to: null });
    obs.subscribe(all, E);
    await vi.waitFor(() => expect(open.of('net:snapshot')).toHaveLength(1));
    await vi.waitFor(() => expect(closed.of('net:snapshot')).toHaveLength(1));

    appendFileSync(join(net, 'flows.ndjson'), ndjson([rec('new', 'open', now + 1000, 3, 30)]));
    obs.poll(now + 2000);
    await vi.waitFor(() => expect(open.of('net:delta')).toHaveLength(1));
    await vi.waitFor(() => expect(all.of('net:delta')).toHaveLength(1));
    expect(open.of('net:delta')[0]).toMatchObject({ range: rangeKey({ from: hourAgo, to: null }) });
    expect(open.of('net:delta')[0].delta.totals).toMatchObject({ flows: 2, bytesUp: 10 });
    expect(all.of('net:delta')[0]).toMatchObject({ range: null });
    expect(all.of('net:delta')[0].delta.totals).toMatchObject({ flows: 3 });
    await new Promise((r) => setTimeout(r, 30));
    expect(closed.of('net:delta')).toHaveLength(0);
  });

  it('never sends a range the socket has moved on from', async () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E, { from: hourAgo, to: hourAgo + 10 * MIN });
    obs.subscribe(s, E);
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of('net:snapshot').map((m) => m.snapshot.range)).toEqual([null]);
  });

  it('records read live while a range is being read are counted once', async () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E, { from: hourAgo, to: null });
    // Polled before the scan has finished: the record is both in the file the scan reads and forwarded.
    appendFileSync(join(net, 'flows.ndjson'), ndjson([rec('new', 'close', now + 1000, 3, 30)]));
    obs.poll(now + 2000);
    await vi.waitFor(() => expect(s.of('net:snapshot')).toHaveLength(1));
    const snap = s.of('net:snapshot')[0].snapshot;
    expect(snap.totals).toMatchObject({ flows: 2, bytesUp: 10 });
    // The two in the range, each once ('old' is before it: a baseline, not a record of the range).
    expect(snap.counters.records).toBe(2);
  });

  it('answers what is not a range with an error under the key the client gave it, never with All records', () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E, { from: -86_400_000, to: null });
    obs.subscribe(s, E, { from: 9, to: 5 });
    expect(s.of('net:range:error').map((m) => m.range)).toEqual(['-86400000-now', '9-5']);
    expect(s.of('net:snapshot')).toHaveLength(0);
  });

  it('answers a range it cannot build, rather than leaving the socket waiting', () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, 'nobody-000000', { from: 0, to: null });
    expect(s.of('net:range:error')[0]).toMatchObject({ token: 'nobody-000000', range: '0-now' });

    obs.store.setHistory({
      token: 'gone-000000', filterSince: null, filterSawDir: false, firstSeen: 0, lastSeen: 0, watermark: 0, carry: {},
      bytesUp: 0, bytesDown: 0, flows: 0, blockedGuard: 0, blockedRule: 0, blockedDefault: 0, directFlows: 0,
      lastExit: null, lastStatus: null, sessionFile: null, destinations: [],
    });
    obs.subscribe(s, 'gone-000000', { from: 0, to: null });
    expect(s.of('net:range:error')[1].error).toMatch(/files for this session are gone/);
    expect(s.of('net:snapshot')).toHaveLength(0);
  });

  it('serves a range of a session whose files are gone from the hours Layman kept', async () => {
    const hour = Math.floor(hourAgo / 3_600_000) * 3_600_000;
    obs.store.setHistory({
      token: 'kept-000000', filterSince: null, filterSawDir: false, firstSeen: hour, lastSeen: hour + 60_000, watermark: hour + 60_000, carry: {},
      bytesUp: 5, bytesDown: 50, flows: 1, blockedGuard: 0, blockedRule: 0, blockedDefault: 0, directFlows: 0,
      lastExit: null, lastStatus: null, sessionFile: null,
      destinations: [{ key: 'arxiv.org:443', host: 'arxiv.org', port: 443, groupKey: 'arxiv.org', lastIp: null, scope: 'tunnelled', resolution: 'in-tunnel',
        tool: 'web_fetch', firstSeen: hour, lastSeen: hour + 60_000, bytesUp: 5, bytesDown: 50, flows: 1, blocked: 0, lastState: 'finished', hop: false }],
      hours: [{ hour, run: null, key: 'arxiv.org:443', tool: 'web_fetch', hop: false, bytesUp: 5, bytesDown: 50, flows: 1, blocked: 0, first: hour, last: hour + 60_000 }],
      runs: [],
    });
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, 'kept-000000', { from: hour, to: hour + 3_600_000 });
    await vi.waitFor(() => expect(s.of('net:snapshot')).toHaveLength(1));
    const snap = s.of('net:snapshot')[0].snapshot;
    expect(snap.range).toMatchObject({ filesFrom: null, hourly: { from: hour, to: hour + 3_600_000 } });
    expect(snap.totals).toMatchObject({ flows: 1, bytesUp: 5, bytesDown: 50 });
    expect(snap.destinations.map((d) => d.key)).toEqual(['arxiv.org:443']);
  });

  it('stop() ends a scan still running, and sends nothing after', async () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E, { from: 0, to: null });
    obs.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(s.of('net:snapshot')).toHaveLength(0);
  });

  it('a watched range follows a rewritten session.json, as All records does', async () => {
    const s = new FakeSocket();
    obs.attach(s);
    obs.subscribe(s, E, { from: hourAgo, to: null });
    await vi.waitFor(() => expect(s.of('net:snapshot')).toHaveLength(1));
    writeFileSync(join(net, 'session.json'), JSON.stringify({ v: 1, type: 'session', env: E, session: E, harness: 'pi', services: [] }));
    obs.poll(now + 1000);
    const entry = [...(obs as unknown as { ranges: Map<string, { view: RangeView }> }).ranges.values()][0];
    expect(obs.store.sessionFile(E)).not.toBeNull();
    expect(entry.view.store.sessionFile(E)).toEqual(obs.store.sessionFile(E));
  });

  it('keeps the ranges last looked at, and drops an idle one that still reaches into the present', async () => {
    const ranges = () => [...(obs as unknown as { ranges: Map<string, unknown> }).ranges.keys()].map((id) => id.split('|')[1]);
    const sleep = () => new Promise((r) => setTimeout(r, 3));
    const r = (k: number) => ({ from: hourAgo - k * MIN, to: hourAgo });
    const watcher = new FakeSocket();
    const browser = new FakeSocket();
    obs.attach(watcher);
    obs.attach(browser);
    const open = async (s: FakeSocket, range: NetRange) => {
      obs.subscribe(s, E, range);
      await vi.waitFor(() => expect(s.of('net:snapshot').at(-1)?.snapshot.range?.key).toBe(rangeKey(range)));
      await sleep();
    };
    await open(watcher, r(0)); // A, watched for a long time
    await open(browser, r(1)); // B, glanced at meanwhile
    obs.subscribe(browser, null);
    await sleep();
    obs.subscribe(watcher, null); // A last used now, after B
    await sleep();
    for (const k of [2, 3, 4]) await open(browser, r(k)); // C, D, then E (still watched)
    obs.subscribe(browser, null);
    // Five idle, four kept: B goes, not A.
    expect(ranges().sort()).toEqual([r(0), r(2), r(3), r(4)].map(rangeKey).sort());

    await open(browser, { from: hourAgo, to: null });
    obs.subscribe(browser, null);
    expect(ranges()).not.toContain(rangeKey({ from: hourAgo, to: null }));
  });
});

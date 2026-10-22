/**
 * Plan §5.6 "restart keeps totals; no double counting": every restart below
 * must show exactly what one uninterrupted read of the same records shows, and
 * keep what later disappeared from the files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { HistorySession, NetHistory } from './history.js';
import { NetObs } from './index.js';
import { hourKey } from './store.js';
import { TEST_ID, addGloveSession } from './testing/glove-home.js';
import { roundsRecords, roundsSessionFile } from './testing/rounds.js';
import type { DestinationAggregate, NetSnapshot, NetTotals } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__');
const TOKEN = TEST_ID;
const NOW = Date.parse('2026-09-23T14:14:48.000Z');
const LINES = readFileSync(join(FIXTURE, 'flows.ndjson'), 'utf8').split('\n').filter(Boolean);

/** Rollups in memory, as SQLite would keep them: rows replaced, hours and runs upserted. */
class MemHistory implements NetHistory {
  rows = new Map<string, HistorySession>();
  saves = 0;
  constructor(public on = true) {}
  enabled(): boolean { return this.on; }
  load(): HistorySession[] { return [...this.rows.values()].map((r) => structuredClone(r)); }
  save(rows: HistorySession[]): void {
    this.saves++;
    for (const r of rows) {
      const was = this.rows.get(r.token);
      const merge = <T>(old: T[] | undefined, next: T[] | undefined, key: (x: T) => string) =>
        [...new Map([...(old ?? []), ...(next ?? [])].map((x) => [key(x), x])).values()];
      this.rows.set(r.token, structuredClone({
        ...r,
        // Keyed as net_hours is (`hourKey`), and in the store's order.
        hours: merge(was?.hours, r.hours, (h) => hourKey(h.hour, h.run, h.key, h.tool)).sort((a, b) =>
          a.hour - b.hour || (a.run ?? '').localeCompare(b.run ?? '') || a.key.localeCompare(b.key) || (a.tool ?? '').localeCompare(b.tool ?? '')),
        runs: merge(was?.runs, r.runs, (x) => x.run),
      }));
    }
  }
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'netobs-history-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeSession(lines: string[], dir = FIXTURE, token = TOKEN): void {
  const { net } = addGloveSession(home, token);
  for (const f of ['session.json', 'status.json', 'exit.ndjson']) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(net, f));
  writeFileSync(join(net, 'flows.ndjson'), lines.map((l) => l + '\n').join(''));
}

/** A Layman process: start, read what is there, return what it shows. */
function run(history: MemHistory, token = TOKEN): { obs: NetObs; snap: NetSnapshot } {
  const obs = new NetObs({ getGloveHome: () => home, history });
  obs.poll(NOW);
  return { obs, snap: obs.store.snapshot(token)! };
}

const totals = (t: NetTotals) => ({ ...t, openFlows: 0, gateLost: 0, broken: 0 });
const dests = (ds: DestinationAggregate[]) => Object.fromEntries(ds.map((d) => [d.key, [d.bytesUp, d.bytesDown, d.flows, d.blocked]] as const).sort((a, b) => a[0].localeCompare(b[0])));
/** One uninterrupted read of these lines, no history. */
const once = (lines: string[]) => {
  writeSession(lines);
  return run(new MemHistory(false)).snap;
};
/** The time axis as one read shows it: every hour, and every run. */
const axis = (obs: NetObs, token = TOKEN) => [obs.store.hourly(token), obs.store.gateRuns(token)];

describe('kept network history', () => {
  it('shows the same totals after a restart over the same files', () => {
    const h = new MemHistory();
    writeSession(LINES);
    const first = run(h);
    first.obs.persist();
    const again = run(h).snap;
    expect(totals(again.totals)).toEqual(totals(first.snap.totals));
    expect(dests(again.destinations)).toEqual(dests(first.snap.destinations));
    // …and after a second restart.
    run(h).obs.persist();
    expect(totals(run(h).snap.totals)).toEqual(totals(first.snap.totals));
  });

  it('adds what arrived while Layman was down, once', () => {
    const h = new MemHistory();
    const half = Math.floor(LINES.length / 2);
    writeSession(LINES.slice(0, half));
    run(h).obs.persist();
    writeSession(LINES); // glove kept writing
    const after = run(h).snap;
    const ref = once(LINES);
    expect(totals(after.totals)).toEqual(totals(ref.totals));
    expect(dests(after.destinations)).toEqual(dests(ref.destinations));
  });

  it('keeps totals from files glove has since deleted', () => {
    const h = new MemHistory();
    writeSession(LINES);
    const full = run(h);
    full.obs.persist();
    // Rotation expired the older records: only the second half is on disk.
    writeSession(LINES.slice(Math.floor(LINES.length / 2)));
    const after = run(h).snap;
    expect(totals(after.totals)).toEqual(totals(full.snap.totals));
    expect(dests(after.destinations)).toEqual(dests(full.snap.destinations));
  });

  it('lists a session whose files are gone, history only, with its totals and destinations', () => {
    const h = new MemHistory();
    writeSession(LINES);
    const full = run(h);
    full.obs.persist();
    rmSync(join(home, 'observe', TOKEN), { recursive: true, force: true });
    const { obs, snap } = run(h);
    const summary = obs.sessions().find((s) => s.token === TOKEN)!;
    expect([summary.historyOnly, summary.live, summary.bytesDown]).toEqual([true, false, full.snap.totals.bytesDown]);
    expect(snap.historyOnly).toBe(true);
    expect(snap.flows).toEqual([]);
    expect(totals(snap.totals)).toEqual(totals(full.snap.totals));
    expect(dests(snap.destinations)).toEqual(dests(full.snap.destinations));
    expect(snap.destinations.find((d) => d.key === '169.254.169.254:80')?.state).toBe('guard');
    expect(snap.rules.control.state).toBe('disabled');
    // Not re-written while nothing changes.
    const saves = h.saves;
    obs.persist();
    expect(h.rows.get(TOKEN)).toEqual(full.obs.store.rollup(TOKEN));
    expect(h.saves).toBe(saves + 1);
  });

  it('picks a history-only session back up when its files return', () => {
    const h = new MemHistory();
    const half = Math.floor(LINES.length / 2);
    writeSession(LINES.slice(0, half));
    run(h).obs.persist();
    rmSync(join(home, 'observe', TOKEN), { recursive: true, force: true });
    const { obs } = run(h);
    expect(obs.store.isHistoryOnly(TOKEN)).toBe(true);
    writeSession(LINES);
    obs.poll(NOW);
    expect(obs.store.isHistoryOnly(TOKEN)).toBe(false);
    expect(totals(obs.store.snapshot(TOKEN)!.totals)).toEqual(totals(once(LINES).totals));
  });

  it('writes the same rollup twice without changing it', () => {
    const h = new MemHistory();
    writeSession(LINES);
    const { obs } = run(h);
    obs.persist();
    const one = structuredClone(h.rows.get(TOKEN));
    obs.persist();
    expect(h.rows.get(TOKEN)).toEqual(one);
    expect(one?.watermark).toBe(Date.parse(JSON.parse(LINES[LINES.length - 1]).t));
  });

  it('counts the hours of what it re-reads when the kept row predates them', () => {
    const h = new MemHistory();
    writeSession(LINES);
    const first = run(h);
    first.obs.persist();
    // As a row kept before migration 6 loads: totals and destinations, no time axis.
    const row = h.rows.get(TOKEN)!;
    delete row.hours;
    delete row.runs;
    const { obs } = run(h);
    expect(axis(obs)).toEqual(axis(first.obs));
    expect(obs.store.hourly(TOKEN).length).toBeGreaterThan(0);
  });

  it('writes nothing while session recording is off', () => {
    const h = new MemHistory(false);
    writeSession(LINES);
    run(h).obs.persist();
    expect(h.saves).toBe(0);
  });

  it('holds at every point: persist after i records, restart with the first j ≤ i expired and the rest written', () => {
    writeSession(LINES);
    const refObs = run(new MemHistory(false)).obs;
    const ref = refObs.store.snapshot(TOKEN)!;
    const want = [totals(ref.totals), dests(ref.destinations), axis(refObs)];
    const bad: string[] = [];
    for (let i = 1; i <= LINES.length; i += 3) {
      for (const j of [0, Math.floor(i / 2), i]) {
        const h = new MemHistory();
        writeSession(LINES.slice(0, i));
        run(h).obs.persist();
        writeSession(LINES.slice(j));
        const { obs, snap: got } = run(h);
        if (JSON.stringify([totals(got.totals), dests(got.destinations), axis(obs)]) !== JSON.stringify(want)) {
          if (process.env.DIAG && bad.length < 3) console.log(i, j, JSON.stringify(totals(got.totals)), JSON.stringify(want[0]), JSON.stringify(Object.entries(dests(got.destinations)).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((want[1] as Record<string, unknown>)[k]))), JSON.stringify(Object.keys(want[1] as object).filter((k) => !(k in dests(got.destinations)))));
          bad.push(`${i}/${j}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it.each(['@fixture', 'gate-lost', 'terminate', 'default-block', 'direct', 'pooled'])('holds when Layman restarts after every record of %s', (name) => {
    const dir = name === '@fixture' ? FIXTURE : join(HERE, '__scenarios__', name);
    const lines = readFileSync(join(dir, 'flows.ndjson'), 'utf8').split('\n').filter(Boolean);
    // The v2 records name their session; the store keys it by the glove v3 id it was discovered under.
    const token = TEST_ID;
    const h = new MemHistory();
    for (let i = 1; i <= lines.length; i++) {
      writeSession(lines.slice(0, i), dir, token);
      run(h, token).obs.persist();
    }
    const { obs: afterObs, snap: after } = run(h, token);
    writeSession(lines, dir, token);
    const { obs: refObs, snap: ref } = run(new MemHistory(false), token);
    expect(totals(after.totals)).toEqual(totals(ref.totals));
    expect(dests(after.destinations)).toEqual(dests(ref.destinations));
    expect(axis(afterObs, token)).toEqual(axis(refObs, token));
  });

  // llm-auth's hop is left out of the session totals (counted at the provider leg) but keeps
  // its own destination: both must survive a restart at every record. Hand-made records until
  // glove's llm-auth scenario exists (`testing/rounds.ts`).
  it('holds for llm-auth\'s hops, the relays and downloads when Layman restarts after every record', () => {
    const lines = roundsRecords().map((r) => JSON.stringify({ ...r, session: TEST_ID, env: TEST_ID }));
    const write = (ls: string[]) => {
      const { net } = addGloveSession(home, TEST_ID);
      writeFileSync(join(net, 'session.json'), JSON.stringify({ ...roundsSessionFile(), env: TEST_ID, session: TEST_ID }));
      writeFileSync(join(net, 'flows.ndjson'), ls.map((l) => l + '\n').join(''));
    };
    const h = new MemHistory();
    for (let i = 1; i <= lines.length; i++) {
      write(lines.slice(0, i));
      run(h).obs.persist();
    }
    const { obs: afterObs, snap: after } = run(h);
    write(lines);
    const { obs: refObs, snap: ref } = run(new MemHistory(false));
    expect(totals(after.totals)).toEqual(totals(ref.totals));
    expect(dests(after.destinations)).toEqual(dests(ref.destinations));
    expect(axis(afterObs)).toEqual(axis(refObs));
    // …and with the older half expired from the files.
    write(lines.slice(Math.floor(lines.length / 2)));
    const { obs: expiredObs, snap: expired } = run(h);
    expect(totals(expired.totals)).toEqual(totals(ref.totals));
    expect(dests(expired.destinations)).toEqual(dests(ref.destinations));
    expect(axis(expiredObs)).toEqual(axis(refObs));
    // …and with every record gone: a kept hop is still a hop (a local link, off the Map).
    const hops = ref.destinations.filter((d) => d.flags.hop).map((d) => d.key);
    expect(hops.length).toBeGreaterThan(0);
    write([]);
    const gone = run(h).snap.destinations.filter((d) => hops.includes(d.key));
    expect(gone.map((d) => [d.key, d.flags.hop])).toEqual(hops.map((k) => [k, true]));
  });

  it('never counts a refined destination twice', () => {
    const scen = join(HERE, '__scenarios__', 'sni-refined');
    const lines = readFileSync(join(scen, 'flows.ndjson'), 'utf8').split('\n').filter(Boolean);
    const token = TEST_ID;
    const h = new MemHistory();
    // Persist between every record: the worst case for a refinement landing across a write.
    for (let i = 1; i <= lines.length; i++) {
      writeSession(lines.slice(0, i), scen, token);
      run(h, token).obs.persist();
    }
    const after = run(h, token).snap;
    writeSession(lines, scen, token);
    const ref = run(new MemHistory(false), token).snap;
    expect(totals(after.totals)).toEqual(totals(ref.totals));
    expect(dests(after.destinations)).toEqual(dests(ref.destinations));
  });
});

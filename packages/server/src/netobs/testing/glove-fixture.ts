/**
 * glove generates `__fixtures__/` in real time, so its clock, flow ids and counters change with every
 * copy. Tests write times as they were in the 2026-09-23 copy (`fixtureAt('2026-09-23T14:14:43.300Z')`)
 * and this shifts them to where the current copy's first flow opened; anything that must line up with
 * a particular flow reads it from the file (`fixtureFlowOpen`), so a refresh changes no test.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

type FixtureRecord = { type?: string; phase?: string; id?: string; t_open?: string; dest?: { host?: string | null } };

const RECORDS = readFileSync(join(FIXTURE, 'flows.ndjson'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as FixtureRecord);
const OPENS = RECORDS.filter((r) => r.type === 'flow' && r.phase === 'open' && r.t_open)
  .sort((a, b) => Date.parse(a.t_open!) - Date.parse(b.t_open!));

/** The earliest flow `t_open` in the 2026-09-23 copy, which the tests' times are written against. */
const WRITTEN_AGAINST = Date.parse('2026-09-23T14:14:43.396Z');
const SHIFT = Date.parse(OPENS[0].t_open!) - WRITTEN_AGAINST;

export const fixtureAt = (iso: string): number => Date.parse(iso) + SHIFT;

/** The `n`th (0-based) flow to `host` in the current copy: its id and when it opened. */
export function fixtureFlowOpen(host: string, n = 0): { id: string; t: number } {
  const r = OPENS.filter((o) => o.dest?.host === host)[n];
  if (!r) throw new Error(`no flow ${n} to ${host} in __fixtures__/flows.ndjson`);
  return { id: r.id!, t: Date.parse(r.t_open!) };
}

/** How many flows the copy holds. */
export const FIXTURE_FLOWS = OPENS.length;

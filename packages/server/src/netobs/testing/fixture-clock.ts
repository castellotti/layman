/**
 * glove generates `__fixtures__/` in real time, so its clock and flow ids change with every copy.
 * Tests write times as they were in the 2026-09-23 copy (`fixtureAt('2026-09-23T14:14:43.300Z')`)
 * and this shifts them to where the current copy's first flow opened, so a refresh changes no test.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

/** The first flow's `t_open` in the 2026-09-23 copy, which the tests' times are written against. */
const WRITTEN_AGAINST = Date.parse('2026-09-23T14:14:43.396Z');

const firstLine = readFileSync(join(FIXTURE, 'flows.ndjson'), 'utf8').split('\n', 1)[0];
const SHIFT = Date.parse((JSON.parse(firstLine) as { t_open: string }).t_open) - WRITTEN_AGAINST;

export const fixtureAt = (iso: string): number => Date.parse(iso) + SHIFT;

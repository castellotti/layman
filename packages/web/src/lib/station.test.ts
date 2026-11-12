import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { commandKind, eventStation, isPushedMemory, shellCommands, shellStation, stationOf } from './station';

const here = dirname(fileURLToPath(import.meta.url));
const serverEvents = join(here, '../../../server/src/events');
/** The server's fixture: one set of cases holds both copies to the same answers. */
const fixture = JSON.parse(readFileSync(join(serverEvents, 'station-fixture.json'), 'utf8'));

describe('station.ts', () => {
  it('is byte-identical to the server copy', () => {
    // The rule lives twice because there is no shared package; the copies may never differ.
    expect(readFileSync(join(here, 'station.ts'), 'utf8')).toBe(readFileSync(join(serverEvents, 'station.ts'), 'utf8'));
  });

  it('agrees with every tool case in the shared fixture', () => {
    for (const c of fixture.tools) expect([c.harness, c.tool, stationOf(c.tool, c.input)]).toEqual([c.harness, c.tool, c.station]);
  });

  it('agrees with every shell line in the shared fixture', () => {
    for (const c of fixture.lines) expect([c.line, shellStation(c.line)]).toEqual([c.line, c.station]);
  });

  it('agrees with the census', () => {
    for (const kind of ['files', 'neutral', 'network', 'shell'] as const) {
      for (const line of fixture.census[kind] as string[]) expect([line, commandKind(shellCommands(line)[0]!)]).toEqual([line, kind]);
    }
  });

  it('agrees with the memory cases', () => {
    const { setup, tools, noSetup } = fixture.memory;
    for (const c of tools) expect([c.tool, stationOf(c.tool, c.input, setup)]).toEqual([c.tool, c.station]);
    for (const c of noSetup) expect([c.tool, stationOf(c.tool, c.input)]).toEqual([c.tool, c.station]);
  });

  it('agrees with the event cases', () => {
    for (const c of fixture.events) {
      expect([c.type, eventStation(c.type, c.data) ?? null, isPushedMemory(c.type)]).toEqual([c.type, c.station, c.pushed === true]);
    }
  });
});

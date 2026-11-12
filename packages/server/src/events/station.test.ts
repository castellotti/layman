import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { commandKind, eventStation, isPushedMemory, shellCommands, shellStation, stationOf, STATION_IDS } from './station.js';

/** The fixture both packages' suites read; see the header of station.ts. */
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'station-fixture.json'), 'utf8'));

describe('stationOf (shared fixture)', () => {
  for (const c of fixture.tools) {
    it(`${c.harness} ${c.tool} → ${c.station}`, () => {
      expect(stationOf(c.tool, c.input)).toBe(c.station);
    });
  }
  it('names only known stations', () => {
    for (const c of fixture.tools) expect(STATION_IDS).toContain(c.station);
  });
});

describe('shellStation (shared fixture)', () => {
  for (const c of fixture.lines) {
    it(`${JSON.stringify(c.line).slice(0, 70)} → ${c.station}${c.why ? ` (${c.why})` : ''}`, () => {
      expect(shellStation(c.line)).toBe(c.station);
    });
  }
});

describe('the census of real command heads (shared fixture)', () => {
  for (const kind of ['files', 'neutral', 'network', 'shell'] as const) {
    for (const line of fixture.census[kind] as string[]) {
      it(`${line} is ${kind}`, () => {
        const [first] = shellCommands(line);
        expect(first).toBeDefined();
        expect(commandKind(first!)).toBe(kind);
      });
    }
  }
});

describe('shellCommands', () => {
  it('drops redirection targets and descriptors', () => {
    expect(shellCommands('sort a > b 2>&1')).toEqual([['sort', 'a']]);
    expect(shellCommands('cmd &>/dev/null')).toEqual([['cmd']]);
  });

  it('lists commands inside $(…) alongside the outer one', () => {
    expect(shellCommands('echo "$(date)"')).toEqual([['date'], ['echo', '$(date)']]);
  });

  it('skips a heredoc body and keeps what follows it', () => {
    expect(shellCommands("cat <<'X'\nrm -rf /\nX\nls")).toEqual([['cat'], ['ls']]);
  });

  it('reads a backtick as an escape in PowerShell', () => {
    expect(shellCommands('Write-Host "a`"b"', true)).toEqual([['Write-Host', 'a"b']]);
  });

  it('survives unterminated quotes and substitutions', () => {
    expect(() => shellCommands('echo "unterminated $(curl x')).not.toThrow();
    expect(shellStation('echo "unterminated $(curl x')).toBe('network');
    expect(() => shellCommands("echo 'open")).not.toThrow();
  });
});

describe('memory (shared fixture)', () => {
  for (const c of fixture.memory.tools) {
    it(`${c.tool} → ${c.station}${c.why ? ` (${c.why})` : ''}`, () => {
      expect(stationOf(c.tool, c.input, fixture.memory.setup)).toBe(c.station);
    });
  }
  for (const c of fixture.memory.loose) {
    it(`loosely written setup: ${c.tool} → ${c.station}${c.why ? ` (${c.why})` : ''}`, () => {
      expect(stationOf(c.tool, c.input, fixture.memory.setupLoose)).toBe(c.station);
    });
  }
  for (const c of fixture.memory.noSetup) {
    it(`without setup: ${c.tool} → ${c.station}`, () => {
      expect(stationOf(c.tool, c.input)).toBe(c.station);
    });
  }
});

describe('eventStation (shared fixture)', () => {
  for (const c of fixture.events) {
    it(`${c.type} → ${c.station}`, () => {
      expect(eventStation(c.type, c.data) ?? null).toBe(c.station);
      expect(isPushedMemory(c.type)).toBe(c.pushed === true);
    });
  }
});

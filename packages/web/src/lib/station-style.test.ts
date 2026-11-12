import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { STATION_IDS } from './station';
import { rowStation, stationCounts, STATION_STYLE } from './station-style';

describe('station styles', () => {
  it('styles every station with a theme token', () => {
    for (const s of STATION_IDS) expect(STATION_STYLE[s].color).toMatch(/^var\(--[a-z-]+\)$/);
  });

  it('styles every station with a token the print palette redefines, so it prints dark on white', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.css'), 'utf8');
    const print = css.slice(css.indexOf('@media print'));
    for (const s of STATION_IDS) {
      const token = /var\((--[a-z-]+)\)/.exec(STATION_STYLE[s].color)![1];
      expect([s, print.includes(`${token}:`)]).toEqual([s, true]);
    }
  });

  it('files a reasoning row under Model', () => {
    expect(rowStation({ type: 'agent_thinking', data: {} } as never)).toBe('model');
  });

  it('counts per station in legend order, leaving out empty stations and stationless events', () => {
    const events = [
      { type: 'tool_call_completed', data: { toolName: 'Read', toolInput: { file_path: '/a' } } },
      { type: 'user_prompt', data: {} },
      { type: 'tool_call_completed', data: { toolName: 'Grep', toolInput: {} } },
      { type: 'session_start', data: {} },
    ] as never[];
    expect(stationCounts(events)).toEqual([{ station: 'you', count: 1 }, { station: 'files', count: 2 }]);
  });

  it('uses the setup for Memory', () => {
    const e = { type: 'tool_call_completed', data: { toolName: 'mcp__recall__get', toolInput: {} } } as never;
    expect(rowStation(e)).toBe('network');
    expect(rowStation(e, { memoryPaths: [], memoryServers: ['recall'] })).toBe('memory');
  });
});

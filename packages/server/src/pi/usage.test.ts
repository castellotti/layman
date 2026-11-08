import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PiUsageReader } from './usage.js';
import type { WatchRoot } from '../monitor/sources.js';

const TOKEN = 'pi-mx5-abc123';
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number) =>
  `{"input":${input},"output":${output},"cacheRead":${cacheRead},"cacheWrite":${cacheWrite},"reasoning":${reasoning},"totalTokens":${input + output + cacheRead + cacheWrite}}`;
const call = (id: string, at: string, u: string) =>
  `{"type":"message","id":"${id}","parentId":null,"timestamp":"${at}","message":{"role":"assistant","content":[],"usage":${u},"stopReason":"stop"}}`;
const HEADER = '{"type":"session","version":3,"id":"s","timestamp":"2026-11-06T14:00:00.000Z","cwd":"/work"}';
const A = call('a1', '2026-11-06T14:00:10.000Z', usage(1000, 100, 0, 0, 40));
const B = call('a2', '2026-11-06T14:05:00.000Z', usage(200, 50, 1000, 10, 20));
const C = '{"type":"compaction","id":"k1","parentId":"a2","timestamp":"2026-11-06T15:00:00.000Z","summary":"s","usage":' + usage(5000, 700, 0, 0, 300) + '}';
const at = (iso: string) => Date.parse(iso);

describe('PiUsageReader', () => {
  let root: string;
  let file: string;
  let roots: WatchRoot[];
  let reader: PiUsageReader;

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'layman-pi-usage-'));
    root = join(tmp, 'transcripts');
    mkdirSync(join(root, '--work--'), { recursive: true });
    file = join(root, '--work--', '2026-11-06T14-00-00-000Z_aaaaaaaa-0000-4000-8000-000000000000.jsonl');
    writeFileSync(file, [HEADER, A, B].join('\n') + '\n');
    roots = [
      { path: root, agentType: 'pi', label: TOKEN },
      { path: join(tmp, 'vibe'), agentType: 'mistral-vibe', label: 'vibe-000000' },
    ];
    reader = new PiUsageReader(() => roots);
  });
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }));

  it('sums every kind over All records, and is null for a session with no pi transcripts', () => {
    expect(reader.sum(TOKEN, null)).toEqual({ tokens: { input: 1200, output: 150, cacheRead: 1000, cacheWrite: 10, reasoning: 60 }, calls: 2,
      reported: ['cacheRead', 'cacheWrite', 'reasoning'],
    });
    expect(reader.sum('vibe-000000', null)).toBeNull();
    expect(reader.sum('other-000000', null)).toBeNull();
  });

  it('reports only the optional kinds some call of the session sent (0 everywhere: unknown)', () => {
    writeFileSync(file, [HEADER, A, call('a2', '2026-11-06T14:05:00.000Z', usage(200, 50, 1000, 0, 0))].join('\n') + '\n');
    expect(reader.sum(TOKEN, null)!.reported).toEqual(['cacheRead', 'reasoning']);
    // a range without the cache read still says it was reported
    expect(reader.sum(TOKEN, { from: at('2026-11-06T14:00:00.000Z'), to: at('2026-11-06T14:01:00.000Z') })!.reported).toEqual(['cacheRead', 'reasoning']);
  });

  it('counts the calls that finished in the range, an open range running until now', () => {
    expect(reader.sum(TOKEN, { from: at('2026-11-06T14:01:00.000Z'), to: at('2026-11-06T14:10:00.000Z') })!.tokens.input).toBe(200);
    expect(reader.sum(TOKEN, { from: at('2026-11-06T14:00:10.000Z'), to: at('2026-11-06T14:00:10.000Z') })!.calls).toBe(1);
    const now = at('2026-11-06T14:02:00.000Z');
    expect(reader.sum(TOKEN, { from: at('2026-11-06T14:00:00.000Z'), to: null }, now)!.calls).toBe(1);
    expect(reader.sum(TOKEN, { from: at('2026-11-06T16:00:00.000Z'), to: null }, at('2026-11-06T17:00:00.000Z'))).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, calls: 0,
      reported: ['cacheRead', 'cacheWrite', 'reasoning'], // the session's, whatever the range
    });
  });

  it('reads only what was appended, and a line still being written on the next read', () => {
    reader.sum(TOKEN, null);
    // Half a line: not counted yet, and not lost.
    appendFileSync(file, C.slice(0, 40));
    expect(reader.sum(TOKEN, null)!.calls).toBe(2);
    appendFileSync(file, C.slice(40) + '\n');
    const all = reader.sum(TOKEN, null)!;
    expect(all.calls).toBe(3);
    expect(all.tokens.reasoning).toBe(360);
  });

  it('reads a replaced or truncated file again from the start', () => {
    reader.sum(TOKEN, null);
    const other = file + '.new';
    writeFileSync(other, [HEADER, A].join('\n') + '\n');
    renameSync(other, file);
    expect(reader.sum(TOKEN, null)!.calls).toBe(1);
    writeFileSync(file, HEADER + '\n');
    expect(reader.sum(TOKEN, null)!.calls).toBe(0);
    // A deleted file no longer counts.
    writeFileSync(file, [HEADER, A].join('\n') + '\n');
    expect(reader.sum(TOKEN, null)!.calls).toBe(1);
    rmSync(file);
    expect(reader.sum(TOKEN, null)!.calls).toBe(0);
  });
});

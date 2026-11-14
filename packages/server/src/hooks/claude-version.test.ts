import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { atLeast, detectClaudeCodeVersion, parseVersion, versionInTail, UNKNOWN_HOOK_SAFE } from './claude-version.js';

describe('claude-version', () => {
  it('compares versions numerically, not as strings', () => {
    expect(atLeast([2, 1, 322], UNKNOWN_HOOK_SAFE)).toBe(true);
    expect(atLeast([2, 1, 101], UNKNOWN_HOOK_SAFE)).toBe(true);
    expect(atLeast([2, 1, 99], UNKNOWN_HOOK_SAFE)).toBe(false);
    expect(atLeast([2, 0, 500], UNKNOWN_HOOK_SAFE)).toBe(false);
    expect(atLeast(null, UNKNOWN_HOOK_SAFE)).toBe(false);
    expect(parseVersion('2.1.322 (Claude Code)')).toEqual([2, 1, 322]);
    expect(parseVersion('junk')).toBeNull();
  });
  it('takes the greatest version in a tail', () => {
    expect(versionInTail('{"version":"2.1.99"}\n{"version":"2.1.322"}\n{"version":"2.1.100"}')).toEqual([2, 1, 322]);
    expect(versionInTail('{"a":1}')).toBeNull();
  });
  it('reads the newest transcripts, and is null with none', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-'));
    expect(detectClaudeCodeVersion(join(root, 'missing'))).toBeNull();
    expect(detectClaudeCodeVersion(root)).toBeNull();
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 's.jsonl'), '{"type":"user"}\n{"type":"assistant","version":"2.1.150"}\n');
    expect(detectClaudeCodeVersion(root)).toEqual([2, 1, 150]);
  });
});

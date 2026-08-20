import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findOrphanedProjectHooks, repairOrphanedProjectHooks } from './installer.js';

let dir: string;

function writeProjectSettings(fileName: string, settings: unknown): string {
  const claudeDir = join(dir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const path = join(claudeDir, fileName);
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
  return path;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

const laymanHook = (event: string, origin = 'http://localhost:8880') => ({
  type: 'http', url: `${origin}/hooks/${event}`, timeout: 10,
});

const foreignHook = { type: 'http', url: 'http://example.com/webhook', timeout: 5 };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'layman-installer-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findOrphanedProjectHooks', () => {
  it('finds untagged Layman hooks by URL shape', () => {
    // Reproduces the real-world file: no _layman tag, because claude-code
    // strips unknown keys when it rewrites settings.
    writeProjectSettings('settings.local.json', {
      permissions: { allow: ['Bash'] },
      hooks: { UserPromptSubmit: [{ matcher: '', hooks: [laymanHook('UserPromptSubmit')] }] },
    });

    const reports = findOrphanedProjectHooks(dir);

    expect(reports).toHaveLength(1);
    expect(reports[0].events).toEqual(['UserPromptSubmit']);
    expect(reports[0].hookCount).toBe(1);
  });

  it('reports duplicated events separately', () => {
    writeProjectSettings('settings.local.json', {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [laymanHook('UserPromptSubmit')] },
          { matcher: '', hooks: [laymanHook('UserPromptSubmit')] },
        ],
        Stop: [{ matcher: '', hooks: [laymanHook('Stop')] }],
      },
    });

    const [report] = findOrphanedProjectHooks(dir);

    expect(report.hookCount).toBe(3);
    expect(report.duplicatedEvents).toEqual(['UserPromptSubmit']);
  });

  it('recognises Layman hooks at any host and port', () => {
    writeProjectSettings('settings.local.json', {
      hooks: {
        Stop: [{ matcher: '', hooks: [laymanHook('Stop', 'http://nyx.local:9999')] }],
        SessionStart: [{ matcher: '', hooks: [laymanHook('SessionStart', 'http://host.docker.internal:8880')] }],
      },
    });

    expect(findOrphanedProjectHooks(dir)[0].hookCount).toBe(2);
  });

  it('ignores foreign hooks entirely', () => {
    writeProjectSettings('settings.local.json', {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [foreignHook] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: './script.sh' }] }],
      },
    });

    expect(findOrphanedProjectHooks(dir)).toEqual([]);
  });

  it('does not mistake a lookalike URL for a Layman hook', () => {
    writeProjectSettings('settings.local.json', {
      hooks: {
        // Right prefix, but not an event name Layman registers.
        Stop: [{ matcher: '', hooks: [{ type: 'http', url: 'http://localhost:8880/hooks/SomethingElse', timeout: 5 }] }],
        // Right event name, but nested deeper than Layman's flat /hooks/{Event}.
        PreToolUse: [{ matcher: '', hooks: [{ type: 'http', url: 'http://localhost:8880/hooks/cline/PreToolUse', timeout: 5 }] }],
      },
    });

    expect(findOrphanedProjectHooks(dir)).toEqual([]);
  });

  it('returns nothing when there is no settings file or no hooks', () => {
    expect(findOrphanedProjectHooks(dir)).toEqual([]);

    writeProjectSettings('settings.local.json', { permissions: { allow: [] } });
    expect(findOrphanedProjectHooks(dir)).toEqual([]);
  });

  it('tolerates a malformed settings file rather than throwing', () => {
    const claudeDir = join(dir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), '{ not json', 'utf-8');

    expect(() => findOrphanedProjectHooks(dir)).not.toThrow();
  });

  it('tolerates valid JSON with a malformed hooks field rather than throwing', () => {
    // Valid JSON, but `hooks` isn't the Record<string, HookMatcher[]> shape
    // TypeScript assumes — a real-world file could have this from manual editing
    // or a tool writing a different schema.
    writeProjectSettings('settings.local.json', { hooks: 'oops' });
    expect(() => findOrphanedProjectHooks(dir)).not.toThrow();
    expect(findOrphanedProjectHooks(dir)).toEqual([]);

    writeProjectSettings('settings.local.json', { hooks: ['oops'] });
    expect(() => findOrphanedProjectHooks(dir)).not.toThrow();

    writeProjectSettings('settings.local.json', { hooks: { Stop: 'oops' } });
    expect(() => findOrphanedProjectHooks(dir)).not.toThrow();

    writeProjectSettings('settings.local.json', { hooks: { Stop: [{ matcher: '', hooks: 'oops' }] } });
    expect(() => findOrphanedProjectHooks(dir)).not.toThrow();
  });

  it('recognises a Layman hook regardless of its type field', () => {
    // claude-code also writes type: 'command' hooks, and a settings file isn't
    // guaranteed to match Layman's own HookEntry shape exactly — matching must
    // key off the URL, not the type, or these entries survive dedup/repair.
    writeProjectSettings('settings.local.json', {
      hooks: {
        Stop: [{ matcher: '', hooks: [{ type: 'command', url: 'http://localhost:8880/hooks/Stop', timeout: 5 }] }],
      },
    });

    expect(findOrphanedProjectHooks(dir)[0].hookCount).toBe(1);
  });

  it('checks both settings.json and settings.local.json', () => {
    writeProjectSettings('settings.json', {
      hooks: { Stop: [{ matcher: '', hooks: [laymanHook('Stop')] }] },
    });
    writeProjectSettings('settings.local.json', {
      hooks: { Stop: [{ matcher: '', hooks: [laymanHook('Stop')] }] },
    });

    expect(findOrphanedProjectHooks(dir)).toHaveLength(2);
  });
});

describe('repairOrphanedProjectHooks', () => {
  it('removes Layman hooks and preserves every other key', () => {
    const path = writeProjectSettings('settings.local.json', {
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      env: { FOO: 'bar' },
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [laymanHook('UserPromptSubmit')] },
          { matcher: '', hooks: [laymanHook('UserPromptSubmit')] },
        ],
      },
    });

    const removed = repairOrphanedProjectHooks(dir);
    const after = readJson(path);

    expect(removed[0].hookCount).toBe(2);
    expect(after.permissions).toEqual({ allow: ['Bash(ls:*)'], deny: [] });
    expect(after.env).toEqual({ FOO: 'bar' });
    expect(after.hooks).toBeUndefined();
  });

  it('preserves a foreign hook sharing a matcher with a Layman hook', () => {
    // The old whole-matcher filter would have deleted the foreign hook too.
    const path = writeProjectSettings('settings.local.json', {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [laymanHook('PreToolUse'), foreignHook] }],
      },
    });

    repairOrphanedProjectHooks(dir);
    const after = readJson(path) as { hooks: Record<string, Array<{ hooks: unknown[] }>> };

    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0].hooks).toEqual([foreignHook]);
  });

  it('keeps other events untouched', () => {
    const path = writeProjectSettings('settings.local.json', {
      hooks: {
        Stop: [{ matcher: '', hooks: [laymanHook('Stop')] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }],
      },
    });

    repairOrphanedProjectHooks(dir);
    const after = readJson(path) as { hooks: Record<string, unknown> };

    expect(after.hooks.Stop).toBeUndefined();
    expect(after.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] },
    ]);
  });

  it('never deletes the settings file, even when nothing is left', () => {
    const path = writeProjectSettings('settings.local.json', {
      hooks: { Stop: [{ matcher: '', hooks: [laymanHook('Stop')] }] },
    });

    repairOrphanedProjectHooks(dir);

    expect(existsSync(path)).toBe(true);
    expect(readJson(path)).toEqual({});
  });

  it('is idempotent', () => {
    const path = writeProjectSettings('settings.local.json', {
      permissions: { allow: ['Bash'] },
      hooks: { Stop: [{ matcher: '', hooks: [laymanHook('Stop')] }] },
    });

    repairOrphanedProjectHooks(dir);
    const first = readFileSync(path, 'utf-8');

    expect(repairOrphanedProjectHooks(dir)).toEqual([]);
    expect(readFileSync(path, 'utf-8')).toBe(first);
  });

  it('leaves a project with no Layman hooks byte-identical', () => {
    const path = writeProjectSettings('settings.local.json', {
      hooks: { PreToolUse: [{ matcher: '', hooks: [foreignHook] }] },
    });
    const before = readFileSync(path, 'utf-8');

    repairOrphanedProjectHooks(dir);

    expect(readFileSync(path, 'utf-8')).toBe(before);
  });
});
